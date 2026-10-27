import asyncio
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import app


def config(name="Haven", kind="specialist", tools=None):
    return {
        "name": name,
        "role": "Support specialist",
        "goal": "Answer from authorized workspace sources",
        "description": "Handles support questions",
        "instructions": "Be accurate and concise.",
        "kind": kind,
        "model": "gemini-3.8-flash",
        "effort": "medium",
        "tools": tools or [],
        "max_iter": 4,
        "max_execution_time": 60,
    }


def test_agent_names_are_valid_and_stable():
    assert app._agent_name("Team Lead 2.0", 0) == app._agent_name("Team Lead 2.0", 0)
    assert app._agent_name("Team Lead 2.0", 0).startswith("team_lead_2_0_")
    assert app._agent_name("23 Sales", 2).startswith("agent_23_sales_")


def test_dynamic_adk_agent_preserves_tools_and_specialists():
    spec = {
        "read_file": {
            "name": "read_file",
            "description": "Read an authorized workspace file",
            "inputSchema": {
                "type": "object",
                "properties": {"item_id": {"type": "string"}},
                "required": ["item_id"],
            },
        }
    }
    root, names = app._build_agent(
        config("Team Lead", "coordinator", ["read_file"]),
        spec,
        "http://worker:3001/tool",
        "token",
        "run-id",
        index=0,
        specialists=[config("Haven")],
    )
    assert len(root.sub_agents) == 1
    assert names[root.sub_agents[0].name] == "Haven"
    assert [tool.name for tool in root.tools] == ["read_file"]
    declaration = root.tools[0]._get_declaration()
    assert declaration.parameters_json_schema["required"] == ["item_id"]


def test_callback_tool_uses_authenticated_workspace_bridge():
    tool = app.CallbackTool(
        {"name": "read_file", "description": "Read a file", "inputSchema": {"type": "object"}},
        "http://worker:3001/tool",
        "secret-token",
        "run-id",
    )

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"content":"Policy: approved."}'

    with patch("urllib.request.urlopen", return_value=Response()) as opened:
        result = asyncio.run(tool.run_async(args={"item_id": "doc-1"}, tool_context=None))
    request = opened.call_args.args[0]
    body = json.loads(request.data)
    assert request.headers["Authorization"] == "Bearer secret-token"
    assert body == {
        "run_id": "run-id",
        "tool_use_id": body["tool_use_id"],
        "name": "read_file",
        "input": {"item_id": "doc-1"},
    }
    assert result == {"content": "Policy: approved.", "isError": False}


def test_image_attachments_stay_inside_private_storage():
    with tempfile.TemporaryDirectory() as root:
        image = Path(root) / "message-attachments" / "agent-images" / "user-id" / "clipboard.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"image-data")
        previous = os.environ.get("STORAGE_ROOT")
        os.environ["STORAGE_ROOT"] = root
        try:
            message = app._message(
                {
                    "prompt": "Describe this.",
                    "files": [
                        {
                            "path": "agent-images/user-id/clipboard.png",
                            "name": "clipboard.png",
                            "mime_type": "image/png",
                            "size": image.stat().st_size,
                        }
                    ],
                }
            )
        finally:
            if previous is None:
                os.environ.pop("STORAGE_ROOT", None)
            else:
                os.environ["STORAGE_ROOT"] = previous
        assert message.parts[0].text == "Describe this."
        assert message.parts[1].inline_data.mime_type == "image/png"


def test_image_attachments_cannot_escape_storage():
    with pytest.raises(ValueError, match="outside storage or missing"):
        app._message(
            {
                "prompt": "Describe this.",
                "files": [
                    {
                        "path": "agent-images/../secret.png",
                        "name": "secret.png",
                        "mime_type": "image/png",
                        "size": 10,
                    }
                ],
            }
        )


@pytest.mark.asyncio
async def test_adk_runner_streams_existing_ndjson_contract(monkeypatch):
    class Sessions:
        async def create_session(self, **_kwargs):
            return None

    class Event:
        def __init__(self, author, text, partial, final=False):
            self.author = author
            self.content = SimpleNamespace(parts=[SimpleNamespace(text=text)])
            self.partial = partial
            self.usage_metadata = None
            self._final = final

        def is_final_response(self):
            return self._final

    class FakeRunner:
        def __init__(self, *, agent, **_kwargs):
            self.agent = agent

        async def run_async(self, **_kwargs):
            yield Event(self.agent.name, "Hello", True)
            yield Event(self.agent.name, "!", False, True)

        async def close(self):
            return None

    monkeypatch.setattr(app, "InMemorySessionService", Sessions)
    monkeypatch.setattr(app, "Runner", FakeRunner)
    events = []
    payload = {
        "run_id": "00000000-0000-4000-8000-000000000001",
        "prompt": "hey",
        "agent": config(),
        "specialists": [],
        "tools": [],
        "callback_url": "http://worker:3001/tool",
        "callback_token": "token",
    }
    await app._run_adk_async(payload, events.append)
    assert {event["stage"] for event in events if event["type"] == "stage"} >= {
        "preparing",
        "contacting_provider",
        "generating",
        "finalizing",
    }
    assert [event["text"] for event in events if event["type"] == "delta"] == ["Hello"]
    assert next(event for event in events if event["type"] == "result")["text"] == "Hello!"


@pytest.mark.asyncio
async def test_adk_runner_retries_transient_provider_failure(monkeypatch):
    class Sessions:
        async def create_session(self, **_kwargs):
            return None

    class Event:
        author = "haven_00000000"
        content = SimpleNamespace(parts=[SimpleNamespace(text="Hey!")])
        partial = False
        usage_metadata = None

        def is_final_response(self):
            return True

    class RetryRunner:
        attempts = 0

        def __init__(self, **_kwargs):
            pass

        async def run_async(self, **_kwargs):
            RetryRunner.attempts += 1
            if RetryRunner.attempts == 1:
                raise RuntimeError("503 Service Unavailable: high demand")
            yield Event()

        async def close(self):
            return None

    monkeypatch.setattr(app, "InMemorySessionService", Sessions)
    monkeypatch.setattr(app, "Runner", RetryRunner)
    monkeypatch.setenv("ADK_PROVIDER_RETRY_BASE_SECONDS", "0")
    events = []
    await app._run_adk_async(
        {
            "run_id": "00000000-0000-4000-8000-000000000002",
            "prompt": "hey",
            "agent": config(),
            "specialists": [],
            "tools": [],
            "callback_url": "http://worker:3001/tool",
            "callback_token": "token",
        },
        events.append,
    )
    assert RetryRunner.attempts == 2
    assert any(event.get("stage") == "retrying_provider" for event in events)
    assert next(event for event in events if event["type"] == "result")["text"] == "Hey!"

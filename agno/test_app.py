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


def test_gemini_model_candidates_use_approved_flash_fallbacks():
    assert app._model_candidates("gemini-3.8-flash") == [
        "gemini-3.8-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
    ]
    assert app._model_candidates("gemini-3.6-flash") == ["gemini-3.6-flash", "gemini-3.5-flash-lite"]
    assert app._model_candidates("claude-sonnet-5-5") == ["claude-sonnet-5-5"]


def test_cerebras_model_uses_native_agno_provider(monkeypatch):
    monkeypatch.setenv("CEREBRAS_DIGITALROMANIAN", "csk-test-key")
    model = app._model("gpt-oss-120b")
    assert model.id == "gpt-oss-120b"
    assert model.provider == "Cerebras"
    assert os.environ["CEREBRAS_API_KEY"] == "csk-test-key"


def test_dynamic_agno_team_preserves_tools_and_specialists():
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
    root, names = app._build_runtime(
        config("Team Lead", "coordinator", ["read_file"]),
        spec,
        "http://worker:3001/tool",
        "token",
        "run-id",
        index=0,
        specialists=[config("Haven")],
    )
    assert len(root.members) == 1
    assert names[root.members[0].id] == "Haven"
    assert [tool.name for tool in root.tools] == ["read_file"]
    assert root.tools[0].parameters["required"] == ["item_id"]


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
        result = tool._call(item_id="doc-1")
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
            images = app._images(
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
        assert len(images) == 1
        assert images[0].mime_type == "image/png"
        assert images[0].content == b"image-data"


def test_image_attachments_cannot_escape_storage():
    with pytest.raises(ValueError, match="outside storage or missing"):
        app._images(
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
async def test_agno_runner_streams_existing_ndjson_contract(monkeypatch):
    class FakeRuntime:
        async def arun(self, **_kwargs):
            yield SimpleNamespace(event="ModelRequestCompleted", input_tokens=3, output_tokens=1)
            yield SimpleNamespace(event="RunContent", content="Hello!", agent_id="haven")
            yield SimpleNamespace(event="RunCompleted", content="Hello!", agent_id="haven")

    monkeypatch.setattr(app, "_build_runtime", lambda *_args, **_kwargs: (FakeRuntime(), {"haven": "Haven"}))
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
    await app._run_agno_async(payload, events.append)
    assert {event["stage"] for event in events if event["type"] == "stage"} >= {
        "preparing",
        "contacting_provider",
        "generating",
        "finalizing",
    }
    assert [event["text"] for event in events if event["type"] == "delta"] == ["Hello!"]
    assert next(event for event in events if event["type"] == "result")["text"] == "Hello!"
    assert next(event for event in events if event["type"] == "result")["usage"] == {
        "input_tokens": 3,
        "output_tokens": 1,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
    }


@pytest.mark.asyncio
async def test_agno_team_reports_members_but_only_streams_leader_answer(monkeypatch):
    class FakeTeam:
        async def arun(self, **_kwargs):
            yield SimpleNamespace(event="RunContent", content="member draft", agent_id="research")
            yield SimpleNamespace(event="TeamRunContent", content="Team answer", agent_id=None)
            yield SimpleNamespace(event="TeamRunCompleted", content="Team answer", agent_id=None)

    monkeypatch.setattr(
        app,
        "_build_runtime",
        lambda *_args, **_kwargs: (FakeTeam(), {"research": "Research Specialist"}),
    )
    events = []
    await app._run_agno_async(
        {
            "run_id": "00000000-0000-4000-8000-000000000003",
            "prompt": "research this",
            "agent": config("Team Lead", "coordinator"),
            "specialists": [config("Research Specialist")],
            "tools": [],
            "callback_url": "http://worker:3001/tool",
            "callback_token": "token",
        },
        events.append,
    )
    assert [event["agent"] for event in events if event["type"] == "team"] == ["Research Specialist"]
    assert [event["text"] for event in events if event["type"] == "delta"] == ["Team answer"]


@pytest.mark.asyncio
async def test_agno_runner_retries_transient_provider_failure(monkeypatch):
    class RetryRuntime:
        attempts = 0

        async def arun(self, **_kwargs):
            RetryRuntime.attempts += 1
            if RetryRuntime.attempts == 1:
                raise RuntimeError("503 Service Unavailable: high demand")
            yield SimpleNamespace(event="RunContent", content="Hey!", agent_id="haven")
            yield SimpleNamespace(event="RunCompleted", content="Hey!", agent_id="haven")

    monkeypatch.setattr(app, "_build_runtime", lambda *_args, **_kwargs: (RetryRuntime(), {"haven": "Haven"}))
    monkeypatch.setenv("AGNO_PROVIDER_RETRY_BASE_SECONDS", "0")
    events = []
    await app._run_agno_async(
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
    assert RetryRuntime.attempts == 2
    assert any(event.get("stage") == "retrying_provider" for event in events)
    result = next(event for event in events if event["type"] == "result")
    assert result["text"] == "Hey!"
    assert result["model"] == "gemini-3.6-flash"

import os
import tempfile
import unittest
from pathlib import Path

import appdirs

os.environ.setdefault("OPENAI_API_KEY", "test-key-not-used")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-used")
os.environ.setdefault("GEMINI_API_KEY", "test-key-not-used")
appdirs.user_data_dir = lambda *_args, **_kwargs: os.path.join(os.getcwd(), ".runtime")

from pydantic import ValidationError

from app import Crew, Process, Task, _agent, _input_files, _model_from_schema, _model_name


class CrewRuntimeTests(unittest.TestCase):
    def test_provider_model_names(self) -> None:
        self.assertEqual(_model_name("gpt-5.4"), "openai/gpt-5.4")
        self.assertEqual(_model_name("claude-sonnet-5-5"), "anthropic/claude-sonnet-5-5")
        self.assertEqual(_model_name("gemini-3.8-flash"), "gemini/gemini-3.8-flash")

    def test_json_schema_becomes_strict_tool_input(self) -> None:
        model = _model_from_schema(
            {
                "type": "object",
                "properties": {
                    "item_id": {"type": "string"},
                    "limit": {"type": "integer"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["item_id"],
            },
            "ReadFileInput",
        )
        value = model(item_id="doc-1", limit=3, tags=["policy"])
        self.assertEqual(value.item_id, "doc-1")
        with self.assertRaises(ValidationError):
            model(limit=3)

    def test_dynamic_crewai_agent_accepts_workspace_tools(self) -> None:
        config = {
            "name": "Haven",
            "role": "Support specialist",
            "goal": "Answer from workspace sources",
            "instructions": "Be accurate.",
            "model": "gpt-5.4",
            "effort": "medium",
            "tools": ["read_file"],
            "max_iter": 4,
            "max_execution_time": 60,
        }
        specs = {
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
        agent = _agent(config, specs, "http://worker:3001/tool", "token", "run-id")
        self.assertEqual(agent.role, "Support specialist")
        self.assertEqual([tool.name for tool in agent.tools], ["read_file"])

    def test_hierarchical_crew_accepts_workspace_manager(self) -> None:
        base = {
            "name": "Specialist",
            "role": "Workspace specialist",
            "goal": "Complete assigned work",
            "instructions": "Be accurate.",
            "model": "gpt-5.4",
            "effort": "medium",
            "tools": [],
            "max_iter": 4,
            "max_execution_time": 60,
        }
        specialist = _agent(base, {}, "http://worker:3001/tool", "token", "run-id")
        manager = _agent({**base, "name": "Team Lead", "role": "Crew manager"}, {}, "http://worker:3001/tool", "token", "run-id", manager=True)
        task = Task(description="Coordinate an answer.", expected_output="One Markdown answer.")
        crew = Crew(
            agents=[specialist], tasks=[task], process=Process.hierarchical, manager_agent=manager,
            stream=True, cache=False, memory=False, verbose=False, share_crew=False,
        )
        self.assertEqual(crew.process, Process.hierarchical)

    def test_image_attachments_are_resolved_inside_private_storage(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            image = Path(root) / "message-attachments" / "agent-images" / "user-id" / "clipboard.png"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"not-decoded-during-construction")
            previous = os.environ.get("STORAGE_ROOT")
            os.environ["STORAGE_ROOT"] = root
            try:
                files = _input_files({"files": [{
                    "path": "agent-images/user-id/clipboard.png",
                    "name": "clipboard.png",
                    "mime_type": "image/png",
                    "size": image.stat().st_size,
                }]})
            finally:
                if previous is None:
                    os.environ.pop("STORAGE_ROOT", None)
                else:
                    os.environ["STORAGE_ROOT"] = previous
            self.assertEqual(list(files), ["image_1_clipboard.png"])

    def test_image_attachments_cannot_escape_storage(self) -> None:
        with self.assertRaises(ValueError):
            _input_files({"files": [{
                "path": "agent-images/../secret.png",
                "name": "secret.png",
                "mime_type": "image/png",
                "size": 10,
            }]})


if __name__ == "__main__":
    unittest.main()

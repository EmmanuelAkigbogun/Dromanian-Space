from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import traceback
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal

from crewai import Agent, Crew, LLM, Process, Task
from crewai.tools import BaseTool
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, Field, PrivateAttr, create_model


def _json_line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def _python_type(schema: dict[str, Any], name: str, root: dict[str, Any]) -> Any:
    reference = schema.get("$ref")
    if isinstance(reference, str) and reference.startswith("#/$defs/"):
        schema = root.get("$defs", {}).get(reference.removeprefix("#/$defs/"), {})
    if "enum" in schema and schema["enum"]:
        return Literal.__getitem__(tuple(schema["enum"]))
    variants = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(variants, list):
        non_null = [v for v in variants if v.get("type") != "null"]
        if len(non_null) == 1:
            return _python_type(non_null[0], name, root) | None
    kind = schema.get("type")
    if kind == "string":
        return str
    if kind == "integer":
        return int
    if kind == "number":
        return float
    if kind == "boolean":
        return bool
    if kind == "array":
        return list[_python_type(schema.get("items", {}), f"{name}Item", root)]
    if kind == "object" or "properties" in schema:
        if not schema.get("properties"):
            return dict[str, Any]
        return _model_from_schema(schema, name, root)
    return Any


def _model_from_schema(schema: dict[str, Any], name: str, root: dict[str, Any] | None = None) -> type[BaseModel]:
    root = root or schema
    required = set(schema.get("required", []))
    fields: dict[str, tuple[Any, Any]] = {}
    for key, value in schema.get("properties", {}).items():
        field_type = _python_type(value, f"{name}{key.title().replace('_', '')}", root)
        default = ... if key in required else value.get("default", None)
        fields[key] = (
            field_type if key in required else field_type | None,
            Field(default, description=value.get("description")),
        )
    return create_model(name, **fields)


class CallbackTool(BaseTool):
    _callback_url: str = PrivateAttr()
    _callback_token: str = PrivateAttr()
    _run_id: str = PrivateAttr()

    def __init__(self, spec: dict[str, Any], callback_url: str, callback_token: str, run_id: str):
        schema = _model_from_schema(spec.get("inputSchema", {}), f"{spec['name'].title().replace('_', '')}Input")
        super().__init__(name=spec["name"], description=spec.get("description", spec["name"]), args_schema=schema)
        self._callback_url = callback_url
        self._callback_token = callback_token
        self._run_id = run_id

    def _run(self, **kwargs: Any) -> str:
        body = json.dumps(
            {
                "run_id": self._run_id,
                "tool_use_id": str(uuid.uuid4()),
                "name": self.name,
                "input": kwargs,
            },
            separators=(",", ":"),
        ).encode()
        request = urllib.request.Request(
            self._callback_url,
            data=body,
            headers={"content-type": "application/json", "authorization": f"Bearer {self._callback_token}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = json.loads(response.read())
            return str(result.get("content", ""))
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:500]
            return f"The tool failed ({error.code}): {detail}"
        except Exception as error:
            return f"The tool failed: {error}"


def _model_name(model: str) -> str:
    lower = model.lower()
    if "/" in model:
        return model
    if lower.startswith("claude"):
        return f"anthropic/{model}"
    if lower.startswith("gemini"):
        return f"gemini/{model}"
    return f"openai/{model}"


def _provider_key(provider: str) -> str | None:
    environment = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}[provider]
    root = os.getenv("STORAGE_ROOT", "/data/storage")
    try:
        with open(os.path.join(root, ".config", "ai-provider-keys.json"), encoding="utf-8") as handle:
            sealed = json.load(handle).get("providers", {}).get(provider)
        secret = os.getenv("APP_JWT_SECRET", "")
        if sealed and len(secret) >= 32:
            key = hashlib.sha256(f"dromanian-ai-provider-keys:{secret}".encode()).digest()
            iv = base64.b64decode(sealed["iv"])
            ciphertext = base64.b64decode(sealed["ciphertext"]) + base64.b64decode(sealed["tag"])
            return AESGCM(key).decrypt(iv, ciphertext, f"provider:{provider}:v1".encode()).decode()
    except (FileNotFoundError, InvalidTag, KeyError, ValueError, json.JSONDecodeError):
        pass
    return os.getenv(environment) or (os.getenv("GEMINI_API") if provider == "gemini" else None)


def _llm(model: str, effort: str | None) -> LLM:
    name = _model_name(model)
    options: dict[str, Any] = {"model": name, "stream": True}
    provider = "anthropic" if name.startswith("anthropic/") else ("gemini" if name.startswith("gemini/") else "openai")
    if key := _provider_key(provider):
        options["api_key"] = key
    if name.startswith("openai/") and os.getenv("OPENAI_BASE_URL"):
        options["base_url"] = os.environ["OPENAI_BASE_URL"]
    if effort and name.startswith("openai/"):
        options["reasoning_effort"] = effort
    return LLM(**options)


def _agent(
    config: dict[str, Any],
    tool_specs: dict[str, dict[str, Any]],
    callback_url: str,
    callback_token: str,
    run_id: str,
    *,
    manager: bool = False,
) -> Agent:
    tools = [
        CallbackTool(tool_specs[name], callback_url, callback_token, run_id)
        for name in config.get("tools", [])
        if name in tool_specs
    ]
    return Agent(
        role=config.get("role") or config["name"],
        goal=config.get("goal") or config.get("description") or "Help the requester accurately.",
        backstory=config.get("backstory") or config.get("instructions") or "You are a member of the workspace crew.",
        llm=_llm(config["model"], config.get("effort")),
        tools=tools,
        allow_delegation=manager,
        max_iter=max(1, min(int(config.get("max_iter", 12)), 30)),
        max_execution_time=max(30, min(int(config.get("max_execution_time", 540)), 900)),
        respect_context_window=True,
        verbose=False,
        cache=False,
        tool_failure_policy="warn",
    )


def _usage(value: Any) -> dict[str, int]:
    raw = value.model_dump() if hasattr(value, "model_dump") else (value or {})
    return {
        "input_tokens": int(raw.get("prompt_tokens", raw.get("input_tokens", 0)) or 0),
        "output_tokens": int(raw.get("completion_tokens", raw.get("output_tokens", 0)) or 0),
        "cache_read_tokens": int(raw.get("cached_prompt_tokens", 0) or 0),
        "cache_write_tokens": 0,
    }


def run_crew(payload: dict[str, Any], send: Any) -> None:
    run_id = payload["run_id"]
    callback_url = payload["callback_url"]
    callback_token = payload["callback_token"]
    specs = {item["name"]: item for item in payload.get("tools", [])}
    manager_config = payload["agent"]
    is_team = manager_config.get("kind") == "coordinator" and bool(payload.get("specialists"))

    manager = _agent(manager_config, specs, callback_url, callback_token, run_id, manager=is_team)
    if is_team:
        specialists = [
            _agent(item, specs, callback_url, callback_token, run_id)
            for item in payload["specialists"][:20]
        ]
        task = Task(
            description=payload["prompt"],
            expected_output="One accurate, concise Markdown answer for the requester, combining the specialists' work and preserving citations.",
        )
        crew = Crew(
            agents=specialists,
            tasks=[task],
            process=Process.hierarchical,
            manager_agent=manager,
            stream=True,
            cache=False,
            memory=False,
            verbose=False,
            share_crew=False,
        )
    else:
        task = Task(
            description=payload["prompt"],
            expected_output="A focused, accurate Markdown answer for the requester. Preserve valid bracketed source citations.",
            agent=manager,
        )
        crew = Crew(
            agents=[manager],
            tasks=[task],
            process=Process.sequential,
            stream=True,
            cache=False,
            memory=False,
            verbose=False,
            share_crew=False,
        )

    streaming = crew.kickoff()
    if not is_team:
        for chunk in streaming:
            content = getattr(chunk, "content", "")
            chunk_type = str(getattr(chunk, "chunk_type", ""))
            if content and "TOOL_CALL" not in chunk_type:
                send({"type": "delta", "text": content})
    else:
        for chunk in streaming:
            role = getattr(chunk, "agent_role", None)
            if role:
                send({"type": "team", "agent": role, "status": "working"})

    result = streaming.result
    send(
        {
            "type": "result",
            "text": result.raw,
            "usage": _usage(getattr(result, "token_usage", None)),
            "model": manager_config["model"],
        }
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(json.dumps({"level": "info", "message": fmt % args}), flush=True)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > 2_000_000:
            raise ValueError("invalid request size")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        body = b'{"ok":true,"runtime":"crewai"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/run":
            self.send_error(404)
            return
        expected = os.getenv("CREW_INTERNAL_TOKEN", "")
        supplied = self.headers.get("authorization", "").removeprefix("Bearer ")
        if not expected or not hmac.compare_digest(supplied, expected):
            self.send_error(401)
            return
        try:
            payload = self._body()
            if not payload.get("run_id") or not payload.get("agent") or not payload.get("prompt"):
                raise ValueError("run_id, agent and prompt are required")
        except Exception as error:
            body = _json_line({"type": "error", "code": "invalid_request", "message": str(error)})
            self.send_response(400)
            self.send_header("content-type", "application/x-ndjson")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson")
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "close")
        self.end_headers()

        def send(value: dict[str, Any]) -> None:
            self.wfile.write(_json_line(value))
            self.wfile.flush()

        try:
            run_crew(payload, send)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            try:
                send({"type": "error", "code": "crew_error", "message": str(error)[:1000]})
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            self.close_connection = True


def main() -> None:
    os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
    os.environ.setdefault("OTEL_SDK_DISABLED", "true")
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(json.dumps({"level": "info", "message": "CrewAI runtime listening", "port": port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

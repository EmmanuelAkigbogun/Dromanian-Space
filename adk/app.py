from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
import traceback
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from google.adk.agents import Agent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.models.google_llm import Gemini
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import BaseTool
from google.genai import types


APP_NAME = "darkspace"
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
RESILIENT_GEMINI_MODELS = ("gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite")


def _json_line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


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


def _model(model: str) -> Gemini | LiteLlm:
    lower = model.lower()
    if lower.startswith("gemini"):
        if key := _provider_key("gemini"):
            # Google ADK follows the official google-genai environment name.
            os.environ["GOOGLE_API_KEY"] = key
        return Gemini(model=model)
    if lower.startswith("claude"):
        if key := _provider_key("anthropic"):
            os.environ["ANTHROPIC_API_KEY"] = key
        return LiteLlm(model=model if "/" in model else f"anthropic/{model}")
    if key := _provider_key("openai"):
        os.environ["OPENAI_API_KEY"] = key
    return LiteLlm(model=model if "/" in model else f"openai/{model}")


def _agent_name(name: str, index: int) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_").lower() or "agent"
    if slug[0].isdigit():
        slug = f"agent_{slug}"
    digest = hashlib.sha256(f"{index}:{name}".encode()).hexdigest()[:8]
    return f"{slug[:48]}_{digest}"


class CallbackTool(BaseTool):
    def __init__(self, spec: dict[str, Any], callback_url: str, callback_token: str, run_id: str):
        super().__init__(name=spec["name"], description=spec.get("description", spec["name"]))
        self._schema = spec.get("inputSchema") or {"type": "object", "properties": {}}
        self._callback_url = callback_url
        self._callback_token = callback_token
        self._run_id = run_id

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters_json_schema=self._schema,
        )

    def _call(self, args: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(
            {
                "run_id": self._run_id,
                "tool_use_id": str(uuid.uuid4()),
                "name": self.name,
                "input": args,
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
            return {"content": str(result.get("content", "")), "isError": bool(result.get("isError", False))}
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:500]
            return {"content": f"The tool failed ({error.code}): {detail}", "isError": True}
        except Exception as error:
            return {"content": f"The tool failed: {error}", "isError": True}

    async def run_async(self, *, args: dict[str, Any], tool_context: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._call, args)


def _tools(
    config: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    callback_url: str,
    callback_token: str,
    run_id: str,
) -> list[CallbackTool]:
    return [
        CallbackTool(specs[name], callback_url, callback_token, run_id)
        for name in config.get("tools", [])
        if name in specs
    ]


def _instruction(config: dict[str, Any], *, manager: bool, specialists: list[dict[str, Any]]) -> str:
    identity = "\n".join(
        part
        for part in (
            f"Your role is {config.get('role')}." if config.get("role") else "",
            f"Your goal is: {config.get('goal')}" if config.get("goal") else "",
            config.get("instructions", ""),
        )
        if part
    )
    if not manager:
        return identity
    roster = "\n".join(
        f"- {item.get('name')}: {item.get('description') or item.get('role') or item.get('goal') or 'workspace specialist'}"
        for item in specialists
    )
    return (
        f"{identity}\n\nYou lead the following workspace specialists:\n{roster}\n\n"
        "Delegate focused work when a specialist is relevant. Keep delegation proportional to the request, "
        "then return one accurate, concise Markdown answer that combines the useful findings and preserves source citations."
    )


def _build_agent(
    config: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    callback_url: str,
    callback_token: str,
    run_id: str,
    *,
    index: int,
    specialists: list[dict[str, Any]] | None = None,
) -> tuple[Agent, dict[str, str]]:
    specialist_configs = specialists or []
    sub_agents: list[Agent] = []
    display_names: dict[str, str] = {}
    for child_index, child in enumerate(specialist_configs, start=1):
        child_name = _agent_name(str(child.get("name", "specialist")), child_index)
        display_names[child_name] = str(child.get("name", child_name))
        sub_agents.append(
            Agent(
                name=child_name,
                description=str(child.get("description") or child.get("role") or child.get("goal") or "Workspace specialist"),
                model=_model(str(child["model"])),
                instruction=_instruction(child, manager=False, specialists=[]),
                tools=_tools(child, specs, callback_url, callback_token, run_id),
                timeout=float(max(30, min(int(child.get("max_execution_time", 540)), 900))),
            )
        )
    name = _agent_name(str(config.get("name", "agent")), index)
    display_names[name] = str(config.get("name", name))
    agent = Agent(
        name=name,
        description=str(config.get("description") or config.get("role") or config.get("goal") or "Workspace agent"),
        model=_model(str(config["model"])),
        instruction=_instruction(config, manager=bool(sub_agents), specialists=specialist_configs),
        tools=_tools(config, specs, callback_url, callback_token, run_id),
        sub_agents=sub_agents,
        timeout=float(max(30, min(int(config.get("max_execution_time", 540)), 900))),
    )
    return agent, display_names


def _message(payload: dict[str, Any]) -> types.Content:
    parts: list[types.Part] = [types.Part(text=str(payload["prompt"]))]
    storage = Path(os.getenv("STORAGE_ROOT", "/data/storage")).resolve()
    base = (storage / "message-attachments" / "agent-images").resolve()
    for item in payload.get("files", []):
        relative = str(item.get("path", ""))
        mime_type = str(item.get("mime_type", ""))
        claimed_size = int(item.get("size", 0))
        if not relative.startswith("agent-images/") or "\\" in relative or mime_type not in ALLOWED_IMAGE_TYPES:
            raise ValueError("invalid image attachment")
        source = (storage / "message-attachments" / relative).resolve()
        if base not in source.parents or not source.is_file():
            raise ValueError("image attachment is outside storage or missing")
        actual_size = source.stat().st_size
        if actual_size <= 0 or actual_size > 10 * 1024 * 1024 or actual_size != claimed_size:
            raise ValueError("image attachment has an invalid size")
        parts.append(types.Part.from_bytes(data=source.read_bytes(), mime_type=mime_type))
    return types.Content(role="user", parts=parts)


def _event_text(event: Any) -> str:
    content = getattr(event, "content", None)
    return "".join(str(part.text) for part in (getattr(content, "parts", None) or []) if getattr(part, "text", None))


def _add_usage(total: dict[str, int], metadata: Any) -> None:
    if not metadata:
        return
    total["input_tokens"] += int(getattr(metadata, "prompt_token_count", 0) or 0)
    total["output_tokens"] += int(getattr(metadata, "candidates_token_count", 0) or 0)
    total["cache_read_tokens"] += int(getattr(metadata, "cached_content_token_count", 0) or 0)


def _is_retryable_provider_error(error: Exception) -> bool:
    message = f"{type(error).__name__}: {error}".lower()
    return any(
        marker in message
        for marker in (
            "429",
            "500 service unavailable",
            "502",
            "503",
            "504",
            "deadline exceeded",
            "high demand",
            "resource_exhausted",
            "temporarily unavailable",
            "unavailable",
        )
    )


def _model_candidates(requested: str) -> list[str]:
    if not requested.lower().startswith("gemini"):
        return [requested]
    if requested in RESILIENT_GEMINI_MODELS:
        return list(RESILIENT_GEMINI_MODELS[RESILIENT_GEMINI_MODELS.index(requested) :])
    return list(dict.fromkeys((requested, *RESILIENT_GEMINI_MODELS[1:])))


async def _run_adk_async(payload: dict[str, Any], send: Any) -> None:
    run_id = str(payload["run_id"])
    specs = {item["name"]: item for item in payload.get("tools", [])}
    manager_config = payload["agent"]
    is_team = manager_config.get("kind") == "coordinator" and bool(payload.get("specialists"))
    specialist_configs = payload.get("specialists", [])[:20] if is_team else []

    send({"type": "stage", "stage": "preparing", "label": "Preparing the agent"})
    abort_signal = asyncio.Event()
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    streamed_text = ""
    final_text = ""
    generating = False
    active_team: set[str] = set()
    max_calls = max(1, min(int(manager_config.get("max_iter", 12)), 30))

    message = _message(payload)
    manager_candidates = _model_candidates(str(manager_config["model"]))
    configured_attempts = max(1, min(int(os.getenv("ADK_PROVIDER_MAX_ATTEMPTS", "3")), 5))
    if str(manager_config["model"]).lower().startswith("gemini"):
        max_attempts = min(configured_attempts, len(manager_candidates))
    else:
        max_attempts = configured_attempts
        manager_candidates = [manager_candidates[0]] * max_attempts
    retry_base_seconds = max(0.0, min(float(os.getenv("ADK_PROVIDER_RETRY_BASE_SECONDS", "1")), 10.0))
    resolved_model = manager_candidates[0]
    for attempt in range(1, max_attempts + 1):
        resolved_model = manager_candidates[attempt - 1]
        attempt_manager = {**manager_config, "model": resolved_model}
        attempt_specialists = []
        for specialist in specialist_configs:
            specialist_candidates = _model_candidates(str(specialist["model"]))
            attempt_specialists.append(
                {**specialist, "model": specialist_candidates[min(attempt - 1, len(specialist_candidates) - 1)]}
            )
        agent, display_names = _build_agent(
            attempt_manager,
            specs,
            str(payload["callback_url"]),
            str(payload["callback_token"]),
            run_id,
            index=0,
            specialists=attempt_specialists,
        )
        session_service = InMemorySessionService()
        await session_service.create_session(app_name=APP_NAME, user_id=run_id, session_id=run_id)
        runner = Runner(app_name=APP_NAME, agent=agent, session_service=session_service)
        send({"type": "stage", "stage": "contacting_provider", "label": "Waiting for the AI provider"})
        events = runner.run_async(
            user_id=run_id,
            session_id=run_id,
            new_message=message,
            run_config=RunConfig(streaming_mode=StreamingMode.SSE, max_llm_calls=max_calls),
            abort_signal=abort_signal,
        )
        try:
            async for event in events:
                _add_usage(usage, getattr(event, "usage_metadata", None))
                author = str(getattr(event, "author", "") or "")
                if author and author != agent.name and author in display_names and author not in active_team:
                    active_team.add(author)
                    send({"type": "team", "agent": display_names[author], "status": "working"})
                text = _event_text(event)
                partial = bool(getattr(event, "partial", False))
                if text and partial and (not is_team or author == agent.name):
                    if not generating:
                        send({"type": "stage", "stage": "generating", "label": "Writing the answer"})
                        generating = True
                    streamed_text += text
                    send({"type": "delta", "text": text})
                if text and event.is_final_response():
                    final_text = text
            break
        except Exception as error:
            can_retry = attempt < max_attempts and not streamed_text and _is_retryable_provider_error(error)
            if not can_retry:
                abort_signal.set()
                raise
            send(
                {
                    "type": "stage",
                    "stage": "retrying_provider",
                    "label": f"The AI provider is busy; trying another Gemini model ({attempt + 1}/{max_attempts})",
                }
            )
            await asyncio.sleep(retry_base_seconds * (2 ** (attempt - 1)))
        finally:
            await runner.close()

    abort_signal.set()

    result_text = streamed_text
    if final_text and final_text not in streamed_text:
        result_text += final_text
    if not result_text:
        result_text = final_text
    if not result_text:
        raise RuntimeError("Google ADK ended without a final response.")
    send({"type": "stage", "stage": "finalizing", "label": "Finishing the answer"})
    send({"type": "result", "text": result_text, "usage": usage, "model": resolved_model})


def run_adk(payload: dict[str, Any], send: Any) -> None:
    asyncio.run(_run_adk_async(payload, send))


_active_processes: dict[str, subprocess.Popen[bytes]] = {}
_active_lock = threading.Lock()


def _terminate(run_id: str) -> bool:
    with _active_lock:
        process = _active_processes.get(run_id)
    if process is None or process.poll() is not None:
        return False
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    return True


def _child_main() -> None:
    payload = json.loads(sys.stdin.buffer.read())
    protocol = sys.stdout.buffer
    sys.stdout = sys.stderr

    def send(value: dict[str, Any]) -> None:
        protocol.write(_json_line(value))
        protocol.flush()

    try:
        run_adk(payload, send)
    except Exception as error:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        send({"type": "error", "code": "adk_error", "message": str(error)[:1000]})


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
        body = b'{"ok":true,"runtime":"google-adk"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/run" and not self.path.startswith("/cancel/"):
            self.send_error(404)
            return
        expected = os.getenv("ADK_INTERNAL_TOKEN", "")
        supplied = self.headers.get("authorization", "").removeprefix("Bearer ")
        if not expected or not hmac.compare_digest(supplied, expected):
            self.send_error(401)
            return
        if self.path.startswith("/cancel/"):
            run_id = self.path.removeprefix("/cancel/")
            body = json.dumps({"ok": True, "stopped": _terminate(run_id)}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
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
        process: subprocess.Popen[bytes] | None = None
        run_id = str(payload["run_id"])
        try:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--execute-run"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
            )
            with _active_lock:
                _active_processes[run_id] = process
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(json.dumps(payload, separators=(",", ":")).encode())
            process.stdin.close()
            for line in iter(process.stdout.readline, b""):
                self.wfile.write(line)
                self.wfile.flush()
            process.wait()
        except (BrokenPipeError, ConnectionResetError):
            _terminate(run_id)
        except Exception as error:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            try:
                self.wfile.write(_json_line({"type": "error", "code": "adk_error", "message": str(error)[:1000]}))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            with _active_lock:
                if _active_processes.get(run_id) is process:
                    _active_processes.pop(run_id, None)
            if process is not None and process.poll() is None:
                process.terminate()
            self.close_connection = True


def main() -> None:
    os.environ.setdefault("OTEL_SDK_DISABLED", "true")
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(json.dumps({"level": "info", "message": "Google ADK runtime listening", "port": port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    if "--execute-run" in sys.argv:
        _child_main()
    else:
        main()

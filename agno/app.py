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
from agno.agent import Agent
from agno.media import Image
from agno.models.anthropic import Claude
from agno.models.cerebras import Cerebras
from agno.models.google import Gemini
from agno.models.openai import OpenAIChat
from agno.team import Team
from agno.team.mode import TeamMode
from agno.tools.function import Function


APP_NAME = "darkspace"
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
RESILIENT_GEMINI_MODELS = ("gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite")


def _json_line(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def _provider_key(provider: str) -> str | None:
    environment = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "cerebras": "CEREBRAS_API_KEY",
    }[provider]
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
    return (
        os.getenv(environment)
        or (os.getenv("GEMINI_API") if provider == "gemini" else None)
        or (os.getenv("CEREBRAS_DIGITALROMANIAN") if provider == "cerebras" else None)
    )


def _model(model: str) -> Gemini | Claude | Cerebras | OpenAIChat:
    lower = model.lower()
    timeout = max(5.0, min(float(os.getenv("AGNO_PROVIDER_REQUEST_TIMEOUT_SECONDS", "45")), 180.0))
    if lower.startswith("gemini"):
        if key := _provider_key("gemini"):
            os.environ["GOOGLE_API_KEY"] = key
        return Gemini(id=model, api_key=key, timeout=timeout, retries=1)
    if lower.startswith("claude"):
        if key := _provider_key("anthropic"):
            os.environ["ANTHROPIC_API_KEY"] = key
        return Claude(id=model.removeprefix("anthropic/"), api_key=key, timeout=timeout, retries=1)
    if lower == "gpt-oss-120b" or lower.startswith("cerebras/"):
        if key := _provider_key("cerebras"):
            os.environ["CEREBRAS_API_KEY"] = key
        return Cerebras(
            id=model.removeprefix("cerebras/"),
            api_key=key,
            timeout=timeout,
            retries=1,
            default_headers={"X-Cerebras-3rd-Party-Integration": "agno"},
        )
    if key := _provider_key("openai"):
        os.environ["OPENAI_API_KEY"] = key
    return OpenAIChat(
        id=model.removeprefix("openai/"),
        api_key=key,
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        timeout=timeout,
        retries=1,
    )


def _agent_name(name: str, index: int) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_").lower() or "agent"
    if slug[0].isdigit():
        slug = f"agent_{slug}"
    digest = hashlib.sha256(f"{index}:{name}".encode()).hexdigest()[:8]
    return f"{slug[:48]}_{digest}"


class CallbackTool:
    def __init__(self, spec: dict[str, Any], callback_url: str, callback_token: str, run_id: str):
        self.name = spec["name"]
        self.description = spec.get("description", spec["name"])
        self._schema = spec.get("inputSchema") or {"type": "object", "properties": {}}
        self._callback_url = callback_url
        self._callback_token = callback_token
        self._run_id = run_id

        self.function = Function(
            name=self.name,
            description=self.description,
            parameters=self._schema,
            entrypoint=self._call,
            skip_entrypoint_processing=True,
        )

    def _call(self, **args: Any) -> dict[str, Any]:
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

def _tools(
    config: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    callback_url: str,
    callback_token: str,
    run_id: str,
) -> list[Function]:
    return [
        CallbackTool(specs[name], callback_url, callback_token, run_id).function
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


def _build_runtime(
    config: dict[str, Any],
    specs: dict[str, dict[str, Any]],
    callback_url: str,
    callback_token: str,
    run_id: str,
    *,
    index: int,
    specialists: list[dict[str, Any]] | None = None,
) -> tuple[Agent | Team, dict[str, str]]:
    specialist_configs = specialists or []
    sub_agents: list[Agent] = []
    display_names: dict[str, str] = {}
    for child_index, child in enumerate(specialist_configs, start=1):
        child_name = _agent_name(str(child.get("name", "specialist")), child_index)
        display_names[child_name] = str(child.get("name", child_name))
        sub_agents.append(
            Agent(
                id=child_name,
                name=str(child.get("name", child_name)),
                role=str(child.get("role") or child.get("goal") or "Workspace specialist"),
                description=str(child.get("description") or child.get("role") or child.get("goal") or "Workspace specialist"),
                model=_model(str(child["model"])),
                instructions=[_instruction(child, manager=False, specialists=[])],
                tools=_tools(child, specs, callback_url, callback_token, run_id),
                tool_call_limit=max(1, min(int(child.get("max_iter", 12)), 30)),
                markdown=True,
            )
        )
    name = _agent_name(str(config.get("name", "agent")), index)
    display_names[name] = str(config.get("name", name))
    common = {
        "id": name,
        "name": str(config.get("name", name)),
        "description": str(config.get("description") or config.get("role") or config.get("goal") or "Workspace agent"),
        "model": _model(str(config["model"])),
        "instructions": [_instruction(config, manager=bool(sub_agents), specialists=specialist_configs)],
        "tools": _tools(config, specs, callback_url, callback_token, run_id),
        "markdown": True,
    }
    if sub_agents:
        return (
            Team(
                **common,
                members=sub_agents,
                mode=TeamMode.coordinate,
                tool_call_limit=max(1, min(int(config.get("max_iter", 12)), 30)),
                stream_member_events=True,
                show_members_responses=False,
                telemetry=False,
            ),
            display_names,
        )
    return (
        Agent(
            **common,
            role=str(config.get("role") or config.get("goal") or "Workspace agent"),
            tool_call_limit=max(1, min(int(config.get("max_iter", 12)), 30)),
        ),
        display_names,
    )


def _images(payload: dict[str, Any]) -> list[Image]:
    images: list[Image] = []
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
        images.append(
            Image(
                content=source.read_bytes(),
                format={"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[mime_type],
                mime_type=mime_type,
            )
        )
    return images


def _add_usage(total: dict[str, int], event: Any) -> None:
    if not str(getattr(event, "event", "")).endswith("ModelRequestCompleted"):
        return
    total["input_tokens"] += int(getattr(event, "input_tokens", 0) or 0)
    total["output_tokens"] += int(getattr(event, "output_tokens", 0) or 0)
    total["cache_read_tokens"] += int(getattr(event, "cache_read_tokens", 0) or 0)
    total["cache_write_tokens"] += int(getattr(event, "cache_write_tokens", 0) or 0)


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


async def _run_agno_async(payload: dict[str, Any], send: Any) -> None:
    run_id = str(payload["run_id"])
    specs = {item["name"]: item for item in payload.get("tools", [])}
    manager_config = payload["agent"]
    is_team = manager_config.get("kind") == "coordinator" and bool(payload.get("specialists"))
    specialist_configs = payload.get("specialists", [])[:20] if is_team else []

    send({"type": "stage", "stage": "preparing", "label": "Preparing the agent"})
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    streamed_text = ""
    final_text = ""
    generating = False
    active_team: set[str] = set()
    images = _images(payload)
    manager_candidates = _model_candidates(str(manager_config["model"]))
    configured_attempts = max(1, min(int(os.getenv("AGNO_PROVIDER_MAX_ATTEMPTS", "3")), 5))
    if str(manager_config["model"]).lower().startswith("gemini"):
        max_attempts = min(configured_attempts, len(manager_candidates))
    else:
        max_attempts = configured_attempts
        manager_candidates = [manager_candidates[0]] * max_attempts
    retry_base_seconds = max(0.0, min(float(os.getenv("AGNO_PROVIDER_RETRY_BASE_SECONDS", "1")), 10.0))
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
        runtime, display_names = _build_runtime(
            attempt_manager,
            specs,
            str(payload["callback_url"]),
            str(payload["callback_token"]),
            run_id,
            index=0,
            specialists=attempt_specialists,
        )
        send({"type": "stage", "stage": "contacting_provider", "label": "Waiting for the AI provider"})
        events = runtime.arun(
            input=str(payload["prompt"]),
            images=images or None,
            session_id=run_id,
            user_id=run_id,
            run_id=run_id,
            stream=True,
            stream_events=True,
        )
        try:
            async for event in events:
                _add_usage(usage, event)
                member_id = str(getattr(event, "agent_id", "") or "")
                if is_team and member_id in display_names and member_id not in active_team:
                    active_team.add(member_id)
                    send({"type": "team", "agent": display_names[member_id], "status": "working"})
                event_type = str(getattr(event, "event", ""))
                content = getattr(event, "content", None)
                text = content if isinstance(content, str) else ""
                leader_content = not is_team or not member_id
                if text and event_type in {"RunContent", "TeamRunContent"} and leader_content:
                    if not generating:
                        send({"type": "stage", "stage": "generating", "label": "Writing the answer"})
                        generating = True
                    streamed_text += text
                    send({"type": "delta", "text": text})
                if text and event_type in {"RunCompleted", "TeamRunCompleted"} and leader_content:
                    final_text = text
            break
        except Exception as error:
            can_retry = attempt < max_attempts and not streamed_text and _is_retryable_provider_error(error)
            if not can_retry:
                raise
            send(
                {
                    "type": "stage",
                    "stage": "retrying_provider",
                    "label": f"The AI provider is busy; retrying ({attempt + 1}/{max_attempts})",
                }
            )
            await asyncio.sleep(retry_base_seconds * (2 ** (attempt - 1)))

    result_text = streamed_text or final_text
    if not result_text:
        raise RuntimeError("Agno ended without a final response.")
    send({"type": "stage", "stage": "finalizing", "label": "Finishing the answer"})
    send({"type": "result", "text": result_text, "usage": usage, "model": resolved_model})


def run_agno(payload: dict[str, Any], send: Any) -> None:
    asyncio.run(_run_agno_async(payload, send))


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
        run_agno(payload, send)
    except Exception as error:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        send({"type": "error", "code": "agno_error", "message": str(error)[:1000]})


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
        body = b'{"ok":true,"runtime":"agno"}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/run" and not self.path.startswith("/cancel/"):
            self.send_error(404)
            return
        expected = os.getenv("AGNO_INTERNAL_TOKEN", "")
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
                self.wfile.write(_json_line({"type": "error", "code": "agno_error", "message": str(error)[:1000]}))
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
    os.environ.setdefault("AGNO_TELEMETRY", "false")
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(json.dumps({"level": "info", "message": "Agno runtime listening", "port": port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    if "--execute-run" in sys.argv:
        _child_main()
    else:
        main()

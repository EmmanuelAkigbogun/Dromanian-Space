# Google ADK agent runtime

Darkspace runs its workspace agents with Google Agent Development Kit (ADK). The Python runtime is intentionally stateless: the Node worker remains responsible for authorization, durable runs, conversations, citations, approval-gated proposals and tool execution. This keeps the existing database and stored files unchanged.

## Runtime contract

The private `adk` service exposes the same authenticated contract used by the worker:

- `GET /health` reports the runtime identity.
- `POST /run` accepts the selected agent, specialists, authorized tool schemas, conversation prompt and validated image paths. It streams newline-delimited `stage`, `delta`, `team`, `result` or `error` events.
- `POST /cancel/:run_id` terminates the isolated process for that run.
- Tool calls return to the worker's private `/tool` bridge with a per-run bearer token. The worker executes each tool under the requester's permissions and existing approval rules.

Each run uses an ADK `Runner` and in-memory session because durable state already lives in the Darkspace database. A coordinator becomes an ADK agent with specialist `sub_agents`; specialist descriptions drive delegation. Gemini is the default model. Existing OpenAI and Anthropic agent selections remain supported through ADK's LiteLLM model adapter.

## Credentials and data

The runtime reuses the existing server-only provider configuration. It first checks the encrypted provider-key file under the mounted storage root, then the existing environment variables. Gemini's compatibility alias `GEMINI_API` remains accepted. Keys are never sent to the browser or written to repository files.

No schema or data migration is required. Existing agents, versions, conversations, run events, sources, citations and usage records retain their identifiers and storage locations.

## Pinned deployment

Python dependencies are declared in `adk/pyproject.toml` and fully resolved in `adk/uv.lock`. The Docker build uses pinned Python and uv images, installs with `uv sync --locked`, and runs as an unprivileged user. Compose routes only the worker to the private `adk:8000` service.

To verify a candidate build before deployment:

```sh
npm run lint
npm run test:unit
npm run build
npm run build:server
cd adk && uv sync --locked && uv run pytest -q
docker compose build adk api worker web
```

Then exercise `/health`, a direct Gemini prompt, a workspace read tool, a coordinator delegation, image input and cancellation in a non-production environment. Production should be switched only after those checks pass.

## Implementation references

- [Google ADK Python repository](https://github.com/google/adk-python)
- [Python quickstart](https://adk.dev/get-started/python/)
- [Migration guide](https://adk.dev/get-started/migrate/)
- [Agent teams](https://adk.dev/tutorials/agent-team/)
- [Function tools](https://adk.dev/tools-custom/function-tools/)
- [Runtime events](https://adk.dev/events/)
- [Run cancellation](https://adk.dev/runtime/cancel/)

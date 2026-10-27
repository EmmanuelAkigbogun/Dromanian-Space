# Agno agent runtime

Darkspace runs its workspace agents with Agno. The Python runtime is intentionally stateless: the Node worker remains responsible for authorization, durable runs, conversations, citations, approval-gated proposals and tool execution. This keeps the existing database and stored files unchanged.

## Runtime contract

The private `agno` service exposes the same authenticated contract used by the worker:

- `GET /health` reports the runtime identity.
- `POST /run` accepts the selected agent, specialists, authorized tool schemas, conversation prompt and validated image paths. It streams newline-delimited `stage`, `delta`, `team`, `result` or `error` events.
- `POST /cancel/:run_id` terminates the isolated process for that run.
- Tool calls return to the worker's private `/tool` bridge with a per-run bearer token. The worker executes each tool under the requester's permissions and existing approval rules.

Each specialist becomes a native Agno `Agent`; a coordinator becomes a native Agno `Team` in coordinate mode. Agno handles delegation and synthesis while durable state remains in the Darkspace database. Cerebras `gpt-oss-120b` is the built-in team's default through Agno's native Cerebras adapter. Existing Gemini, OpenAI and Anthropic model selections remain supported through their native Agno adapters.

## Credentials and data

The runtime reuses the existing server-only provider configuration. It first checks the encrypted provider-key file under the mounted storage root, then the existing environment variables. Cerebras accepts `CEREBRAS_API_KEY` and the compatibility alias `CEREBRAS_DIGITALROMANIAN`; Gemini's `GEMINI_API` alias also remains accepted. Keys are never sent to the browser or written to repository files.

The Cerebras roster migration archives older built-ins without deleting their conversations, runs, events, sources, citations or usage. Persistent storage locations and access rules remain unchanged.

## Pinned deployment

Python dependencies are declared in `agno/pyproject.toml` and fully resolved in `agno/uv.lock`. The Docker build uses pinned Python and uv images, installs with `uv sync --locked`, and runs as an unprivileged user. Compose routes only the worker to the private `agno:8000` service. Agno telemetry is disabled.

To verify a candidate build before deployment:

```sh
npm run lint
npm run test:unit
npm run build
npm run build:server
cd agno && uv sync --locked && uv run pytest -q
docker compose build agno api worker web
```

Then exercise `/health`, a direct Cerebras prompt, a workspace read tool, a coordinator delegation, image input and cancellation in a non-production environment. Production should be switched only after those checks pass.

## Implementation references

- [Agno repository](https://github.com/agno-agi/agno)
- [Agno agents](https://docs.agno.com/agents)
- [Agno team delegation](https://docs.agno.com/teams/delegation)
- [Agno team streaming](https://docs.agno.com/teams/running-teams)
- [Agno Python function tools](https://docs.agno.com/tools/creating-tools/python-functions)
- [Cerebras Agno integration](https://inference-docs.cerebras.ai/integrations/agno)

# AI providers

Agents run on external model APIs: **Cerebras Cloud**, **Anthropic (Claude)**, **OpenAI**, and **Google Gemini**. All can be configured at
once. Each agent version stores a model id, and the provider follows from it (`claude-…` is
Anthropic; `gpt-…`, `o…` and `chatgpt-…` are OpenAI). So specialists in one Team Chat run can use
different providers. Model ids beginning with `gemini-` use Google Gemini; `gpt-oss-120b` and `cerebras/...` use Cerebras. No GPU and no local model server are needed.

The current production roster is Cerebras-first: all 20 built-in agents use `gpt-oss-120b`. Older built-ins are retired from the active roster while their conversations and runs remain readable.

## Server configuration (api and worker)

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables Claude models. |
| `ANTHROPIC_REFUSAL_FALLBACK` | `on` (default) or `off`: server-side refusal fallback for models that support it. |
| `AI_DEFAULT_ANTHROPIC_MODEL` | Default Claude model for new workspaces (`claude-opus-5-5`). |
| `OPENAI_API_KEY` | Enables OpenAI models. |
| `AI_DEFAULT_OPENAI_MODEL` | Default OpenAI model for new workspaces (`gpt-5.4`). |
| `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | Optional OpenAI client settings. |
| `GEMINI_API_KEY` | Enables Google Gemini models. |
| `GEMINI_API` | Compatibility alias for `GEMINI_API_KEY` (accepted for existing Coolify setups). |
| `AI_DEFAULT_GEMINI_MODEL` | Default Gemini model for new workspaces (`gemini-3.8-flash`). |
| `CEREBRAS_API_KEY` | Enables Cerebras Cloud models. |
| `CEREBRAS_DIGITALROMANIAN` | Compatibility alias for `CEREBRAS_API_KEY`. |
| `AI_DEFAULT_CEREBRAS_MODEL` | Default Cerebras model (`gpt-oss-120b`). |
| `AI_DEFAULT_PROVIDER` | `cerebras`, `anthropic`, `openai`, or `gemini`: which default applies to new workspaces. If it has no key, another configured provider is used. |

Keys are server-only. The platform administrator can enter or replace them in **Agents → AI
settings**. The browser submits a key once over the authenticated same-origin API; the key is
encrypted with AES-256-GCM and stored in the deployment's private shared storage volume. It is
never returned to the browser, logged, or stored as plaintext. Both the API and worker pick up a
replacement without a redeploy.

Coolify runtime secrets remain supported as a fallback. A key saved through AI settings overrides
the matching `CEREBRAS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` environment variable. At startup the server
records only which providers are configured (booleans) and the platform default model.
`GET /api/health` and `/api/ready` report the same booleans.

Drive file bytes are stored on the server at
`/srv/cloud-data/dromanian-space/storage/drive`. PostgreSQL stores the logical folder tree,
ownership, versions and grants. A file belongs to its uploader and remains private until its owner
or an authorized editor shares it with a user, channel, project or the whole workspace.

## Workspace configuration (Agents → AI settings, admins)

- **Allowed models:** chosen from the catalog, grouped by provider. Models whose provider has no
  key on the server are marked "not configured".
- **Default model:** used for agents created later.
- **Switch every shared agent to the default model:** creates a new configuration version for each
  built-in or workspace-visible agent. Earlier runs keep the version they used, and private custom
  agents are left alone.
- **Per agent:** the agent's settings dialog chooses any allowed model.

Existing workspaces keep their settings when keys change. New workspaces start from the platform
default and the models of configured providers.

## Model catalog and cost estimates

`public.ai_models` lists models with USD prices per million tokens (input, output, cache read, cache
write). Each usage row in `ai_usage_ledger` gets its provider and an estimated `cost_usd` on insert.
A served snapshot id such as `gpt-5.4-2026-03-05` is priced by its most specific catalog entry.

- Claude list prices are seeded (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Haiku 4.5
  $1/$5; cache reads 0.1×, cache writes 1.25× input).
- **OpenAI prices are not seeded**, because they were not verifiable when this was written. Until
  you set them, OpenAI usage is recorded with tokens but no cost, and the settings dialog says so.
  The app never invents a price.

Set or update prices through an administrator PostgreSQL session:

```sql
UPDATE ai_models SET input_per_mtok = 1.25, output_per_mtok = 10, cache_read_per_mtok = 0.125
WHERE id = 'gpt-5.4';                              -- use the provider's current price list
INSERT INTO ai_models (id, provider, label, tier, input_per_mtok, output_per_mtok, sort_order)
VALUES ('gpt-6', 'openai', 'GPT-6', 'frontier', 5, 20, 45);   -- a model released later
```

Admins see this month's estimated spend per model under AI settings. Your provider invoice is
authoritative. Token budgets (`monthly_token_budget`, `per_user_daily_token_budget`) and the
concurrency limit apply to every provider.

## How each provider is called

Cerebras runs through the isolated Agno service using Agno's native Cerebras adapter and the model id `gpt-oss-120b`. The key remains server-only, tools return through the authenticated worker bridge, and persistent state continues to live in this deployment's database.

Gemini uses the streaming Interactions API from `@google/genai`, sends the stateless transcript on every turn, exposes workspace actions as function tools, and uses Google's search tool when web research is enabled. Agent effort maps to Gemini's thinking level.

| | Anthropic | OpenAI |
| --- | --- | --- |
| API | Messages API, streaming (`@anthropic-ai/sdk`) | Responses API, streaming (`openai`) |
| Conversation state | Sent in full each turn; thinking blocks passed back unchanged | Sent in full each turn (`store: false`); encrypted reasoning items passed back |
| Reasoning depth | `output_config.effort` (low … max), adaptive thinking | `reasoning.effort`; `max`/`xhigh` map to `xhigh` on gpt-5.2+ and `high` on older reasoning models; none for non-reasoning models |
| Tools | Agent tools as client tools with streamed inputs | Agent tools as function tools |
| Web research | `web_search` server tool | `web_search` tool |
| Reading the workspace site (SEO) | `web_fetch` restricted to the site's domain | `web_search` filtered to the site's domain |
| Refusals | `stop_reason: refusal`; optional server-side fallback | refusal content or content filter |

The engine is the same for all three. It handles:

- **Tool approval:** proposed actions become review cards and never execute without approval.
- **Validation:** every tool input is checked against its schema, and unreadable arguments are
  never executed.
- **Limits and cancellation:** step limits, time budget, cancellation and membership re-checks.
- **Persistence:** checkpoints, citations, execution logs, and token usage per run.

Both run statelessly inside the worker, so a run reclaimed by another worker restarts from its
persisted input.

## Errors, retries and rate limits

- **Retries and Gemini capacity fallback:** Anthropic and OpenAI use their SDK retry policies. Gemini starts with `gemini-3.8-flash`, then tries `gemini-3.6-flash` and `gemini-3.5-flash-lite` only when Google returns overload, temporary unavailability, a model-specific rate limit, or model unavailability. It never switches provider, and it never replays a request after text, a tool call, or a search became visible.
- **Errors after retries** are mapped to clear messages on the run (`auth`, `model_unavailable`,
  `rate_limited`, `overloaded`, `bad_request`, `unavailable`). OpenAI's "insufficient quota" is
  reported as a billing problem, not as rate limiting.
- **Missing provider:** a run whose model's provider has no key fails immediately with
  `provider_not_configured` and names the variable to set. Nothing is sent anywhere.
- **Cancellation** (Stop) aborts the provider request through the SDK's abort signal.
- **API limits:** the application API rate-limits per client: `API_RATE_LIMIT_PER_MINUTE` (default
  300) for all routes, and `API_AGENT_RATE_LIMIT_PER_MINUTE` (default 30) for starting runs.

## Data flow

Text an agent reads (documents, messages, CRM records it is allowed to open) and the user's
messages are sent to the provider that serves the agent's model. AI settings states this per
provider. With Voyage configured, indexed document text is also sent to Voyage for embeddings.
Everything else stays in this deployment's database and storage.

## Verification status

The OpenAI adapter is covered by deterministic tests against a scripted Responses API stream
(`tests/unit/openai-adapter.test.ts`): tool loop, reasoning replay, usage mapping, citations,
truncation, refusals, domain-filtered search, error mapping and cancellation. The Anthropic adapter
and the engine are covered by provider-double tests. The Gemini adapter has deterministic tests for model fallback and duplicate-stream prevention. On 2026-10-20, the production key was verified without exposing it: model listing succeeded, `gemini-3.6-flash` and `gemini-3.5-flash-lite` passed both Generate Content and Interactions requests, and `gemini-3.8-flash` correctly reported a temporary high-demand 503 that the fallback path now handles.

# Testing

## Test commands

| Command | Needs | Covers |
| --- | --- | --- |
| `npm run test:unit` | nothing | OpenAI adapter (scripted Responses stream), provider routing, startup configuration, rate limits, n8n signing and callback rules, vendored Supabase files, compose safety, migration ordering and additivity |
| `npm run db:check` | nothing (PGlite) | All migrations in order, plus behavioural checks of the 2026-10-19 migrations including an upgrade of an existing workspace |
| `npm test` | local PostgreSQL 17 + PostgREST (`npm run supabase:local -- start`) | Everything: unit, database and server suites |
| `deploy/test/run.sh` | Docker (for example on the server) | `npm test`, build, server bundle and lint inside a throwaway container with its own PostgreSQL 17, pgvector and PostgREST. No ports, no network, nothing persistent |

## Automated checks (2026-10-19)

On the Windows development machine (no PostgreSQL, no Docker):

- `npm run test:unit`: 42 pass.
- `npm run db:check`: 20 migrations applied, 42 checks pass.
- `npm run build`, `npm run build:server`, `npm run lint`: pass.

`tests/db/providers-automation.test.ts` is the PostgreSQL 17 counterpart of the PGlite checks, across
two independent workspaces. It covers:

- catalog access and server-only platform state;
- defaults and seeding on an OpenAI-only server;
- cost estimation;
- the admin bulk model switch;
- the expanded roster;
- automation keys: admin-only creation, secrets never readable by clients, one run per request id,
  no cross-workspace agents, admin-only execution log, revocation, and keys deactivated when their
  owner leaves.

On the production server (2026-10-19), `deploy/test/run.sh` (Node 24, PostgreSQL 17, pgvector and
PostgREST in a throwaway container): **167 of 167 tests pass in 14 files**, and the production
build, server bundle and lint pass. The first two runs found three defects, all fixed before
deployment:

- two definer helpers were callable by `anon`;
- a test still expected the old roster count;
- agents could be seeded with a different model than the workspace allowed if the platform default
  changed in between. Seeding now uses the settings row.

PGlite's socket server is not used for these suites: it multiplexes connections into one session,
so concurrent test transactions interleave.

## Automated checks (2026-10-05)

- `npm test`: 114 tests pass in ten files against local PostgreSQL 17/PostgREST/Auth/Storage emulation.
- `npm run build`: TypeScript client/server checks and Vite production bundle pass. Main-bundle size warning remains.
- `npm run lint`: completes without errors; existing unused-code, hook dependency and Fast Refresh warnings remain.
- `npm run types:platform`: generates 98 table and 301 function contracts.
- `npm run build:server`: bundles the API and worker entry points for the Docker image.

Tests cover the frozen baseline, cross-tenant authorization, legacy security fixes, queue leases/retries, scheduled delivery, Drive grants/revisions/uploads, authorized knowledge retrieval, persisted agent lifecycle/approvals, CRM and atomic message file references. Fixtures use distinct identities and workspaces; the preview account is preserved.

`tests/server/engine.test.ts` exercises real database/API plumbing with a deterministic provider double: source reading, persisted citation, document proposal and one-time approval. It also checks unauthenticated API rejection and missing-provider failure. This is not evidence of a live Anthropic completion.

`tests/db/team.test.ts` covers the twelve-role roster (retired built-ins archived, conversations still readable, mentions limited to active specialists), connector and AI-settings authorization, team delegation (same requester, one level deep, no coordinators or invisible/foreign agents, per-team budget, reuse after restart, source propagation, cancellation), clean restart of a reclaimed run, recovery only when no job will resume it, proposal deduplication, private personal notes (hidden from admins), visibility-scoped workspace metrics, calendar reads and reviewed calendar events blocked by private sources.

`tests/db/operations.test.ts` checks that each maintenance task has one scheduler (pg_cron when its job is active, otherwise the worker), that operations functions are not callable by users, and that worker heartbeats feed `/api/ready`.

`tests/server/team.test.ts` runs a full team chat through the engine with a provider double (specialists' citations renumbered into the coordinator's answer, authorship in the timeline, no per-specialist notifications), reattaches to a run as the requester and as another user, simulates a worker dying mid-run and a second worker resuming it through the job queue, and calls the AI status and mention endpoints with signed user tokens.

## Browser verification

The isolated preview account logged in through the real local sign-in form. Verified dashboard navigation, Drive document opening/editing/saving, explicit workspace sharing, and CRM contact creation with persisted notes/activity.

2026-10-05 (Playwright, Chromium): the Agents directory shows the twelve specialists and the Team Chat entry with per-agent readiness; an agent page shows readiness, tools with their approval policy and conversations; Send is disabled with the provider-missing reason; AI settings open for an owner; no horizontal overflow at 390 px. A team conversation produced by the provider double rendered in order with specialist authorship (that conversation was deleted afterwards and is not a live-model result). Screenshots: `docs/screenshots/`. The only console errors were Realtime websocket failures, expected because the local gateway has no Realtime.

Deployment assets are checked separately: `nginx -t` plus live requests through the rendered Nginx config, `deploy/migrate.sh` against a fresh database, `shellcheck` on all scripts and YAML parsing of the compose files (see `docs/DEPLOYMENT.md`).

## Reproduce

```sh
npm run supabase:local -- start
npm test
npm run build
npm run lint
npm run dev:local
```

On macOS the local adapter uses Homebrew PostgreSQL/PostgREST paths by default. State is under `.local/supabase`; logs are under `.local/supabase/logs`. Use `LOCAL_PG_BIN` / `LOCAL_POSTGREST_BIN` if binaries are installed elsewhere. Tests never target a hosted connection string.

## Remaining verification

No live Anthropic/Voyage call, hosted or self-hosted migration, Docker image build, Coolify deployment, or two-user Supabase Realtime test was performed. OAuth/email flows, full accessibility audit, large-file/load testing and complete acceptance coverage of the build prompt remain outstanding. The local gateway intentionally does not implement Realtime.

# Deployment

The supported target is Docker Compose on your own server, managed with Coolify, with self-hosted
Supabase. The installation sequence is in [COOLIFY_SETUP.md](COOLIFY_SETUP.md). Vercel, Railway and
hosted Supabase are not required.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | `web` target (Nginx, built SPA) and `server` target (Node API and worker), pinned base images |
| `docker-compose.yml` | Application resource: `web`, `api`, `worker` |
| `.env.production.example` | Application variables (build-time public values and server-only secrets) |
| `deploy/nginx/` | SPA fallback, uncached entry point, immutable assets, `/api/` proxy with streaming, security headers (HSTS, structural CSP) |
| `deploy/supabase/docker-compose.yml` | The complete pinned Supabase stack as a Coolify resource: fail-closed `/srv` data, no public database ports, private network alias, public route for browser APIs only |
| `deploy/supabase/.env.example`, `generate-env.sh` | Supabase variables and secret generation (pinned upstream generators) |
| `deploy/supabase/volumes/`, `utils/`, `UPSTREAM.md` | Vendored upstream configuration files with checksums |
| `deploy/supabase/traefik-dynamic.yml` | Fallback proxy route if the compose labels are not applied |
| `deploy/n8n/` | Optional, isolated n8n with its own PostgreSQL |
| `deploy/prepare-host.sh` | Read-only inventory; `--apply` creates data directories, mount markers and the network |
| `deploy/preflight.sh` | Read-only checks before migrating or deploying |
| `deploy/migrate.sh` | Transactional migration runner with checksums and drift detection |
| `deploy/backup/` | Encrypted backup, systemd timer, isolated restore check, restore into a fresh stack, full restore drill |
| `deploy/test/` | Full test suite in a disposable container (PostgreSQL 17, pgvector, PostgREST) |

## Verification log

2026-10-19 (development machine: Windows, Node 22; no Docker, no server access):

- **Checks:**
  - `npm run build`, `npm run build:server` and `npm run lint` pass (no new lint warnings).
  - Server and client TypeScript checks pass.
- **Unit suite:** `npm run test:unit` passes 42 tests, with no database and no network. They cover:
  - the OpenAI adapter against a scripted Responses stream;
  - provider routing and startup configuration checks;
  - rate limiting and n8n request signing;
  - vendored-file checksums;
  - compose safety properties;
  - migration ordering and additivity.
- **Migrations:** `npm run db:check` applies all 20 migrations in order to an in-memory PostgreSQL
  (PGlite 0.5.10: PostgreSQL 18.6 compiled to WebAssembly, with pgvector, pgcrypto, pg_trgm and
  uuid-ossp; pg_cron stubbed as in the local harness). 42 behavioural checks of the new migrations
  pass:
  - upgrading a pre-existing workspace: untouched agents refocused, a customized agent left alone,
    usage costs backfilled;
  - an OpenAI-only server: new workspaces, seeded agents and a run start;
  - cost estimation;
  - the admin bulk model switch;
  - the roster;
  - automation-key permissions, idempotency and isolation between two workspaces.

  This is a different PostgreSQL major version than production (17.6), so it validates SQL and
  behaviour, not the production image.
- **Supabase environment:** `deploy/supabase/generate-env.sh` produced a complete environment with
  the pinned upstream generators, and refused to overwrite it on a second run.
- **YAML:** the compose and override files parse with unique keys. Every required variable is
  documented, and no service publishes ports beyond loopback.
- **Shell:** all shell scripts pass `bash -n` and ShellCheck at warning level.

Earlier (2026-10-05, macOS): `nginx -t` and live requests through the Nginx config, an
authenticated agent run through Nginx to API and worker, `/api/ready`, and the migration runner
against a fresh database.

**Not yet verified** (needs the server): Docker image builds, Coolify deployment of the three
resources, the Supabase stack on its pinned images, the existing database and server test suites on
PostgreSQL 17 (`deploy/test/run.sh`), Auth email/OAuth, Storage, Realtime through the proxy, backups
and restore drills against real containers, live Anthropic and OpenAI requests, and two-user
behaviour on the deployed site.

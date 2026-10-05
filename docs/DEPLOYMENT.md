# Deployment

The supported target is Docker Compose on your own server, managed with Coolify, with self-hosted Supabase. The full procedure (first deployment, verification, backups and restore, upgrades, diagnosis, rollback and recovery) is in [SELF_HOSTING.md](SELF_HOSTING.md). Vercel is not supported or required.

Nothing has been deployed by this implementation, and the Docker images have not been built (no server access; no Docker on the development machine).

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | `web` target (Nginx, built SPA) and `server` target (Node API and worker) with pinned base images |
| `docker-compose.yml` | Application resource for Coolify: `web`, `api`, `worker` |
| `deploy/nginx/` | Nginx template: SPA fallback, uncached entry point, immutable assets, `/api/` proxy with streaming |
| `deploy/supabase/` | Overrides for the pinned Supabase release (data on `/srv/...` with a fail-closed mount guard, private network, no public database ports) and the Coolify proxy route |
| `deploy/prepare-host.sh` | Read-only server inventory; `--apply` creates data directories, mount markers and the network |
| `deploy/migrate.sh` | Applies `supabase/migrations` in order, compatible with the Supabase CLI's bookkeeping |
| `deploy/backup/` | Encrypted backup (database, file bytes, configuration) and isolated restore check |
| `.env.example` | Public and server-only variables (placeholders only) |

## Verified locally (2026-10-05)

- `npm run build` and `npm run build:server`; the bundled API and worker run on Node 24.
- The Nginx configuration rendered from `deploy/nginx/default.conf.template` passed `nginx -t` (nginx 1.31.6, Homebrew) and served the built SPA: deep links return `index.html` with `no-cache`; `/assets/*` are immutable and gzip-compressed; missing assets return 404; unknown `/api/*` routes return the API's JSON 404; Nginx's request ID reaches the API.
- An authenticated `POST /api/agents/run` through Nginx was queued by the API, executed by the separate worker and streamed back. Without a provider key it ended as `provider_not_configured`.
- `/api/ready` reported the database, a fresh worker heartbeat and queue lag.
- `deploy/migrate.sh` applied all migrations to a fresh database (through a stand-in for `docker exec`), recorded them, and a second run made no changes. All shell scripts pass `shellcheck`.
- The compose, override and proxy YAML files parse; resource limits, log rotation, networks and port overrides resolve as intended.

Not verified: image builds, Coolify, the pinned Supabase stack, backups and restores against real containers, live model calls, email, OAuth, Realtime through the proxy and two-user behavior on the server.

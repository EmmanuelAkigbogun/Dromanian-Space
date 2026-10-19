# Self-hosting Dromanian Space

Dromanian Space runs on your own Ubuntu server under Coolify, with self-hosted Supabase. There is no
dependency on Vercel, Railway or hosted Supabase.

| Guide | Use it for |
| --- | --- |
| [COOLIFY_SETUP.md](COOLIFY_SETUP.md) | The installation sequence: prerequisites, DNS, storage, secrets, Supabase, migrations, app, first admin, verification, backups, troubleshooting |
| [DATABASE.md](DATABASE.md) | Migrations: clean install, upgrades, moving from the old hosted project |
| [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) | Backup contents, restore drills, recovery scenarios |
| [AI_PROVIDERS.md](AI_PROVIDERS.md) | Anthropic and OpenAI configuration, models, costs |
| [AUTOMATION.md](AUTOMATION.md) | Optional n8n integration and its license |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Files in `deploy/` and what has been verified |

## Layout

| Piece | What it is | Exposure |
| --- | --- | --- |
| Coolify proxy | Traefik: HTTPS and certificates | Public ports 80/443 |
| `web` | `nginxinc/nginx-unprivileged:1.30.5-alpine`: SPA and `/api/` proxy (streaming) | `space.digitalromanian.com` |
| `api` | Node 24 (`node:24.15.0-bookworm-slim`), `dist-server/main.mjs` | Internal, through `web` |
| `worker` | Same image, `dist-server/worker-main.mjs`: agent runs, indexing, Drive purge, maintenance, automation callbacks | No port |
| Supabase | `deploy/supabase/docker-compose.yml`: the pinned upstream release (`ff80bb1`, PostgreSQL 17.6) with fail-closed `/srv` data paths | Gateway on `supabase-space.digitalromanian.com`, browser API paths only |
| Studio | Supabase dashboard | Private: `ssh -L 8000:127.0.0.1:8000 <server>` |
| n8n (optional) | `deploy/n8n/docker-compose.yml` with its own PostgreSQL | `n8n.digitalromanian.com` |

The resources have separate lifecycles: Supabase is stateful and rarely changed; the app is
stateless and redeployed freely. They share the private Docker network `dromanian-supabase`; the app
reaches Supabase at `http://supabase-gateway:8000`, while browsers use the public HTTPS URL.

## Persistent data

```text
/srv/app-data/dromanian-space/      (dedicated disk)
    config/                 secrets and environment files (700)
    supabase/db/data/       PostgreSQL
    supabase/db/config/     pgsodium key, image config
    backup-staging/         encrypted backups (700)
    n8n/                    optional
/srv/cloud-data/dromanian-space/    (dedicated disk)
    storage/                uploaded file bytes
```

Each disk carries a `.dromanian-space-mount` marker. The `mount-guard` service and
`create_host_path: false` keep the database and storage from starting if a disk is missing, so
nothing is ever written to an empty mountpoint on the system disk.

## Operating rules

- Never run `docker compose down -v`, `supabase db reset`, volume pruning, or destructive SQL
  against production. Never delete Coolify resources with "delete volumes".
- Before every migration or Supabase change: `deploy/preflight.sh` (checks the target, mounts,
  services, migration history and a fresh backup), then `deploy/migrate.sh apply`.
- Restore tests always use the isolated drill stack (`deploy/backup/restore-test.sh`), never
  production.
- Calls between people on different networks may need a TURN server. The call feature uses public
  STUN servers only; test across networks before relying on it.

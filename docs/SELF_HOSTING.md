# Self-hosting Dromanian Space (Coolify)

This guide follows `Dromanian-Space-Self-Hosting-Addendum.md`. Nothing in it has been run on your server: there was no server access, and Docker was not available on the development machine. Every step is written so you can run it one command at a time and check the result before continuing. Never paste secrets into chat or commit them to Git.

## 1. Layout

| Piece | What it is | Exposure |
| --- | --- | --- |
| Coolify proxy | Your existing Traefik ingress (HTTPS, certificates) | Public (or private network) |
| `web` | `nginxinc/nginx-unprivileged:1.30.5-alpine` serving the SPA; `/api/` proxied to `api` before the SPA fallback | App domain via the Coolify proxy |
| `api` | Node 24 (`node:24.15.0-bookworm-slim`), `dist-server/main.mjs` | Internal only, through `web` |
| `worker` | Same image, `dist-server/worker-main.mjs`; agent runs, indexing, Drive purge, fallback maintenance | No port |
| Supabase | Pinned upstream self-hosted release (below), separate resource | Gateway via the Coolify proxy on its own hostname, API paths only |
| Supabase Studio | Database administration | Not routed publicly; SSH tunnel or Tailscale |

Two resources, two lifecycles: the **Supabase stack** (stateful, rarely changed) and the **application Compose resource** (`docker-compose.yml`: web, api, worker; stateless, redeployed freely). They share the private Docker network `dromanian-supabase`; the app reaches Supabase at `http://supabase-gateway:8000`. Browsers always use the public HTTPS URL.

Proposed hostnames (configure DNS yourself): `space.digitalromanian.com` for the app and `/api/*`, `supabase-space.digitalromanian.com` for the browser-reachable Supabase gateway.

**Supabase release reference.** `supabase/supabase` commit `ff80bb14991e68667c04f74248b954e8babe6fde` (`docker/`, 2026-09-30): `supabase/postgres:17.6.1.136`, `supabase/gotrue:v2.196.0`, `postgrest/postgrest:v14.17`, `supabase/realtime:v2.134.10`, `supabase/storage-api:v1.74.0`, `envoyproxy/envoy:v1.39.1` as the API gateway (`api-gw`, aliased `kong`). The overrides in `deploy/supabase/` match this release's service names. If you use Coolify's Supabase template instead, record its version and adapt the overrides; its service names, gateway and key names can differ.

**Capacity (planning estimate, not a guarantee):** about 4 CPU cores and 16 GB RAM for Supabase plus this app with an external model API, leaving headroom for what already runs on the server. Supabase documents 4+ cores and 8+ GB RAM for its own stack. Measure, then lower `WORKER_CONCURRENCY` if needed.

## 2. First deployment

Run as an administrator who can use Docker, from a checkout of this repository on the server (for example `/srv/app-data/dromanian-space/repo`).

### 2.1 Inventory (read-only)

```sh
deploy/prepare-host.sh
```

It prints the CPU architecture and cores, memory, Docker and Compose versions (Compose 2.24.4 or newer is required), running containers, listening ports and whether `/srv/app-data` and `/srv/cloud-data` are dedicated mounts with free space. It prints no secrets and changes nothing. Note what already uses ports 80/443 (Coolify's proxy) and anything Mattermost or other services own; nothing below touches them.

### 2.2 Storage and network

Only when both data paths are real mounts:

```sh
deploy/prepare-host.sh --apply
```

This creates `/srv/app-data/dromanian-space/{supabase/db/data,config,backup-staging}` and `/srv/cloud-data/dromanian-space/storage`, writes a `.dromanian-space-mount` marker on each disk, and creates the `dromanian-supabase` Docker network. It refuses to run if either path sits on the system disk. It never formats, repartitions or changes ownership recursively.

**Fail closed:** the Supabase override binds data with `create_host_path: false`, and a `mount-guard` container checks both markers. If a disk is missing after a reboot, the database and storage containers do not start, instead of creating an empty database on the system disk.

### 2.3 Supabase

```sh
mkdir -p /srv/app-data/dromanian-space/config/supabase-src
cd /srv/app-data/dromanian-space/config/supabase-src
git init -q && git remote add origin https://github.com/supabase/supabase.git
git fetch --depth 1 origin ff80bb14991e68667c04f74248b954e8babe6fde && git checkout -q FETCH_HEAD
cp -r docker ../supabase && cd ../supabase
cp /srv/app-data/dromanian-space/repo/deploy/supabase/docker-compose.override.yml .
cp .env.example .env && chmod 600 .env
sh utils/generate-keys.sh --update-env
sh utils/add-new-auth-keys.sh
```

Then edit `.env` (it stays in the protected config directory, outside Git):

- `SUPABASE_PUBLIC_URL` and `API_EXTERNAL_URL`: `https://supabase-space.digitalromanian.com`
- `SITE_URL`: `https://space.digitalromanian.com`; `ADDITIONAL_REDIRECT_URLS`: `https://space.digitalromanian.com/**`
- `SMTP_*` and `SMTP_ADMIN_EMAIL`: a real SMTP account (invitations, confirmation, password reset). Leave `ENABLE_EMAIL_AUTOCONFIRM=false` once SMTP works.
- Dashboard credentials: change them.
- Google/GitHub sign-in (optional): add the provider settings to the `auth` service; callback `https://supabase-space.digitalromanian.com/auth/v1/callback`.

Copy the link-preview function: `cp -r /srv/app-data/dromanian-space/repo/supabase/functions/fetch-link-preview volumes/functions/`.

Start it (restart policies bring it back after reboots):

```sh
docker compose up -d
docker compose ps
```

`docker compose` reads `docker-compose.override.yml` automatically. Upstream's logging container mounts the Docker socket for Supabase's own logs; the application containers never do.

**Proxy route.** In Coolify: Servers → Proxy → Dynamic configuration, add `deploy/supabase/traefik-dynamic.yml` (check the entry point and certificate resolver names your proxy uses). Only `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1` and `/functions/v1` are public. Studio stays private: `ssh -L 8000:127.0.0.1:8000 <server>` and open `http://localhost:8000`, or use Tailscale.

Check the gateway and Realtime from outside: `curl -s -o /dev/null -w '%{http_code}\n' https://supabase-space.digitalromanian.com/auth/v1/health`, and confirm a websocket connects in the browser's developer tools once the app runs (Realtime needs websocket upgrades through the proxy).

### 2.4 Database migrations

Back up first if the database holds anything (section 4). Store the database password in a file in the config directory (`chmod 600`), then:

```sh
cd /srv/app-data/dromanian-space/repo
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/migrate.sh status
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/migrate.sh apply
```

Each file runs in its own transaction with its bookkeeping row, and the first error stops the run. Moving an existing hosted project: restore its dump first (Supabase's backup-and-restore guide), copy its Storage objects, then `deploy/migrate.sh mark-applied 20261004000000` (only after confirming the legacy schema is present, see `docs/DATABASE.md`) and `apply`.

### 2.5 The application in Coolify

1. New resource from this Git repository with the **Docker Compose** build pack.
2. Environment variables (mark the `VITE_*` ones as build variables):

| Variable | Scope | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | build, public | `https://supabase-space.digitalromanian.com` |
| `VITE_SUPABASE_ANON_KEY` | build, public | `SUPABASE_PUBLISHABLE_KEY` (or the legacy `ANON_KEY`) from Supabase's `.env` |
| `VITE_APP_URL` | build, public | `https://space.digitalromanian.com` |
| `SUPABASE_URL` | server | `http://supabase-gateway:8000` (default) |
| `SUPABASE_SECRET_KEY` | server, secret | Supabase `SUPABASE_SECRET_KEY` (or the legacy `SERVICE_ROLE_KEY`) |
| `ANTHROPIC_API_KEY` | server, secret | Optional. Without it, agents show a setup state |
| `VOYAGE_API_KEY` | server, secret | Optional semantic search |
| `WORKER_CONCURRENCY` | worker | Default 4 |

   Public values are compiled into the bundle: changing them later requires a rebuild, not just a restart.
3. Network: the compose file joins the external `dromanian-supabase` network. Confirm in Coolify that the deployed `api` and `worker` containers are attached to it (`docker network inspect dromanian-supabase`); depending on the Coolify version you may instead need its "Connect to predefined network" option. Check the attachment survives a redeploy.
4. Domain: `https://space.digitalromanian.com` on the `web` service, port `8080`.
5. Deploy, then check: `curl -s https://space.digitalromanian.com/api/health` (liveness) and `curl -s https://space.digitalromanian.com/api/ready` (database, worker heartbeat, queue lag; 503 until a worker has reported).

Every container has restart policies, health checks, CPU/memory limits, bounded log rotation (10 MB × 5), dropped capabilities and `no-new-privileges`; `api` and `worker` run read-only as the `node` user.

## 3. Verification (acceptance checks)

1. **No Vercel:** the app builds and runs from this compose file alone.
2. **Through the real hostnames:** open a deep link (for example `/agents/team`) directly; an unknown `/api/x` returns JSON 404; sign up and confirm by email; reset a password; upload and download a Drive file; chat in two browsers to see Realtime updates; run an agent and watch it stream.
3. **Isolation:** with two users in different workspaces, confirm neither can see the other's channels, files, search results or agent answers (direct API, Storage URLs and Realtime included).
4. **Redeploys and restarts:** redeploy the app; records and files remain. Start a long agent run, then `docker restart <worker>`: the run resumes on the restarted worker within about two minutes, without duplicate review cards.
5. **Mounts:** in an agreed maintenance window, reboot; confirm `mount-guard` ran and Supabase came back with its data. Unmount a data disk on a test machine to see the stack refuse to start.
6. **Restore:** run the restore check (section 4) and, periodically, the full isolated-stack restore.
7. **Neighbours:** Mattermost and other services keep their ports, data and availability.
8. **Honest configuration:** without `ANTHROPIC_API_KEY` the Agents page says the provider is not configured; without SMTP, sign-up emails fail visibly in Supabase's Auth logs.

Calls: the existing call feature uses public STUN servers only. Calls between people on different networks may need a TURN server; test across networks before relying on it.

## 4. Backups and restore

Install `age` (and `rclone` for an off-server copy). Create an age key pair **off the server**, keep the private key offline, and put only the public key on the server:

```sh
age-keygen -o dromanian-space-backup.key            # on your own machine
age-keygen -y dromanian-space-backup.key > recipients.txt
```

Copy `recipients.txt` to `/srv/app-data/dromanian-space/config/backup-recipients.txt`. Daily backup (for example a systemd timer or cron at 02:30), keeping 14 local days and one encrypted copy on a different physical device or remote:

```sh
AGE_RECIPIENTS_FILE=/srv/app-data/dromanian-space/config/backup-recipients.txt \
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-admin-password \
WORKER_CONTAINER=<worker container name> RCLONE_REMOTE=offsite:dromanian-space \
deploy/backup/backup.sh
```

The archive holds a logical database dump (`pg_dump` custom format plus roles), the uploaded file bytes, the protected configuration (Supabase `.env`, app variables you keep there) and a checksum manifest. The worker is paused briefly so no file is purged mid-backup. Copying a live Postgres data directory is not a backup.

Restore check (isolated, production untouched):

```sh
AGE_IDENTITY_FILE=dromanian-space-backup.key deploy/backup/verify-restore.sh dromanian-space-<stamp>.tar.age
```

It restores into a throwaway Postgres with no network, prints record counts and checks that sampled Storage objects have their bytes. For the full check, bring up a second Supabase stack in a separate directory and Compose project name (no proxy route, its own empty data paths), restore the database and storage files into it, point a local copy of the app at it, then sign in and open a document. Record the date and the recovery point you achieved.

## 5. Upgrades

- **App:** merge, redeploy in Coolify. Apply new migrations (`deploy/migrate.sh apply`) before or with the deploy that needs them; migrations are additive.
- **Supabase:** read the upstream changelog, back up, pick a new commit, repeat 2.3 in a new directory on staging, compare `docker-compose.yml` service names with the override, then switch. Never mix `.env` templates from different releases without comparing them.
- **Base images:** update the pinned tags in `Dockerfile` deliberately and redeploy.

## 6. Diagnosis

- `GET /api/ready`: `worker: no recent heartbeat` means no worker has reported in two minutes; `queue: oldest due job waiting …` means jobs are piling up. It also shows which scheduler runs each maintenance task (`pg_cron` or `worker`).
- Logs: `docker logs <api>` (one JSON line per request with `request_id`, also returned as `x-request-id`), `docker logs <worker>` (job outcomes, maintenance).
- Queue, inside the database: `SELECT kind, status, count(*) FROM jobs GROUP BY 1, 2;` and `SELECT kind, last_error FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 20;`
- `mount-guard` exited with an error: a data disk is not mounted; mount it, then `docker compose up -d` again.
- Agents say the provider is not configured: set `ANTHROPIC_API_KEY` on both `api` and `worker` and redeploy.
- Sign-in redirects to the wrong place: check `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` and `VITE_APP_URL`.

## 7. Rollback and recovery

- **App rollback:** redeploy the previous commit in Coolify. Data is untouched; schema changes are additive, so the previous version keeps working.
- **Database rollback:** restore from backup into a fresh data directory (stop Supabase, move the current data aside, restore, start). This loses changes since the backup; prefer fixing forward when possible.
- **Worker crash or restart:** automatic. Leases expire, jobs resume; agent runs restart from their persisted input; stale runs without a live job are marked interrupted for the user to retry.
- **Host reboot:** Docker restarts both stacks; `mount-guard` prevents starting without the data disks.
- **Disk pressure:** container logs are capped; check `docker system df` and backup staging retention. Do not run destructive volume pruning as routine maintenance.
- **Lost server:** provision a new host, follow section 2 up to 2.3, restore the latest off-server backup, run `deploy/migrate.sh status`, deploy the app.

## 8. Scheduling and AI

Each maintenance task has one scheduler: `pg_cron` (included in the Supabase image) when its job is active, otherwise the worker. The browser never delivers scheduled messages. `GET /api/ready` shows the current assignment.

Models run through an external provider (Anthropic) and, optionally, Voyage for embeddings; nothing requires a GPU. Text from sources an agent reads is sent to that provider; workspace admins see this statement under Agents → AI settings. The provider adapter allows a local model later, after checking CPU, RAM, GPU and concurrency; changing the embedding model requires re-indexing.

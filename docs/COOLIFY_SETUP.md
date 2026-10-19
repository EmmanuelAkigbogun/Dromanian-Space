# Coolify setup

The exact sequence for a production installation of Dromanian Space on an Ubuntu server with
Coolify and self-hosted Supabase. Each step is marked:

- **Automatic**: done by the repository's configuration (compose files, scripts, migrations).
- **Manual**: an administrator does it once, by hand.

Never paste secrets into chat or commit them. Never run `docker compose down -v`, delete Coolify
resources with "delete volumes", or remove anything under `/srv` on a running installation.

## 0. What gets deployed

| Coolify resource | Source | Services | State |
| --- | --- | --- | --- |
| **Supabase** | this repo, base directory `/deploy/supabase` | db (PostgreSQL 17), auth, rest, realtime, storage, imgproxy, meta, functions, supavisor, api-gw (Envoy), studio, mount-guard | Persistent: `/srv/app-data/dromanian-space`, `/srv/cloud-data/dromanian-space` |
| **Application** | this repo, base directory `/` | web (Nginx + SPA), api (Node), worker (Node) | Stateless; redeploy freely |
| **n8n** (optional) | this repo, base directory `/deploy/n8n` | n8n, its own PostgreSQL | `/srv/app-data/dromanian-space/n8n` |

```text
Internet ─▶ Coolify proxy (Traefik, HTTPS)
             ├─ space.digitalromanian.com ─────────▶ web:8080 ─▶ /api/* ─▶ api:3000
             └─ supabase-space.digitalromanian.com ─▶ api-gw:8000  (only /auth /rest /realtime /storage /functions)
Private network "dromanian-supabase": api, worker ─▶ supabase-gateway:8000 (alias of api-gw)
PostgreSQL, the pooler, Studio and the worker have no public route.
```

## 1. Prerequisites and capacity — Manual

- Ubuntu server with Coolify v4 installed and its proxy (Traefik) running.
- Docker Engine with Compose **2.24.4 or newer**.
- Two dedicated disks mounted at `/srv/app-data` (database) and `/srv/cloud-data` (uploaded files).
- At least **4 CPU cores and 16 GB RAM** for Supabase plus the app (Supabase alone documents 4 cores / 8 GB).
  Add 1 core / 1 GB for n8n. External model APIs mean no GPU is needed.
- `git`, `openssl`, `curl`, `age` (backups) and `rclone` (off-server copies) on the host.
- The repository checked out on the server for the scripts, for example:
  `git clone https://github.com/EmmanuelAkigbogun/Dromanian-Space /srv/app-data/dromanian-space/repo`
  (after step 3 created the directory).

Inventory, read-only (**Automatic** checks, changes nothing):

```sh
cd /srv/app-data/dromanian-space/repo   # or any checkout
deploy/prepare-host.sh
```

It prints CPU/RAM (with warnings below the guidance), Docker/Compose versions, running containers,
listening ports and whether `/srv/app-data` and `/srv/cloud-data` are real mounts with free space.
Note what already uses ports 80/443 (Coolify's proxy) and what else runs on the server; nothing
below touches other services.

## 2. DNS — Manual

Create these records at your DNS provider (they are not assumed to exist):

| Name | Type | Value |
| --- | --- | --- |
| `space.digitalromanian.com` | A (and AAAA if the server has IPv6) | the server's public IP |
| `supabase-space.digitalromanian.com` | A (and AAAA) | the server's public IP |
| `n8n.digitalromanian.com` (optional) | A (and AAAA) | the server's public IP |

Ports 80 and 443 must reach Coolify's proxy (Let's Encrypt uses port 80). Check with
`dig +short space.digitalromanian.com` before deploying.

## 3. Storage and network — Manual (one command), Automatic guards

Only when both data paths are real mounts:

```sh
sudo deploy/prepare-host.sh --apply              # add --with-n8n if you will run n8n
```

It refuses to run if either path is on the system disk. It creates:

```text
/srv/app-data/dromanian-space/
    .dromanian-space-mount        marker checked by the mount guard
    config/                       (700) secrets and environment files
    supabase/db/data/             PostgreSQL data
    supabase/db/config/           pgsodium key and the image's custom config
    backup-staging/               (700) encrypted backups
    n8n/{db,data}/                (--with-n8n)
/srv/cloud-data/dromanian-space/
    .dromanian-space-mount
    storage/                      uploaded file bytes
```

and the Docker network `dromanian-supabase`. It never formats, repartitions or recursively changes
ownership.

**Automatic fail-closed guard:** every data bind uses `create_host_path: false`, and the `mount-guard`
container must find both marker files before `db`, `storage` and `imgproxy` start. If a disk is missing
after a reboot, Supabase stays down instead of creating an empty database on the system disk.

## 4. Supabase secrets — Manual (one command)

```sh
deploy/supabase/generate-env.sh          # writes /srv/app-data/dromanian-space/config/supabase.env (600)
```

This runs the pinned upstream generators and fills all 17 secrets: database password, JWT secret,
legacy and asymmetric keys, publishable and secret API keys, and encryption keys. It refuses to
overwrite an existing file. Then edit that file:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME`:
  a real SMTP account. Sign-up confirmation, invitations and password reset depend on it.
  Email confirmation stays **on** (`ENABLE_EMAIL_AUTOCONFIRM=false`).
- Check the URLs:
  - `SUPABASE_PUBLIC_URL=https://supabase-space.digitalromanian.com`
  - `API_EXTERNAL_URL=https://supabase-space.digitalromanian.com/auth/v1` (with `/auth/v1` in this release)
  - `SITE_URL=https://space.digitalromanian.com`
  - `ADDITIONAL_REDIRECT_URLS=https://space.digitalromanian.com/**`
- Optional Google/GitHub sign-in: set `GOOGLE_ENABLED=true` and the client id and secret.
  Register the callback `https://supabase-space.digitalromanian.com/auth/v1/callback` with the provider.

Also store the database password for the scripts:
`grep ^POSTGRES_PASSWORD= supabase.env | cut -d= -f2- > /srv/app-data/dromanian-space/config/db-password && chmod 600 …/db-password`.

## 5. Deploy Supabase in Coolify — Manual (UI), Automatic stack

1. **+ New → Resource →** your Git source (public repository, or the GitHub App if it is private).
   Choose this repository and branch.
2. **Build pack: Docker Compose.** Set **Base Directory** to `/deploy/supabase` and
   **Docker Compose Location** to `/docker-compose.yml`.
3. **Environment Variables:** paste the contents of `supabase.env` with the Developer view, and mark
   the secrets as secret.
4. **Domains:** leave every service **without** a domain. The `api-gw` service carries its own
   Traefik labels that expose only `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1` and
   `/functions/v1` on `supabase-space.digitalromanian.com`.
5. Deploy.

Then verify on the server:

```sh
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'supabase|realtime'     # all (healthy)
docker inspect supabase-db -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
#   /srv/app-data/dromanian-space/supabase/db/data -> /var/lib/postgresql/data
#   /srv/app-data/dromanian-space/supabase/db/config (as volume db-config) -> /etc/postgresql-custom
ls /srv/app-data/dromanian-space/supabase/db/config        # pgsodium key and supautils config were copied in
docker network inspect dromanian-supabase -f '{{range .Containers}}{{.Name}} {{end}}'   # supabase-envoy
curl -s -o /dev/null -w '%{http_code}\n' https://supabase-space.digitalromanian.com/auth/v1/health   # 401 or 200
curl -s -o /dev/null -w '%{http_code}\n' https://supabase-space.digitalromanian.com/                 # 404: Studio is not public
```

If the public checks fail, Coolify may have dropped the custom labels. In that case, add
`deploy/supabase/traefik-dynamic.yml` under **Servers → Proxy → Dynamic configuration**, after
checking its entry-point and resolver names.

**Studio** (database admin) is private. Open it with
`ssh -L 8000:127.0.0.1:8000 <server>` and then `http://localhost:8000`, using the dashboard
username and password from `supabase.env`.

**Without Coolify** (fallback): `cp …/supabase.env deploy/supabase/.env` in a checkout, then
`cd deploy/supabase && docker compose up -d`.

## 6. Database initialization — Manual (two commands), Automatic safety

```sh
cd /srv/app-data/dromanian-space/repo
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/preflight.sh
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/migrate.sh apply
```

**Automatic:** `preflight.sh` checks the following, read-only:

- the target host;
- Docker and Compose versions;
- mounts, markers, free space and directory permissions;
- the network, and that the gateway is reachable on it;
- Supabase container health;
- that PostgreSQL publishes no public port;
- database connectivity and the required extensions (vector, pg_cron, pgcrypto, pg_trgm, uuid-ossp);
- migration-history consistency;
- backup freshness (not required for a fresh install with no tables).

`migrate.sh` applies each file and its bookkeeping in one transaction, stops at the first error,
records a checksum per file, and refuses to run on:

- edited, unknown or out-of-order versions;
- an existing database that has no migration history (the legacy baseline must never be replayed).

| Situation | Path |
| --- | --- |
| **Clean install** (empty database) | `migrate.sh apply` applies all files, including the legacy baseline. |
| **Existing installation** (this stack, already migrated) | Back up (section 10), `preflight.sh`, `migrate.sh apply`: only pending files run. |
| **Moving from the old hosted project** | Restore its dump into this stack first, verify the legacy schema is present, `migrate.sh mark-applied 20261004000000`, then `apply`. See [DATABASE.md](DATABASE.md). |

## 7. Deploy the application in Coolify — Manual (UI), Automatic build

1. **+ New → Resource →** the same repository. **Build pack: Docker Compose**, base directory `/`,
   compose file `/docker-compose.yml`.
2. **Environment Variables** (see `.env.production.example`):

   | Variable | Coolify flag | Value |
   | --- | --- | --- |
   | `VITE_SUPABASE_URL` | Build variable | `https://supabase-space.digitalromanian.com` |
   | `VITE_SUPABASE_ANON_KEY` | Build variable | `SUPABASE_PUBLISHABLE_KEY` from `supabase.env` |
   | `VITE_APP_URL` | Build variable | `https://space.digitalromanian.com` |
   | `VITE_APP_NAME` | Build variable | `Dromanian Space` |
   | `SUPABASE_URL` | runtime | `http://supabase-gateway:8000` |
   | `SUPABASE_SECRET_KEY` | runtime, secret | `SUPABASE_SECRET_KEY` from `supabase.env` |
   | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | runtime, secret | one or both ([AI_PROVIDERS.md](AI_PROVIDERS.md)) |
   | `AI_DEFAULT_PROVIDER` | runtime | `anthropic` or `openai` |
   | `AI_DEFAULT_ANTHROPIC_MODEL` / `AI_DEFAULT_OPENAI_MODEL` | runtime | `claude-opus-5-5` / `gpt-5.4` |
   | `VOYAGE_API_KEY` | runtime, secret | optional semantic search |
   | `WORKER_CONCURRENCY` | runtime | `4` (lower on small servers) |
   | `N8N_BASE_URL` | runtime | optional, `https://n8n.digitalromanian.com` |

   `VITE_*` values are compiled into the browser bundle: changing them needs a **rebuild**. Never
   put a secret in a `VITE_` variable; the API and worker refuse to start if one exists.
3. **Network:** the compose file joins the external `dromanian-supabase` network. After deploying,
   confirm with `docker network inspect dromanian-supabase` that the `api` and `worker` containers
   are attached. If your Coolify version does not attach them, enable "Connect to predefined
   network" and check that the attachment survives a redeploy.
4. **Domain:** on the `web` service set `https://space.digitalromanian.com:8080` (the `:8080` tells
   Coolify the container port; the public site stays on 443).
5. Deploy.

**Automatic:**

- Images build from the pinned `Dockerfile`; `web` waits for a healthy `api`.
- Every container has a restart policy, a health check, CPU and memory limits, log rotation
  (10 MB × 5), dropped capabilities and `no-new-privileges`; `api` and `worker` run read-only as
  `node`.
- On start, `api` and `worker`:
  - validate their configuration and exit with a clear log line if it is wrong;
  - wait for the database with backoff;
  - record which AI providers are configured (booleans only).

## 8. Initial administrator setup — Manual

1. Open `https://space.digitalromanian.com`, sign up with your email, and confirm it from the email.
   No email means SMTP is wrong: check `docker logs supabase-auth`.
2. Create your workspace. You are its owner, and the specialists and Team Lead are created
   automatically.
3. **Agents → AI settings:**
   - check that the providers you configured show as configured;
   - choose the allowed models and the default;
   - optionally switch every shared agent to that model;
   - set the brand kit folder and the site address, and decide on web research.
4. Optional: to stop public sign-up after inviting your team, set `DISABLE_SIGNUP=true` on the
   Supabase resource and redeploy it. Invitations still work.

## 9. Health checks and post-deployment verification

```sh
curl -s https://space.digitalromanian.com/api/health   # liveness, database reachability, providers configured
curl -s https://space.digitalromanian.com/api/ready    # 200 only with database, fresh worker heartbeat and queue lag ok
APP_URL=https://space.digitalromanian.com SUPABASE_PUBLIC_URL=https://supabase-space.digitalromanian.com \
  PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/preflight.sh
```

Acceptance checklist (record date and result):

- [ ] Deep link `https://space.digitalromanian.com/agents/team` loads; unknown `/api/x` returns JSON 404.
- [ ] Sign-up email arrives; confirmation and password reset work; sign-out and sign-in work.
- [ ] Upload and download a Drive file. Redeploy the app, and the file is still there.
- [ ] Two browsers in the same channel see each other's messages live (Realtime over WebSocket).
- [ ] An agent answers with each configured provider (pick its model in the agent's settings).
- [ ] A second user in a **different workspace** cannot see the first workspace's channels, files,
      search results, agents' answers or Storage URLs.
- [ ] `docker restart <worker>` during a long agent run: the run resumes within about two minutes.
- [ ] Reboot in a maintenance window: everything comes back healthy and `mount-guard` exited 0.
- [ ] A backup completes and the restore drill passes (section 10).

Full test suite in a disposable container on the server (no ports, no shared networks, nothing
persistent): `deploy/test/run.sh`.

## 10. Backups — Manual setup, Automatic daily run

1. On **your own computer**: `age-keygen -o dromanian-backup.key`. Keep this private key offline.
   Copy only its public line (`age1…`) to `/srv/app-data/dromanian-space/config/backup-recipients.txt`.
2. Configure an off-server destination as root with `rclone config` (another provider or machine).
3. `cp deploy/backup/backup.env.example /srv/app-data/dromanian-space/config/backup.env`
   (`chmod 600`), then fill in `RCLONE_REMOTE` and, optionally, `HEALTHCHECK_URL`.
4. Install the daily timer (02:30, 14 days kept locally):
   ```sh
   sudo cp deploy/backup/dromanian-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now dromanian-backup.timer
   sudo systemctl start dromanian-backup.service && journalctl -u dromanian-backup -n 50
   ```
5. Run the restore drill once now, and then monthly. It uses an isolated stack, so production is
   untouched:
   ```sh
   AGE_IDENTITY_FILE=~/dromanian-backup.key deploy/backup/restore-test.sh run /srv/app-data/dromanian-space/backup-staging/<latest>.tar.age
   deploy/backup/restore-test.sh down
   ```

**Automatic:** each archive contains:

- the database (logical dump plus roles);
- the pgsodium key directory;
- uploaded file bytes;
- the configuration directory;
- the n8n database, if configured;
- a checksum manifest.

It is encrypted to your public key, copied off-server and verified there. The script writes
`last-success` / `last-failure` markers and can ping a monitor. Details are in
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## 11. Optional: n8n

See [AUTOMATION.md](AUTOMATION.md). In short:

1. `prepare-host.sh --apply --with-n8n`.
2. Add a Docker Compose resource with base directory `/deploy/n8n`, the variables from
   `deploy/n8n/.env.example`, and the domain `https://n8n.digitalromanian.com:5678` on `n8n`.
3. Set `N8N_BASE_URL` on the app.
4. Create an automation key under **Agents → AI settings**.

Check the n8n license terms before offering it to anyone outside your organization.

## 12. Upgrades and rollback

- **App release:** merge, back up, run `preflight.sh`, then `migrate.sh apply` if the release adds
  migrations (they are additive), then redeploy in Coolify. **Rollback:** redeploy the previous
  commit. The schema stays compatible because migrations only add.
- **Supabase release:** follow `deploy/supabase/UPSTREAM.md`. Rehearse on the restore-drill stack
  first, and never change the PostgreSQL major version in place.
- **Failed migration:** nothing from that file was applied (it runs in one transaction). Fix
  forward. If data must go back, follow the restore procedure in DISASTER_RECOVERY.md.

## 13. Troubleshooting

| Symptom | Check |
| --- | --- |
| `mount-guard` exited 1; db/storage not started | A data disk is not mounted. Mount it, then redeploy the Supabase resource. |
| `api` or `worker` restarting, log says `refusing to start with invalid configuration` | The log line names the variable (for example a missing `SUPABASE_SECRET_KEY` or a `VITE_` secret). |
| `/api/ready` 503 `worker: no recent heartbeat` | Worker down or not on the `dromanian-supabase` network: `docker logs <worker>`, `docker network inspect dromanian-supabase`. |
| `/api/ready` 503 `queue: oldest due job waiting …` | Worker overloaded or failing jobs: `SELECT kind, last_error FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 20;` |
| Agents: "Anthropic/OpenAI is not configured" | Set the key on **both** `api` and `worker` (shared variables), then redeploy. Or switch the agent to a configured provider's model. |
| Sign-in redirects to the wrong place | `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` (Supabase) and `VITE_APP_URL` (rebuild). |
| No confirmation emails | `docker logs supabase-auth` (SMTP errors); check the SMTP host, port, user and the sender domain's SPF/DKIM. |
| Realtime not updating | The browser dev tools should show a WebSocket to `wss://supabase-space…/realtime/v1/websocket` with status 101. If not, check the Traefik route. |
| Uploads fail above 50 MB | `STORAGE_FILE_SIZE_LIMIT` (Supabase resource) and any bucket limit. |
| HTTP 429 from the API | Per-client limits: `API_RATE_LIMIT_PER_MINUTE`, `API_AGENT_RATE_LIMIT_PER_MINUTE`. |
| Disk filling up | `df -h /srv/*`, `docker system df`, backup retention (`RETENTION_DAYS`). Logs are capped. Never prune volumes as routine maintenance. |

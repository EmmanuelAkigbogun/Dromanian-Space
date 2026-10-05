# Dromanian Space — own-server deployment addendum

Give this document to the coding agent alongside `Dromanian-Space-Mattermost-Build-Prompt.md`. It changes the deployment target to an owner-operated Linux server managed through Coolify. It is an implementation specification, not an installation already performed or a tested Compose bundle.

## 1. Deployment override

Keep the full product scope: Mattermost-inspired chat, shared Drive, agent dashboard, workspace isolation, and supporting CRM. Keep React, TypeScript, Vite, CSS Modules, and Supabase-compatible application APIs.

**The primary deployment target is Docker Compose on my own server, managed by Coolify.** This addendum gives the main prompt its detailed server layout and overrides any remaining legacy Vercel-specific deployment reference. Vercel is optional and must not be required for any core feature. Preserve unrelated product, migration, and permission requirements.

Build on the existing repository: https://github.com/EmmanuelAkigbogun/Dromanian-Space. Do not install a new Mattermost instance as a substitute for implementing this application. Any existing Mattermost installation is a separate service to preserve.

## 2. Concrete service layout

| Service | Responsibility | Exposure |
|---|---|---|
| Coolify's existing reverse proxy | HTTPS, domain routing, certificate management | Existing public ingress, or a deliberately private deployment |
| `web` | Serve the compiled Vite frontend through Nginx; route `/api/` to the Node API | App domain through the existing proxy |
| `api` | Authenticated agent API, streaming, validated tools, secret-bearing integrations | Internal container port; reached through `web` |
| `worker` | Run extraction, embedding, agent jobs, and application background work | No public port |
| Self-hosted Supabase stack | Postgres, Auth, REST, Realtime, Storage, relevant functions, and supporting services | Gateway exposed through a dedicated HTTPS hostname; database stays internal |
| Supabase Studio | Database administration | Administrator-only route; preferably Tailscale/private access |

Use two named Coolify resources where practical: an independently maintained Supabase service and an application Compose resource containing `web`, `api`, and `worker`. Connect them through an explicitly configured private Docker network and stable service aliases. Verify how the installed Coolify version attaches and preserves that network. Keep database lifecycle separate from application redeploys.

Use the official self-hosted Supabase release configuration, or inspect and pin a compatible Coolify template. Do not assemble a substitute consisting of plain Postgres alone: the application depends on Auth, Storage, Realtime, and Supabase APIs. Do not assume the Coolify template uses the same images, gateway, or key names as the latest upstream release.

Proposed domains, subject to owner configuration:

- `space.digitalromanian.com`: frontend and `/api/*` application endpoints.
- `supabase-space.digitalromanian.com`: browser-reachable Supabase gateway.
- Studio and Coolify administration: restricted separately from public application APIs.

These are suggested hostnames, not a claim that DNS is configured. A browser cannot resolve Docker service names; supply its public Supabase HTTPS URL, while server processes use the appropriate internal endpoint. Ensure generated login callbacks, file links, and redirects use browser-reachable addresses.

## 3. Repository deliverables

Implement the actual application server and deployment assets, then provide:

- A multi-stage frontend Dockerfile using the package lockfile and a Node version compatible with the actual Vite dependency.
- An Nginx configuration with SPA fallback, hashed-asset caching, an uncached application entrypoint, and `/api/` proxying before the SPA fallback.
- A production Node API entrypoint and Dockerfile. Preserve existing endpoint contracts where possible. Vercel handler files are not a replacement for a listening server.
- A separately runnable worker entrypoint; it may use the same image as the API with a different command.
- A Coolify-compatible application Compose file with explicit service dependencies, restart policies, health checks, limits, and private networking.
- A recorded Supabase release/template reference and the exact persistent-storage/network overrides required on this server. Keep secrets out of version control.
- Public and server-only environment templates, migration commands, and deployment documentation.
- Backup and restore scripts or documented commands, plus an isolated restore verification procedure.
- `docs/SELF_HOSTING.md`, including first deployment, upgrades, diagnosis, rollback, and recovery.

Use pinned images or recorded release references. Run application processes with least privilege where their images support it. Do not mount the host Docker socket into the application. Configure bounded log rotation so a failing worker cannot fill the disk.

Vite public environment values are normally embedded during build. Pass only browser-safe settings at that stage, or implement a documented runtime public-config mechanism. Do not claim editing a runtime environment variable changes an already built bundle. Model keys, privileged Supabase keys, and database credentials stay in API/worker environments.

## 4. Durable background work and streaming

Use the main prompt's persisted job and agent-run model with atomic leases, retries, current permission checks, and idempotency keys. The worker is a supervised long-running process. It can process jobs while users are offline, but it must recover from container restarts and host reboots.

The API authenticates a request, persists the run, and exposes status/events; the worker executes durable work. Streaming is a view of run progress rather than its sole storage location. Configure the proxy for server-sent events without response buffering and with appropriate timeouts. Verify Realtime websocket upgrades through the Supabase gateway route.

Select one authoritative scheduler for each task. Audit existing database cron and browser scheduling before enabling a new worker schedule. Do not allow multiple mechanisms to send the same scheduled message. Preserve database-supported schedules where reliable; move application-specific execution to the worker only with a compatible migration.

Expose liveness and readiness endpoints without secrets. Check worker freshness through a heartbeat and job progress, not merely the presence of its process. Shut down gracefully and release or expire leases so jobs resume safely.

## 5. Data on the server

The intended server has previously used `/srv/app-data` and `/srv/cloud-data`. Verify the actual mounts, filesystem, available space, and permissions before creating deployment data. Treat the following as proposed dedicated directories:

| Proposed host path | Purpose |
|---|---|
| `/srv/app-data/dromanian-space/supabase/` | Supabase persistent data, including database storage mapped to the pinned image's required paths |
| `/srv/app-data/dromanian-space/config/` | Protected runtime configuration outside the Git checkout |
| `/srv/cloud-data/dromanian-space/storage/` | Uploaded file bytes managed through Supabase Storage |
| `/srv/app-data/dromanian-space/backup-staging/` | Temporary backup staging, with an off-server destination configured separately |

Use Supabase Storage's supported local file backend for the first single-server deployment. Private buckets, metadata, and storage policies remain authoritative; do not expose the storage directory through an open Nginx file browser. Bind the exact data paths required by the chosen image. An S3-compatible backend is optional later.

Check mount availability before Docker starts dependent stateful containers. Fail closed if a required external mount is absent; do not silently write a fresh database into an empty mountpoint on the system disk. Preserve unrelated directories and existing service volumes. Never repartition, format disks, run broad recursive ownership changes, or run destructive Docker volume cleanup as routine setup.

Back up both database state and uploaded objects, together with the encrypted recovery configuration required to use them. A SQL dump alone does not contain uploaded file bytes. Use a consistent backup procedure or a maintenance window; do not treat copying a live Postgres data directory as a valid logical backup.

Configure a daily backup and sensible retention as an initial proposal, then verify restoration into an isolated stack. Keep at least one encrypted copy on a different physical device or remote destination. Two partitions of the same physical drive do not protect against drive failure. Report the tested recovery point and recovery procedure rather than promising high availability from a single host.

## 6. Authentication, networking, and external services

Keep all tenant and resource RLS rules from the main prompt. Self-hosting does not replace application authorization. Use one Supabase application database with workspace-level isolation; do not confuse application workspaces with Supabase Storage's infrastructure-level multitenant mode.

Generate production secrets using the selected Supabase release's documented mechanism. Reconcile legacy anonymous/service-role keys with newer key formats where applicable. Do not mix environment templates from different releases without verification.

Configure the application's canonical URL, allowed Auth redirects, OAuth callbacks if used, and SMTP for invitations, verification, and password resets. Use a real SMTP provider/account when those flows are enabled. Mail delivery and model inference are separate optional external dependencies; neither requires moving the database to a managed cloud.

For public access, verify DNS, HTTPS, router/firewall rules, and whether the connection is behind CGNAT. Reuse the existing Coolify proxy rather than starting a conflicting host listener on ports 80/443. Do not publish Postgres, the worker, or unrestricted administrative endpoints to the internet.

For a private pilot, make both frontend and Supabase browser endpoints reachable through the private network with valid HTTPS. Tailscale-only access is appropriate if every intended teammate has access. Do not assume exposing only the frontend makes its backend reachable to remote browsers. Defer a public tunnel or port-forwarding choice until the actual network is known.

If existing calls use WebRTC, verify the current signaling and media architecture. Test across separate networks and configure STUN/TURN or required media connectivity if necessary. Successful chat websocket traffic alone does not prove calls work remotely.

## 7. AI hosting choice

Default to hosting the product, files, embeddings database, and agent execution on the server while using a configured external model API for generation and, initially, embeddings. This avoids requiring a GPU for the first deployment. Provider usage still costs money where applicable, and any source text sent to the provider leaves this server. Make the chosen provider and data flow clear in workspace settings.

Support a provider adapter so generation and embeddings can later use a local model service. Do not install or promise a suitable local model without checking CPU, RAM, GPU/VRAM, model capability, and intended concurrency. A change of embedding model can require reindexing; version the model and vector dimensions.

The twelve agent profiles do not require twelve separate models or GPU processes. They share the execution engine with distinct instructions, tools, and source policies. Team Chat coordinates bounded specialist runs. Bound concurrency and quotas regardless of provider location.

## 8. Setup workflow and capacity

Inspect CPU architecture/core count, total and available RAM, actual disk mounts, free space, Docker/Compose versions, running containers, current proxy, and occupied ports. Do not print environment files or credentials in diagnostic output. Account for existing Coolify, Mattermost, databases, and other applications.

As a planning estimate, aim for roughly 4 CPU cores and 16 GB total RAM for a modest combined deployment using external AI, leaving measured headroom for existing services. This is not a guaranteed capacity figure or a local-model hardware requirement. Supabase's documented recommendation is 4+ cores and 8+ GB RAM for its own stack; benchmark the combined workload and reduce worker concurrency as needed.

Deploy in this order: inventory → validate storage/network → provision isolated Supabase → apply additive migrations → deploy frontend/API/worker → configure authentication email → verify connected journeys → verify backup restoration → enable the intended team access.

When guiding the owner through a terminal, provide one manageable command or action at a time and use its result for the next step. Do not request secrets in chat. When the coding agent has authorized access, complete routine implementation and verification autonomously, preserving existing deployments.

## 9. Acceptance checks

In addition to the product tests, verify:

1. The application builds and runs without Vercel credentials or runtime services.
2. Frontend deep links, API errors, streaming, Realtime, uploads, downloads, and authentication redirects work through the actual hostnames.
3. Two users in different workspaces remain isolated through direct API, Storage, Realtime, search, and AI calls.
4. App redeployment preserves database records and files; a worker restart resumes a queued job without duplicate side effects.
5. Required data mounts are present before stateful services start, including after a reboot performed during an agreed maintenance window.
6. A restored backup contains both database records and the matching file objects and can complete sign-in and document access in an isolated environment.
7. Existing Mattermost and other server applications retain their data, ports, and availability.
8. Missing AI/SMTP configuration is reported accurately rather than hidden behind simulated success.

Report actual implementation, commands executed, services started, URLs verified, and outstanding external configuration. If server access is unavailable, complete the deployment files and give the next exact diagnostic/setup action; do not claim the server was configured.

## Official references

- Supabase Docker deployment and capacity: https://supabase.com/docs/guides/self-hosting/docker
- Supabase Storage configuration: https://supabase.com/docs/guides/self-hosting/storage/config
- Coolify Compose deployments: https://coolify.io/docs/applications/builds/docker-compose
- Coolify persistent storage: https://coolify.io/docs/core/persistent-storage/storage-mounts/overview

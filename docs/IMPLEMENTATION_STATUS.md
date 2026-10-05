# Implementation status

Living record for the Mattermost-inspired workspace, Drive, and Agents evolution described in
`Dromanian-Space-Mattermost-Build-Prompt.md`, updated on 2026-10-05 for the revised brief
(`Dromanian-Space-Mattermost-Build-Prompt (1).md`: Coolify self-hosting, twelve role agents, Team Chat).
and `Dromanian-Space-Self-Hosting-Addendum.md` (own-server layout, Nginx, pinned Supabase, data paths,
backups, scheduling, readiness). It records decisions, migrations, verified journeys,
and exact blockers. It is not a substitute for the implementation.

Baseline commit: `c8ce62112bdca58f6d3bc9956a0e1ff4bdafa095` (2026-09-25).
Legacy schema checksum (`supabase/SQL/all/all.sql`, 8,070 lines):
`c05ba851801f0cda7b1f292a4b4e7d2124ecd7da6d8a170adc4c59d7d2b111c8`.

## 1. Baseline (slice 1)

### Checks before any change

| Check | Result |
| --- | --- |
| `npm ci` | OK (Node 24.15.0, npm 11.16.0) |
| `npm run build` (`tsc -b && vite build`) | Passes. One 1.46 MB JS chunk (373 kB gzip); Rolldown warns about ineffective dynamic imports. |
| `npm run lint` (Oxlint) | Passes with 110 warnings, 0 errors (unused vars, exhaustive-deps, fast-refresh exports). |
| `npm audit` | 4 advisories: `nanoid` (high), `postcss` (moderate), `react-router` 7.12–7.18.1 RSC-mode CSRF (high; RSC mode is not used by this SPA). |
| Automated tests | None existed. |

### Architecture found

- React 19 + TypeScript + Vite 8 SPA, React Router 7, TanStack Query, CSS Modules with tokens in
  `src/styles/tokens.css` (light and dark themes via `data-theme`).
- Supabase is used directly from the browser (Auth, PostgREST, Storage bucket `message-attachments`,
  Realtime `postgres_changes`). One Supabase Edge Function (`fetch-link-preview`). No server endpoints.
- 19 nested context providers in `src/App.tsx`; routes are flat (`/channels/:slug`, `/dm/:id`,
  `/files`, `/tasks`, `/projects`, `/calendar`, `/automation`). `/ai` rendered a placeholder.
- The sidebar was one long list (workspace switcher, channels, DMs, all navigation).
- Schema: `supabase/SQL/all/all.sql` is an accumulated, hand-applied set of scripts 000–054. Section
  001 contains `DROP TABLE ... CASCADE` for automation tables, so it must never be replayed against a
  provisioned database.
- `src/types/database.ts` is hand-written and partial; 196 `as any` and 123 `as never` casts.

### Security findings in the existing system (fixed in `20261004000100_security_hardening.sql`)

1. **Storage:** `message-attachments` policies allowed any authenticated user to list, read, upload and
   delete any object in the bucket, so every workspace's attachments were readable and deletable
   cross-tenant.
2. **Caller-supplied identity in `SECURITY DEFINER` RPCs:** `change_member_role`,
   `remove_workspace_member`, `transfer_workspace_ownership` trust `p_caller_id`;
   `create_workspace_with_owner`, `accept_workspace_invitation`, `mark_channel_read`,
   `get_unread_count(s)`, `mark_conversation_read`, `create_direct_conversation`,
   `create_group_conversation`, `record_message_version` trust `p_user_id`/`p_created_by`.
3. **Missing authorization in `SECURITY DEFINER` RPCs:** `delete_task`, `update_task`,
   `update_task_status`, `archive_task`, `restore_task`, `move_task_to_column`, `get_workspace_tasks`,
   `get_profiles_by_ids`, `create_notification`, project member RPCs, event participant RPCs,
   `toggle_automation_rule`, `update_automation_rule`, `log_automation_execution`, `get_read_receipt_counts`.
4. **Internal engine functions callable by clients:** `evaluate_automation_rules`,
   `automation_execute_action` (inserts messages as an arbitrary `p_rule_creator` into an arbitrary
   channel), `automation_resolve_dm`, `send_due_*`, `fire_calendar_*`, `apply_message_retention`,
   `cleanup_call_signaling`. Functions recreated after `DROP FUNCTION` regain Supabase's default
   `EXECUTE` grant for `anon`/`authenticated`.
5. **Row Level Security gaps:** any channel member could update any message; any workspace member
   could list every DM conversation and its participants and every private channel's members;
   channel creators and DM creators could add users who are not workspace members; anyone could
   insert notifications and `user_mentions` for anyone; `task_activity`/automation log inserts were open.
6. **Workspace scoping triggers** (`file_attachments`, `messages`, `reactions`, `call_participants`)
   only derived `workspace_id` when the client omitted it, allowing mismatched tenant ids.
7. **Scheduled messages:** delivered by both a browser poll (`src/App.tsx`, leader tab) and pg_cron.
   Both mark `sent = true` before sending; the browser path loses the message if the insert fails after
   the claim, the SQL path swallows attachment failures and then deletes the scheduled attachments,
   and neither rechecks channel membership at delivery time.
8. **Client caches:** sign-out does not clear the TanStack Query cache, realtime channels or
   persisted thread state; the persisted thread and channel survive workspace switches; global search
   was not workspace-scoped.

## 2. Decisions

| Area | Decision |
| --- | --- |
| Tenant boundary | Existing `workspaces`; no new organization tier. New tenant tables carry `workspace_id` with composite foreign keys `(id, workspace_id)` to the parent so references cannot cross tenants. |
| Backend boundary | A Node API container (`server/main.ts`, web-standard handlers in `api/`) and a separate worker container (`server/worker-main.ts`), deployed with Docker Compose on Coolify behind an Nginx web container that serves the SPA. Self-hosted Supabase for data, RLS, Storage, Realtime. No duplicate API in Edge Functions. Vercel configuration was removed because it is no longer supported or tested. |
| Server identity | `Authorization: Bearer <Supabase access token>` verified with `supabase.auth.getClaims()`. Interactive reads run through a user-scoped client so RLS applies; privileged writes use the secret key with explicit actor checks inside `SECURITY DEFINER` functions granted only to `service_role`. |
| Migrations | Ordered files in `supabase/migrations`. `20261004000000_legacy_baseline.sql` is the frozen legacy schema with a guard that aborts before any statement runs on a database that already has it (baseline with `supabase migration repair`). See `docs/DATABASE.md`. |
| Jobs | Postgres `jobs` table with leases (`FOR UPDATE SKIP LOCKED`), attempts, backoff, idempotency keys, dead-letter state. The worker polls continuously, runs maintenance every minute and executes agent runs as `agent.run` jobs; a dead worker's leases expire and its runs restart cleanly elsewhere. `GET /api/jobs/run` remains for an optional external scheduler. |
| Agent roster | Twelve role specialists with original names (Atlas, Haven, Marlo, Tally, Wren, Sage, Rio, Inka, Talia, Orbit, Echo, Juno) and a Team Lead coordinator on the same engine. The previous eight built-ins are archived; their conversations stay readable. Third-party connectors are modelled as honest readiness states (`workspace_connectors`); none is implemented or simulated. |
| Team Chat | Coordinator tool `delegate_to_specialists`: one level deep, ≤4 tasks per call, ≤8 per team run, specialists run as the requester, children's sources propagate to the team run, citations renumbered into the combined answer, idempotent after restart. Viewers follow runs by reading persisted checkpoints (SSE from the API), so a closed tab or API restart does not affect generation. |
| Scheduling | One authoritative scheduler per maintenance task: `pg_cron` when its job is active, otherwise the worker (`run_unscheduled_maintenance`). The browser no longer nudges scheduled-message delivery. |
| Operations | Worker heartbeats with job progress in `worker_heartbeats`; `/api/health` (liveness) and `/api/ready` (database, worker freshness, queue lag). Supabase pinned to upstream `ff80bb1` with overrides for `/srv` data paths, a fail-closed mount guard, private networking and no public database ports. Encrypted backups (database, file bytes, configuration) with an isolated restore check. |
| SEO site access | Uses the provider's server-side web fetch restricted to the admin-configured site domain, so this server makes no outbound requests on the model's behalf (no SSRF surface). |
| Scheduled messages | One authoritative path: Postgres `pg_cron` delivery with row locks, membership recheck, atomic message + attachment insert, retries, and terminal failure state. The browser poll is removed. |
| AI provider | Anthropic Messages API via `@anthropic-ai/sdk`, behind a provider adapter. Default model `claude-opus-5-5`, effort set explicitly, streaming manual tool loop (approval gates, cancellation, step caps). Server-side refusal fallback (`fallbacks: "default"`) is enabled by default and can be turned off with `ANTHROPIC_REFUSAL_FALLBACK=off`. |
| Embeddings | Optional Voyage AI adapter. Without it, retrieval uses Postgres full-text search and the UI states that semantic search is not configured. |
| Drive model | One `drive_items` tree (folders, files, documents) with immutable `drive_versions`, document revisions with optimistic concurrency, typed grants (user/channel/project/workspace), inheritance from parent folders unless a folder is restricted. Admin role grants no implicit file access. |
| Message attachments | Existing upload/render path is kept. Every stored attachment becomes a Drive item with a channel grant scoped to the conversation it was posted in (a database trigger), so Drive, search and AI see the same logical file without broadening access. Drive files referenced from the composer are linked, not copied. |
| UI | Existing CSS Modules and tokens. New shell: icon rail, module context sidebar, main area, single managed right panel, top bar with search, quick create and notifications. |

## 3. Slices

| # | Slice | Status |
| --- | --- | --- |
| 1 | Baseline | Done (this document) |
| 2 | Shell and tenancy | Implemented core rail, context navigation, cache reset and provider boundaries |
| 3 | Drive vertical slice | Implemented uploads, grants, document revisions/autosave, previews and extraction |
| 4 | AI vertical slice | Persisted server engine and UI implemented; deterministic provider tests pass; live provider unverified |
| 5 | Collaboration integration | Drive references, channel entry points, followed threads and mention dispatch implemented |
| 6 | Agent dashboard and catalog | Dashboard aggregates, eight agents, conversations, settings and approval cards implemented |
| 7 | CRM and automation connections | CRM and reviewed agent CRM tools implemented; new agent automation templates remain |
| 8 | Hardening and deployment | 114 local tests pass; production build, server bundles, Nginx layer and deployment scripts verified locally; Docker images, Coolify deployment and acceptance verification remain |
| 9 | Revised brief: roster and Team Chat | Twelve role agents, Team Chat with delegation and authorship, readiness/connectors, AI settings (brand kit, site, web research, mention policy), personal notes, calendar and metrics tools, worker-based durable execution |

## 4. Verification log

2026-10-04, local PostgreSQL 17 + PostgREST/gateway:

- Resumed the existing migrations/server work and fixed TypeScript server build errors and a knowledge-test fixture that depended on previous runs.
- Added typed browser contracts (95 tables, 291 RPCs), local API adapter, SPA/API Vercel routing and server environment documentation.
- Built Drive, persisted Agents, dashboard, CRM and followed-thread routes. Preserved the existing messaging/task/project screens and old `/files` and `/ai` links via redirects.
- Added transactional Drive references with explicit grant consent and request-key deduplication. Added CRM ownership checks, activity, resource links and service-only AI tools.
- Improved worker claiming and interactive indexing nudges, document autosave/conflict recovery, pinned citations, CSV preview and scope reset behavior.
- `npm test`: **89/89 pass**, seven files, including real database/API engine orchestration with a deterministic provider double. No paid model requests made.
- `npm run build`: passes client/server TypeScript and production bundle. Large legacy main chunk warning remains.
- `npm run lint`: no errors; existing warning backlog remains.
- Browser: local password login; populated Home; Drive document open/edit/save and explicit workspace sharing; CRM create/read with activity; eight-agent directory and absent-provider state. These are local checks, not hosted deployment evidence.
- Preview account and workspace fixture stored under ignored `.local/preview.json`; local app on http://127.0.0.1:5173.

2026-10-05, revised brief:

- Migration `20261004001300_agent_roster_and_team.sql`: roster, readiness inputs, delegation, durable restarts, tools, and fixes for four existing defects found by new tests: `ai_update_settings` emptied the allowed-models list on any update without that key; agent notification links pointed to a non-existent route; the team-task read policy referenced the wrong column (caught before release); specialists inside team runs sent separate notifications.
- Server: worker process, queue-based agent runs, run follower (SSE) with reattach, delegation, new tools, provider support for domain-restricted page fetch, request IDs and access logs. Removed `@vercel/functions` and `vercel.json`.
- Deployment assets: `Dockerfile` (web and server targets), `docker-compose.yml` for Coolify, `.dockerignore`, `npm run build:server` (the interim Caddy web config was replaced by Nginx per the addendum).
- UI: Agents directory with Team Chat and per-agent readiness, agent detail with tools/approval policy and private notes, Team Chat timeline with specialist authorship and live task status, stream reattachment, AI settings for admins, safe Markdown rendering of answers.
- `npm test`: **114/114 pass** in ten files. `tsc -b` passes. Browser checks with Playwright; screenshots in `docs/screenshots/`.
- Self-hosting addendum: Nginx web image (replacing the interim Caddy config), hardened compose file, migration `20261005000100_worker_operations.sql`, `/api/ready`, Supabase overrides and proxy route, `deploy/prepare-host.sh`, `deploy/migrate.sh`, backup and restore-check scripts, `docs/SELF_HOSTING.md`. Verified locally: Nginx config (`nginx -t` and live requests including a streamed run), migration script against a fresh database, `shellcheck`, YAML parsing.

### Remaining build-prompt scope

This is a working continuation, not full acceptance of the entire build prompt. Still outstanding: new agent automation templates and their execution path, real third-party connectors (help desk, store such as Medusa, email platform, social accounts, recruiting, search analytics, inbox), custom-agent creation/pinning UI, per-agent source-scope editing, CRM CSV import/saved views, Drive bulk actions and richer file/version management, richer dashboard activity, and unified search coverage for CRM/projects. Existing legacy automation screens remain available, but are not presented as the new AI automation system.

Hosted Realtime, email/OAuth, live provider streaming/cancellation, provider model availability, real embedding service, production cron and migration/deployment still need verification. The local gateway has no Realtime implementation. Local tests do not establish hosted Storage behavior or a complete accessibility/performance audit.

## 5. Blockers and external setup

- No Supabase credentials for the application's project (`nwsxrtfkdbnuzejyeogh`) are available in this
  environment, and the Supabase CLI account visible here does not contain that project. Database work
  is verified against a local PostgreSQL 17 instance that emulates Supabase's `auth`, `storage`, roles
  and PostgREST (see `docs/TESTING.md`). Applying migrations to a hosted project is a manual step.
- No `ANTHROPIC_API_KEY` is available, so live model generation (including Team Chat and the SEO page fetch) has not been exercised.
- No server or Coolify access, and no Docker on the development machine: the images, compose stack, Supabase overrides and backup scripts are written and checked statically but not built or run against real containers. Next step on the server: `deploy/prepare-host.sh` (read-only inventory), then `docs/SELF_HOSTING.md` section 2.

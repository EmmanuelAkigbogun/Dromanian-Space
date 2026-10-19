# Database migrations

Ordered migrations live in `supabase/migrations`. The original accumulated schema is frozen in
`20261004000000_legacy_baseline.sql`, with a guard that aborts if `public.workspaces` already
exists. The legacy SQL contains destructive statements and must never be replayed on a provisioned
database.

## Self-hosted (production): `deploy/migrate.sh`

```sh
PGPASSWORD_FILE=/srv/app-data/dromanian-space/config/db-password deploy/migrate.sh status
PGPASSWORD_FILE=… deploy/migrate.sh check          # exit 0 only if apply is safe
PGPASSWORD_FILE=… deploy/migrate.sh apply          # pending files, in order
PGPASSWORD_FILE=… deploy/migrate.sh apply --to <version>   # restores only: stop after a version
```

Guarantees:

1. **Installed version:** the runner reads `supabase_migrations.schema_migrations`, the Supabase
   CLI's table, so the CLI and this script agree.
2. **Pending files only,** in version order.
3. **Bookkeeping in the same transaction:** each file runs in one transaction together with its
   history row and a SHA-256 checksum (`supabase_migrations.dromanian_checksums`). A failing file
   leaves nothing behind.
4. **First error stops the run.** Each file waits at most `LOCK_TIMEOUT` (15 s) for locks, so a busy
   table fails the migration cleanly instead of blocking the application.
5. **Drift detection:** `apply` refuses, and `status`/`check` report, when:
   - an applied file's content changed;
   - a version is applied in the database but missing from the repository;
   - a pending file is older than the newest applied version;
   - an existing database (public tables present) has no migration history.
6. **Read-only checks:** `status` and `check` create nothing. Only `apply` and `mark-applied` create
   the bookkeeping tables.

`deploy/preflight.sh` runs `check` together with host, service and backup checks. Always run it
first, and take a backup before migrating a database that holds data.

## Clean install and upgrade paths

| Situation | Steps |
| --- | --- |
| Clean install (empty Supabase database) | `migrate.sh apply`: everything, including the legacy baseline. |
| Existing self-hosted installation | Back up, `preflight.sh`, `migrate.sh apply`. Only pending files run. |
| Moving from the old hosted project | Restore its dump into the new stack (Supabase's backup-and-restore guide), copy its Storage objects, inspect the schema against the frozen baseline, `migrate.sh mark-applied 20261004000000` (the only version that may be marked), then `apply`. A partly provisioned schema must be reconciled first; marking is not a repair for missing tables. |
| Restoring a backup | `migrate.sh apply --to <backup's latest version>`, `deploy/backup/restore.sh`, then `migrate.sh apply`. See DISASTER_RECOVERY.md. |

Migrations are additive (new tables, columns, functions and policies). `tests/unit/deploy.test.ts`
rejects `DROP TABLE/SCHEMA/COLUMN`, `TRUNCATE` and `DELETE FROM` in new migrations, and
transaction-control statements in any migration. They are still not assumed reversible: recover
from a bad data change by fixing forward or restoring (DISASTER_RECOVERY.md).

## Local development

`npm run supabase:local -- start` creates the local PostgreSQL cluster if needed and applies pending
migrations. `npm run supabase:local -- migrate` applies only pending files. It uses fixed loopback
connections and does not accept a hosted database URL. `npm run types:platform` regenerates the
typed platform schema from this database.

## Migration groups

| Files | Purpose |
| --- | --- |
| 00000 | Frozen legacy baseline with replay guard |
| 00100–00150 | Tenant authorization, internal RPC privileges and legacy trigger fixes |
| 00200 | Atomic scheduled delivery, retries and failure state |
| 00300 | Audit records, durable queue, platform settings |
| 00400–00450 | Drive tree, grants, versions, document revisions, legacy attachment backfill |
| 00500 | Knowledge sources/chunks, extraction and authorized retrieval |
| 00600–00700 | Agent catalog/configurations, runs, approvals, citations, search and tools |
| 00800 | Worker support and maintenance |
| 00900 | Atomic Drive references in messages and dashboard aggregates |
| 01000–01100 | CRM, activity, resource links and reviewed agent CRM actions |
| 01200 | Explicit channel-share consent and authorized CRM task links |
| 01300 | Role specialists and the Team Chat coordinator, delegation, durable run restarts, connectors, brand kit/site settings, personal notes, calendar events and workspace metrics |
| 20261005000100 | Worker heartbeats, readiness summary and one authoritative scheduler per maintenance task |
| 20261019000100 | Two providers: model catalog with prices, platform default reported by the server, provider and estimated cost on every usage row (backfilled), admin bulk model switch, provider-aware agent seeding |
| 20261019000200 | Business Researcher (Vera), Creative Director (Nova) and Software Engineer (Kai); Atlas refocused as Marketing Strategist, Rio as Sales Development, Talia as HR Assistant (new versions only where the workspace had not customized them) |
| 20261019000300 | Signed automation keys (n8n) and the per-request execution log, with one run per request id |

## Data coverage

| Capability | Where |
| --- | --- |
| Users and authentication | `auth.users` (Supabase Auth), `profiles` |
| Workspaces, memberships, roles | `workspaces`, `workspace_members` (owner/admin/member), invitations |
| Channels and messages | `channels`, `channel_members`, `messages`, direct conversations, reactions, threads |
| CRM | `crm_companies`, `crm_contacts`, `crm_pipelines`, `crm_stages`, `crm_deals`, `crm_activity`, `crm_links` |
| Tasks, projects, calendar | `tasks` (assignees, comments, labels, activity), `projects` (members, columns, milestones, resources), `calendar_events`, `event_participants` |
| Drive | `drive_items`, `drive_versions`, `drive_document_revisions`, `drive_grants`, comments, access requests |
| Agents | `agent_templates`, `workspace_agents`, `workspace_agent_versions` (instructions, tools, model, effort, source scope) |
| Conversations and execution | `agent_conversations`, `agent_messages`, `agent_runs`, `agent_run_events`, `agent_run_sources`, `agent_tool_invocations`, `agent_citations`, `agent_team_tasks` |
| Approvals | `agent_action_proposals` |
| Provider configuration and usage | `workspace_ai_settings`, `ai_models`, `ai_platform_state`, `ai_usage_ledger` (tokens and estimated cost) |
| Knowledge and memory | `knowledge_sources`, `knowledge_chunks` (full text), `knowledge_embeddings` (optional vectors), `agent_personal_notes` |
| Jobs and workflows | `jobs`, `job_attempts` (leases, retries, dead letters), `worker_heartbeats`, legacy `automation_rules` and execution logs, `automation_keys`, `automation_requests` |
| Integrations | `workspace_connectors`, automation keys |
| Audit | `audit_log` |

Every tenant table carries `workspace_id`, uses Row Level Security, and references its parent with
composite keys. Server-side functions re-check the acting user explicitly.

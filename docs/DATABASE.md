# Database migrations

Ordered migrations live in `supabase/migrations`. The original accumulated schema is frozen in `20261004000000_legacy_baseline.sql`, with a guard that aborts if `public.workspaces` already exists. Legacy SQL contains destructive statements and must never be replayed on a provisioned project.

## Local development

`npm run supabase:local -- start` creates the local PostgreSQL cluster if needed and applies pending migrations. `npm run supabase:local -- migrate` applies only pending files. The runner tracks migration names and executes each file in a transaction. It uses fixed loopback connections and does not accept a hosted database URL. `npm run types:platform` regenerates the typed platform schema from this database.

## Existing Supabase project

First back up the database and inspect its schema against the frozen legacy baseline. Only after confirming the baseline is already present, mark that version applied with the Supabase CLI:

```sh
supabase migration repair 20261004000000 --status applied
```

Review the pending migration list/diff on a staging copy before `supabase db push`. A partly provisioned schema must be reconciled first; marking a migration applied is not a repair for missing tables. Enable the Supabase `pg_cron` extension required by the legacy scheduled jobs. No hosted migrations were applied during this implementation.

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

New tenant relationships use workspace-scoped composite keys. Migration backfill gives existing attachments access tied to their existing message audience. Drive ownership does not grant access after workspace membership is revoked.

## Operations

The jobs table uses leases, retry backoff and dead-letter state. Interactive writes nudge the workspace queue; the cron endpoint performs maintenance and drains pending work. The worker claims one job at a time so sequential extraction cannot consume another job's lease. Document indexing is debounced; the interactive worker waits briefly for newly queued work to become due.

Scheduled chat delivery uses the transactional database delivery function and pg_cron. A leader browser tab can nudge the same function when cron is unavailable. Without database cron, delivery while every browser is closed is not guaranteed.

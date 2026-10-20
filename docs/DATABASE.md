# Database migrations

The application owns a standalone PostgreSQL 17 database. Bootstrap SQL lives
in `database/bootstrap.sql`; ordered migrations live in `database/migrations`.
The migrator records version, filename and SHA-256 in
`app_migrations.schema_migrations` and refuses changed applied files.

In production, the root Compose resource runs the one-shot `migrate` service:

```sh
docker compose run --rm migrate
```

Every new file runs with `ON_ERROR_STOP` and in a single transaction together
with its ledger row. A 15-second lock timeout prevents silent indefinite waits.
Scheduling is handled by the Node worker, so `pg_cron` statements are skipped.

Rules:

- never edit or reorder an applied migration;
- never replay `database/SQL/all/all.sql` on a provisioned database;
- take and restore-test an encrypted backup before production migration;
- fix forward with a new migration rather than attempting an ad-hoc rollback;
- run `npm run db:check` for a fast clean-schema/upgrade check.

Local PostgreSQL/PostgREST development uses:

```sh
npm run database:local -- start
npm run database:local -- migrate
npm run database:local -- status
npm run database:local -- stop
```

State stays under `.local/database`; the adapter never accepts a hosted database
URL. `reset` is destructive and is intended only for disposable local state.

The schema includes local auth/session tables, tenant-scoped RLS, workspaces,
channels/messages, Drive metadata/grants/versions, calls/signaling, CRM, tasks,
projects, calendar, agents, knowledge, jobs, auditing and provider-usage data.

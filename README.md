# Dromanian Space

A React/TypeScript workspace with messaging, tasks, projects, Drive documents and files, CRM, and permission-aware AI agents: fifteen business specialists (executive assistant, social media, copywriting, SEO, sales development, customer support, data analysis, business research, HR, creative direction, software engineering, marketing strategy, commerce, email marketing, personal coaching) and a Team Lead that delegates across them, on Claude or OpenAI models. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for completed work and remaining scope.

## Local preview

Requires Node 24, PostgreSQL 17 and PostgREST. The local adapter defaults to Homebrew paths on macOS; set `LOCAL_PG_BIN` and `LOCAL_POSTGREST_BIN` for other installations.

```sh
npm ci
npm run supabase:local -- start
npm run dev:local
```

Open **http://127.0.0.1:5173**. The local Auth/Storage gateway runs on port 55321, PostgREST on 55320, PostgreSQL on 55432, and the API adapter and background worker on 5174. Data and generated local credentials are in `.local/` (git-ignored).

For a new installation, create a preview owner, teammate, two workspaces and a sample document:

```sh
node --import tsx scripts/seed-preview.ts
```

The email and password are saved in `.local/preview.json`. Re-running the seed creates additional fixtures; it does not replace an existing account. Do not run `supabase:local reset` to restart the preview: it deletes the local database. Use `stop` / `start` instead.

AI requests need a server-side `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`; each agent runs on the provider of its model (see [AI providers](docs/AI_PROVIDERS.md)). The app shows a setup state when no provider is configured. Set keys in the shell before starting `dev:local`; local database configuration is loaded automatically. Voyage embeddings are optional. Never place server keys in `VITE_` variables.

The emulator supports database authorization, password login and Storage for development. It does not implement Supabase Realtime, OAuth, email delivery, or production storage infrastructure.

## Checks

```sh
npm run test:unit      # no database needed
npm run db:check       # all migrations on an in-memory PostgreSQL (PGlite), no install needed
npm test               # full suites; requires the local database
npm run build
npm run build:server
npm run lint
npm run types:platform
```

`npm test` and type generation require the local database; `deploy/test/run.sh` runs the full suite in a disposable Docker container instead. `npm run dev` starts only Vite; use `dev:local` for the API-backed preview.

## Deployment and architecture

- [Coolify setup](docs/COOLIFY_SETUP.md): the production installation sequence
- [Self-hosting overview](docs/SELF_HOSTING.md) and [deployment files](docs/DEPLOYMENT.md)
- [Database migrations](docs/DATABASE.md) and [disaster recovery](docs/DISASTER_RECOVERY.md)
- [AI providers](docs/AI_PROVIDERS.md) (Anthropic and OpenAI) and [automation with n8n](docs/AUTOMATION.md)
- [Permissions](docs/PERMISSIONS.md) and [testing and evidence](docs/TESTING.md)

`src/` contains the browser app; `api/` contains the web-standard HTTP handlers; `server/` contains the API server and worker entry points, provider adapters, agent tools and background jobs. Production runs as Docker containers (`Dockerfile`, `docker-compose.yml`, `deploy/`) on Coolify with self-hosted Supabase; see the self-hosting guide. `supabase/migrations/` is the ordered schema history. Never replay `supabase/SQL/all/all.sql` on an existing project.

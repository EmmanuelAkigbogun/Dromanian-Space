# Dromanian Space

A React/TypeScript workspace with messaging, tasks, projects, Drive documents and files, CRM, and permission-aware AI agents: fifteen business specialists (executive assistant, social media, copywriting, SEO, sales development, customer support, data analysis, business research, HR, creative direction, software engineering, marketing strategy, commerce, email marketing, personal coaching) and a Team Lead that delegates across them, on Claude or OpenAI models. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for completed work and remaining scope.

## Local preview

Requires Node 24, PostgreSQL 17 and PostgREST. The local adapter defaults to Homebrew paths on macOS; set `LOCAL_PG_BIN` and `LOCAL_POSTGREST_BIN` for other installations.

```sh
npm ci
npm run database:local -- start
npm run dev:local
```

Open **http://127.0.0.1:5173**. The local Auth/Storage gateway runs on port 55321, PostgREST on 55320, PostgreSQL on 55432, and the API adapter and background worker on 5174. Data and generated local credentials are in `.local/` (git-ignored).

For a new installation, create a preview owner, teammate, two workspaces and a sample document:

```sh
node --import tsx scripts/seed-preview.ts
```

The email and password are saved in `.local/preview.json`. Re-running the seed creates additional fixtures; it does not replace an existing account. Do not run `database:local -- reset` to restart the preview: it deletes the local database. Use `stop` / `start` instead.

AI requests need a server-side Anthropic, OpenAI, and/or Google Gemini API key; each agent runs on the provider of its model (see [AI providers](docs/AI_PROVIDERS.md)). A platform administrator can enter these in the Agents settings UI, where they are encrypted on this server and never returned to the browser. The app shows a setup state when no provider is configured. Voyage embeddings are optional. Never place server keys in `VITE_` variables.

The local stack supports database authorization, password login and filesystem storage. It does not emulate production SSE, email delivery, TURN or backup infrastructure.

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
- [AI providers](docs/AI_PROVIDERS.md) (Anthropic, OpenAI, and Google Gemini) and [automation with n8n](docs/AUTOMATION.md)
- [Windows desktop app](docs/DESKTOP.md) (installer, portable build, tray, and native notifications)
- [Permissions](docs/PERMISSIONS.md) and [testing and evidence](docs/TESTING.md)

`src/` contains the browser app; `api/` contains the web-standard HTTP handlers; `server/` contains the API server and worker entry points, provider adapters, agent tools and background jobs. Production runs as one standalone Docker Compose stack (`Dockerfile`, `docker-compose.yml`, `deploy/`) on Coolify. `database/migrations/` is the ordered schema history. Never replay `database/SQL/all/all.sql` on an existing installation.

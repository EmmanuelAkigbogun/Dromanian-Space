# Dromanian Space

A React/TypeScript workspace with messaging, tasks, projects, Drive documents and files, CRM, and permission-aware AI agents. See [implementation status](docs/IMPLEMENTATION_STATUS.md) for completed work and remaining scope.

## Local preview

Requires Node 24, PostgreSQL 17 and PostgREST. The local adapter defaults to Homebrew paths on macOS; set `LOCAL_PG_BIN` and `LOCAL_POSTGREST_BIN` for other installations.

```sh
npm ci
npm run supabase:local -- start
npm run dev:local
```

Open **http://127.0.0.1:5173**. The local Auth/Storage gateway runs on port 55321, PostgREST on 55320, PostgreSQL on 55432, and the API adapter on 5174. Data and generated local credentials are in `.local/` (git-ignored).

For a new installation, create a preview owner, teammate, two workspaces and a sample document:

```sh
node --import tsx scripts/seed-preview.ts
```

The email and password are saved in `.local/preview.json`. Re-running the seed creates additional fixtures; it does not replace an existing account. Do not run `supabase:local reset` to restart the preview: it deletes the local database. Use `stop` / `start` instead.

AI requests need a server-side `ANTHROPIC_API_KEY` and a model available to that account. The app shows a setup state when the provider is absent. Set the key in the shell before starting `dev:local`; local database configuration is loaded automatically. Voyage embeddings are optional. Never place server keys in `VITE_` variables.

The emulator supports database authorization, password login and Storage for development. It does not implement Supabase Realtime, OAuth, email delivery, or production storage infrastructure.

## Checks

```sh
npm test
npm run build
npm run lint
npm run types:platform
```

Tests and type generation require the local database. `npm run dev` starts only Vite; use `dev:local` for the API-backed preview.

## Deployment and architecture

- [Database migrations](docs/DATABASE.md)
- [Permissions](docs/PERMISSIONS.md)
- [Testing and evidence](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)

`src/` contains the browser app; `api/` contains Vercel web handlers; `server/` contains provider adapters, agent tools and background jobs. `supabase/migrations/` is the ordered schema history. Never replay `supabase/SQL/all/all.sql` on an existing project.

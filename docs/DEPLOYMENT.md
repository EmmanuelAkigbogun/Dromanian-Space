# Deployment

Deployment was not performed. Hosted Supabase credentials and a live Anthropic API key were unavailable. Local evidence is recorded in TESTING.md.

## Configuration

Use Node 24. Vercel builds the Vite app with `npm run build` and serves `dist`; `api/**/*.ts` are Node web handlers. `vercel.json` preserves API routes, rewrites app navigation to the SPA, allows 300-second functions and schedules the worker daily at 03:00 UTC.

Public build variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_APP_NAME`/`VITE_APP_URL`.

Server variables: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`), `ANTHROPIC_API_KEY`, `CRON_SECRET`. Optional: `VOYAGE_API_KEY`, `EMBEDDING_MODEL`, `ANTHROPIC_REFUSAL_FALLBACK`, `JOBS_BUDGET_MS`. See `.env.example`. Do not copy local emulator tokens to production.

After following DATABASE.md on a staging database, configure Supabase Auth allowed URLs and verify the private Storage buckets/policies created by migrations. Configure a model accessible to the Anthropic account through workspace AI settings; the seeded model name has not been verified with a live provider here.

## Background processing

`POST /api/jobs/run` accepts a member token and workspace ID; it nudges only that workspace's queue. `GET /api/jobs/run` requires `Authorization: Bearer <CRON_SECRET>` and performs maintenance plus a bounded queue drain. Configure that same secret in the deployment scheduler.

The supplied daily cron is suitable for Hobby scheduling restrictions, but cannot provide timely retry processing at scale. For production latency requirements, use a supported frequent scheduler and monitor backlog/dead-letter jobs. An interactive nudge is best effort and is not a substitute for a recurring worker.

## Release verification

Verify authenticated upload → Storage → extraction → search → cited answer → reviewed action using two users with different access. Test workspace switches, member removal, expired URLs, channel mentions, duplicate approvals, scheduled delivery with browsers closed and two-browser Realtime. Exercise real provider streaming/cancellation and token usage. Check worker logs/backlog and confirm server secrets do not appear in browser assets.

The local emulator does not validate these hosted-service properties. The production build still reports a large legacy main bundle; split additional legacy routes before setting strict performance targets.

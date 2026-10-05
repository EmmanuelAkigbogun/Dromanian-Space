# Testing

## Automated checks (2026-10-04)

- `npm test`: 89 tests pass in seven files against local PostgreSQL 17/PostgREST/Auth/Storage emulation.
- `npm run build`: TypeScript client/server checks and Vite production bundle pass. Main-bundle size warning remains.
- `npm run lint`: completes without errors; existing unused-code, hook dependency and Fast Refresh warnings remain.
- `npm run types:platform`: generates 95 table and 291 function contracts.

Tests cover the frozen baseline, cross-tenant authorization, legacy security fixes, queue leases/retries, scheduled delivery, Drive grants/revisions/uploads, authorized knowledge retrieval, persisted agent lifecycle/approvals, CRM and atomic message file references. Fixtures use distinct identities and workspaces; the preview account is preserved.

`tests/server/engine.test.ts` exercises real database/API plumbing with a deterministic provider double: source reading, persisted citation, document proposal and one-time approval. It also checks unauthenticated API rejection and missing-provider failure. This is not evidence of a live Anthropic completion.

## Browser verification

The isolated preview account logged in through the real local sign-in form. Verified dashboard navigation, Drive document opening/editing/saving, explicit workspace sharing, and CRM contact creation with persisted notes/activity. Agents display all eight seeded specialists and the provider configuration state. Additional browser checks and limitations are tracked in IMPLEMENTATION_STATUS.md.

## Reproduce

```sh
npm run supabase:local -- start
npm test
npm run build
npm run lint
npm run dev:local
```

On macOS the local adapter uses Homebrew PostgreSQL/PostgREST paths by default. State is under `.local/supabase`; logs are under `.local/supabase/logs`. Use `LOCAL_PG_BIN` / `LOCAL_POSTGREST_BIN` if binaries are installed elsewhere. Tests never target a hosted connection string.

## Remaining verification

No live Anthropic/Voyage call, hosted migration, production deployment, hosted cron delivery or two-user Supabase Realtime test was performed. OAuth/email flows, full accessibility audit, large-file/load testing and complete acceptance coverage of the build prompt remain outstanding. The local gateway intentionally does not implement Realtime.

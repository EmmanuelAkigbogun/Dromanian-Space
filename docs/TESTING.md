# Testing and release gates

## Fast local gates

```sh
npm run lint
npm run test:unit
npm run db:check
npm run build
npm run build:server
npm audit --omit=dev --audit-level=high
```

`db:check` applies the complete migration chain to PGlite and runs upgrade
fixtures. Unit tests require no network or external provider keys.

## Full PostgreSQL suite

Install PostgreSQL 17 and PostgREST, then:

```sh
npm run database:local -- start
npm test
npm run database:local -- stop
```

On Windows, the harness discovers PostgreSQL 18/17/16 under Program Files or
uses `LOCAL_PG_BIN`; use `LOCAL_POSTGREST_BIN` when PostgREST is elsewhere. For
an environment-independent run, `deploy/test/run.sh` builds a disposable Docker
test image with PostgreSQL, pgvector and PostgREST and publishes no ports.

## Production acceptance

Before release, also require:

- isolated encrypted-backup restore succeeds and `/api/ready` is healthy;
- two-user signup/General and Drive sharing/denial journeys pass;
- voice/video works between two networks with forced relay and in a six-person
  mesh test;
- desktop, tablet and mobile visual checks pass;
- keyboard navigation, focus, contrast, labels and reduced motion pass;
- no high-severity production dependency findings remain.

No live AI-provider request belongs in deterministic CI. After deployment, run
one controlled agent request per configured provider and verify streaming,
usage accounting and that no key is returned to the browser.

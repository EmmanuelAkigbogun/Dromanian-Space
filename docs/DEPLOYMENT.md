# Deployment

Production is built from the root `docker-compose.yml`. The stack contains a
mount guard, PostgreSQL, a one-shot migrator, private PostgREST, API, worker,
Coturn and Nginx web service. Only the loopback web port and TURN ports are
published.

Deployment order is intentionally enforced by health/dependency checks:

```text
mount guard → PostgreSQL → migrations → PostgREST → API/worker → web
                                      └──────────→ Coturn (independent media relay)
```

Before a production deploy, require an encrypted backup and a successful
isolated restore drill. Configure from `.env.production.example`; never commit
real credentials. The authoritative runbook is
[COOLIFY_SETUP.md](COOLIFY_SETUP.md).

For local code verification:

```sh
npm run lint
npm run test:unit
npm run db:check
npm run build
npm run build:server
```

The complete database and browser suites additionally require PostgreSQL 17 and
the browser dependencies documented in [TESTING.md](TESTING.md).

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

## Push notifications

Task assignments and approval requests can be delivered as Web Push, so people
are notified even when Darkspace is closed. Push is off until the API and worker
both have VAPID keys:

```sh
npx web-push generate-vapid-keys
```

Set `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` (a
`mailto:` or `https:` contact) and redeploy. People then turn push on per
browser with **Enable push** on the Notifications page. Keep the keys stable:
replacing them invalidates every browser subscription (stale ones are removed
on the next delivery attempt). The worker only posts to the browser push
services (Google, Mozilla, Apple, Microsoft). The desktop app keeps using its
own notifications.

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

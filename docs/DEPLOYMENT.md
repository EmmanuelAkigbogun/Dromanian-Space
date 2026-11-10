# Deployment

Production is built from the root `docker-compose.yml`. The stack contains a
mount guard, PostgreSQL, a one-shot migrator, private PostgREST, API, worker,
Coturn and Nginx web service. Only the loopback web port and TURN ports are
published.

Production Dockerfile stages and Compose services use versioned image tags
plus immutable manifest digests. Upgrade both together after reviewing the
upstream release; release tests reject mutable production image references.

Deployment order is intentionally enforced by health/dependency checks:

```text
mount guard → PostgreSQL → migrations → PostgREST → API/worker → web
                                      └──────────→ Coturn (independent media relay)
```

Before a production deploy, require the newest encrypted backup to have an
exact SHA-256 success proof and a successful isolated restore drill. The
default/recommended `BACKUP_STORAGE_POLICY=offsite` additionally requires a
verified off-server copy. An explicit `BACKUP_STORAGE_POLICY=local` skips
`rclone` and offsite proof but emits a warning because host or disk loss can
destroy both production data and its only backup; stale offsite markers are
ignored under that policy. The age private identity must then be removed from
the server. Run
`PREFLIGHT_PHASE=predeploy deploy/preflight.sh` before changing the stack and
`PREFLIGHT_PHASE=postdeploy deploy/preflight.sh` after it is healthy. Both
enforce the recovery conditions against archive-name-and-SHA-256 proof markers;
filename-only or stale markers fail closed. The
post-deploy phase additionally requires the private browser scraper's
authenticated end-to-end smoke test. This two-phase gate permits the first
rollout from a release that does not yet contain Crawl4AI without weakening the
post-deploy acceptance check. Set `APP_COMPOSE_PROJECT` to the exact app
Compose label for both gates, or supply an explicit `DB_CONTAINER`; broad
service-name discovery is intentionally rejected on multi-project hosts.
The preflight reads Docker port bindings from each selected private container
instead of scanning fixed host ports: arbitrary or IPv4/IPv6 wildcard mappings
fail, loopback-only mappings are allowed, and listeners owned by unrelated
Compose projects are ignored.
Configure from `.env.production.example`; never commit real credentials. The authoritative runbook is
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

# Social browser isolation

Social login and publishing fail closed unless `SOCIAL_BROWSER_WS_ENDPOINT`
and `SOCIAL_BROWSER_TOKEN` point to a dedicated, token-protected Puppeteer CDP
service over `wss://`. Plaintext `ws://` is rejected because CDP carries typed
credentials and session cookies. The service must support
`Target.createBrowserContext`; Darkspace creates a fresh isolated context for
every login, cookie check and publish operation, never uses the remote
browser's default context, closes that context, then disconnects. The API and
worker images intentionally contain no Chromium and never
launch a browser with `--no-sandbox`; they hold database, signing and provider
credentials and are not a safe browser sandbox. Run the browser service in a
separate container/host with no application secrets and no route to private
application networks. Cookie-based social actions remain unavailable until
that service is configured; calendar drafting and approval workflows continue
to work without it.

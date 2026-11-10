# Private browser scraper

Darkspace uses [Crawl4AI](https://github.com/unclecode/crawl4ai) (Apache-2.0), pinned to the immutable multi-platform digest for `unclecode/crawl4ai:0.9.5`, to let approved research agents read browser-rendered public pages.

## Production

The Compose stack provisions the scraper automatically:

- it has no published host port;
- `/md` requests require a bearer token;
- a digest-pinned, networkless one-shot helper generates and atomically installs a purpose-specific random token, so neither it nor the third-party container receives the application signing secret;
- the helper has no network interface, and Crawl4AI runs on a dedicated network with no API, worker, database or other application containers;
- API and worker connect only to a digest-pinned, unprivileged Nginx gateway on the normal application network; the gateway is the sole member of both networks and forwards only `GET /schema` and `POST /md` to a fixed Crawl4AI upstream;
- the API status endpoint caches a short authenticated `/schema` probe, so a bad token cannot appear ready merely because public `/health` responds;
- arbitrary JavaScript, cookies, request-supplied proxy/browser settings and deep crawling are not enabled;
- the application and Crawl4AI both reject private, loopback, link-local and metadata destinations;
- responses are limited to 1 MiB, tool output to 40,000 characters, and each page load to 30 seconds.

The crawler and gateway use read-only root filesystems, private temporary
filesystems, dropped Linux capabilities, no privilege escalation and bounded
resources. The gateway has no token or application secret, exposes no generic
proxy route, and re-resolves only the literal `crawl4ai` upstream through
Docker DNS. Even if a page controls crawler output, it cannot resolve or open a
connection to `api` or `worker`.

After each production rollout, run the authenticated end-to-end check from the
new API container:

```bash
docker compose exec -T api node tools/browser-scraper-smoke.mjs
```

This checks the protected boundary through the gateway and performs one
browser-rendered scrape of `https://example.com/`. Set `CRAWL4AI_SMOKE_URL` on that command when the
deployment has an explicit outbound test page. Production
`PREFLIGHT_PHASE=postdeploy deploy/preflight.sh` resolves the current API
container by Compose labels and runs this same check automatically. It also
proves the live network topology, verifies that Crawl4AI cannot resolve or
connect directly to API/worker, and probes the authenticated gateway from the
worker. A public health endpoint alone is not accepted as scraper readiness.
The pre-deploy phase may defer these checks while upgrading a release that does
not yet have the isolated gateway.

### Token rotation

`CRAWL4AI_TOKEN_EPOCH` defaults to `1`. Increment it whenever the private
scraper credential should rotate, then recreate `browser-scraper-token`,
`crawl4ai`, `api` and `worker` in the same Compose rollout. The helper creates
a new random token; the epoch is part of each consumer's Compose configuration,
which forces them to restart together. If a partial rollout leaves mismatched
credentials, the authenticated health check fails closed rather than
advertising the scraper as ready. Rotating `APP_JWT_SECRET` does not expose or
derive this independent credential.

## Local development

Run a pinned container on loopback with a random token, then set these server-only values in `.local/.env`:

```dotenv
CRAWL4AI_URL=http://127.0.0.1:11235
CRAWL4AI_API_TOKEN=replace-with-a-long-random-token
```

Do not prefix either variable with `VITE_`; the token must never reach browser code. The agent tool sends only the public URL plus the fixed `fit` cleanup mode to Crawl4AI's narrow `/md` endpoint. Returned Markdown is explicitly wrapped as untrusted external data before it reaches the model.

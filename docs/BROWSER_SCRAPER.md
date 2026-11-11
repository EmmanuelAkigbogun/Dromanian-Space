# Private browser scraper

Darkspace uses [Crawl4AI](https://github.com/unclecode/crawl4ai) (Apache-2.0), pinned to the immutable multi-platform digest for `unclecode/crawl4ai:0.9.5`, to let approved research agents read browser-rendered public pages.

## Production

The Compose stack provisions the scraper automatically:

- Crawl4AI uses Docker's stock `bridge` network mode, preventing Coolify from
  injecting its shared application network;
- the Nginx gateway shares only Crawl4AI's network namespace, reaches the raw
  backend over loopback, and is the only process published on the Docker
  bridge gateway (`DOCKER_HOST_GATEWAY_IP:11235` maps to gateway port 8080);
- Crawl4AI's raw port 11235 is never published;
- `/md` requests require a bearer token;
- a digest-pinned, networkless one-shot helper generates and atomically installs a purpose-specific random token, so neither it nor the third-party container receives the application signing secret;
- the helper has no network interface, and neither Crawl4AI nor its gateway is
  attached to the API, worker, database or Coolify base network;
- API and worker resolve `host.docker.internal` to the Docker bridge gateway
  and connect only to the digest-pinned, unprivileged Nginx gateway, which
  forwards only `GET /schema` and `POST /md` to `127.0.0.1:11235`;
- the API status endpoint caches a short authenticated `/schema` probe, so a bad token cannot appear ready merely because public `/health` responds;
- arbitrary JavaScript, cookies, request-supplied proxy/browser settings and deep crawling are not enabled;
- the application and Crawl4AI both reject private, loopback, link-local and metadata destinations;
- responses are limited to 1 MiB, tool output to 40,000 characters, and each page load to 30 seconds.

The crawler and gateway use read-only root filesystems, private temporary
filesystems, dropped Linux capabilities, no privilege escalation and bounded
resources. The gateway has no token or application secret and exposes no
generic proxy route. Raw Crawl4AI has no host mapping: the one host-gateway
mapping targets Nginx port 8080 inside their shared namespace. Even if a page
controls crawler output, it cannot resolve or open a connection to `api` or
`worker`; API and worker likewise cannot resolve or connect to the crawler's
raw bridge address.

Before Compose is parsed, set `DOCKER_HOST_GATEWAY_IP` to the exact stock
bridge gateway on the deployment host:

```bash
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

Do not use `0.0.0.0`, a public interface, or an address copied from another
host. The post-deploy preflight requires an exact single
`gateway-ip:11235 -> 8080/tcp` mapping and rejects every other binding. It also
requires Crawl4AI to be the stock `bridge` network's sole container endpoint;
move any unrelated default-bridge container to its own user-defined network
before deployment, otherwise it could reach raw Crawl4AI by bridge IP.

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
proves the live namespace and host-port topology, verifies both directions
cannot reach each other's raw services, confirms `/health` is hidden by the
fixed-route gateway, and probes the authenticated gateway from the worker. A
public health endpoint alone is not accepted as scraper readiness.
The pre-deploy phase accepts either an empty stock bridge for the first rollout
or the current selected Compose project's exact isolated scraper topology:
Crawl4AI must be the bridge's sole endpoint, its gateway must share that
namespace without another network, and the only host binding must remain
`bridge-gateway:11235 -> 8080/tcp`. This permits safe repeat deployments while
still rejecting unrelated default-bridge endpoints, a raw crawler binding, or
an ambiguous namespace. Candidate runtime probes remain deferred so an older
release can be upgraded. Post-deploy then revalidates the new topology and runs
every authenticated and isolation probe.

### Token rotation

`CRAWL4AI_TOKEN_EPOCH` defaults to `1`. Increment it whenever the private
scraper credential should rotate, then recreate `browser-scraper-token`,
`crawl4ai`, `crawl4ai-gateway`, `api` and `worker` in the same Compose rollout. The helper creates
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

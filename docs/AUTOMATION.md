# Automation with n8n (optional)

Dromanian Space works fully without n8n. Agent conversations, Team Chat, scheduled messages,
document indexing, Drive maintenance and CRM all run on the app's own PostgreSQL-backed job queue
and worker (with `pg_cron` where available). Use n8n only to connect external systems, for example:

- a new web-form lead asks the Sales Development agent for a qualification note;
- a nightly workflow asks the Business Researcher for a competitor summary and emails it.

## Division of work (no duplicate executions)

| Work | Runs in | Never in |
| --- | --- | --- |
| Internal maintenance, scheduled messages, indexing, agent runs | App worker / `pg_cron` (one authoritative scheduler per task) | n8n |
| External triggers and delivery to other systems | n8n | App worker |

n8n can only **ask** the app to start an agent run, through a signed API. It never executes the
app's jobs. Every request carries a `request_id`, and the app starts at most one run per key and
`request_id`. A retried or duplicated n8n execution gets the original run back.

## Deploy n8n

1. `sudo deploy/prepare-host.sh --apply --with-n8n` creates `/srv/app-data/dromanian-space/n8n/{db,data}`.
2. In Coolify, add a Docker Compose resource from this repository with base directory
   `/deploy/n8n`.
3. Add the variables from `deploy/n8n/.env.example`, generating each secret with `openssl rand -hex 24`.
   **Back up `N8N_ENCRYPTION_KEY`**: without it, n8n's saved credentials cannot be decrypted.
4. Set the domain `https://n8n.purplehive.pro:5678` on the `n8n` service, then deploy. On the
   production Cloudflare Tunnel host, route that hostname to the loopback-only origin
   `http://127.0.0.1:3010`; never expose port 3010 on a public interface.
5. Create the n8n owner account immediately; the first visitor can claim it.
6. On the Dromanian Space application resource, set `N8N_BASE_URL=https://n8n.purplehive.pro`
   and redeploy. Callbacks are only ever sent to this host.

n8n has its own PostgreSQL (never the application database), keeps 14 days of execution data, and has
execution timeouts (5 minutes by default, 1 hour at most). Its database is included in backups when
`N8N_DB_CONTAINER` is set in `backup.env`.
For Coolify's timestamped container names, set `N8N_COMPOSE_PROJECT` to the n8n application UUID
instead; the backup resolves the running `n8n-db` container from its Compose labels.

## Create an automation key

In **Agents → AI settings → Automation (n8n)**, a workspace admin creates a key. The key id and a
64-character secret are shown once. Store the secret in an n8n credential (for example a "Custom
Auth" or a variable used by a Code node), never in a workflow's plain text.

- Runs started with a key act as the admin who created it, with that person's **current** access.
  If they leave the workspace, the key stops working.
- Revoke a key at any time. The settings dialog shows requests and failures in the last 24 hours;
  admins can read the full execution log (`automation_requests`).

## API

`POST https://darkspace.purplehive.pro/api/integrations/n8n/runs`

```json
{ "agent": "vera", "message": "Summarize our three main competitors.", "request_id": "lead-2026-10-19-0042",
  "callback_url": "https://n8n.digitalromanian.com/webhook/dromanian-result" }
```

- `agent`: the agent's handle (for example `juno`, `rio`, `vera`, `team` for Team Chat).
- `request_id`: 8–120 characters (`A–Z a–z 0–9 . _ : -`). It is unique per key; reusing it returns
  the same run.
- `callback_url` (optional): must be on `N8N_BASE_URL`'s host.

Responses:

- `202 {"request_id", "run_id", "status", "reused"}`.
- `401`: missing, expired or invalid signature.
- `403`: key revoked, agent not allowed, or no access.
- `429`: quota or concurrency limit. Retry later with the same `request_id`.

`GET https://darkspace.purplehive.pro/api/integrations/n8n/runs?run_id=<id>` returns the status
and, once finished, the output, but only for runs started with the same key.

### Signing requests

Every request carries three headers:

- `x-dromanian-key`: the key id;
- `x-dromanian-timestamp`: Unix seconds, within 5 minutes of the server's clock;
- `x-dromanian-signature`: `v1=` followed by the hex HMAC-SHA256, using the key's secret, of
  `timestamp + "." + METHOD + "." + path_and_query + "." + raw_body`.

For a GET the body is empty. The path is the API path, for example `/api/integrations/n8n/runs`.

n8n Code node (the compose file allows `crypto` in Code nodes):

```js
const crypto = require('crypto');
const secret = $env.DROMANIAN_KEY_SECRET;      // or read it from a credential
const keyId = $env.DROMANIAN_KEY_ID;
const body = JSON.stringify({ agent: 'vera', message: $json.question, request_id: `${$execution.id}` });
const ts = Math.floor(Date.now() / 1000).toString();
const signature = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.POST./api/integrations/n8n/runs.${body}`).digest('hex');
return [{ json: { body, headers: { 'content-type': 'application/json', 'x-dromanian-key': keyId, 'x-dromanian-timestamp': ts, 'x-dromanian-signature': signature } } }];
```

Then send it with an HTTP Request node, using the raw `body` exactly as signed.

The importable workflow at
`deploy/n8n/workflows/darkspace-signed-agent-run.json` keeps key material in runtime environment
variables, signs the exact raw request body, and starts a small `hey` run against the Gemini agent.
It is intentionally inactive after import; run it manually to test a credential or copy its signing
nodes into an authenticated production workflow.

### Callbacks

When a run finishes, the worker POSTs this to `callback_url`:

```json
{ "request_id", "run_id", "status", "agent", "output", "error_code", "error_message", "finished_at" }
```

It is signed the same way, with `x-dromanian-timestamp` and `x-dromanian-signature` over the
callback URL's path. Verify the signature in n8n before trusting the payload.

Delivery is a background job:

- 15-second timeout;
- up to 6 attempts with backoff;
- no redirects followed;
- 4xx responses other than 408/429 are not retried.

The outcome (`delivered`, `delivery_failed`, `no_callback`) is recorded in the execution log.
`awaiting_approval` means the agent proposed actions that a person must approve in the app; n8n
cannot approve them.

## License

n8n is distributed under the **Sustainable Use License** (fair-code), not an OSI open-source license.
In summary, and not as legal advice:

- **Allowed:** internal business use, such as automating your own company's processes.
- **Not allowed without an n8n commercial agreement:** offering n8n itself to others as a hosted
  service, white-labelling it, or embedding it so that your customers or tenants use n8n (for
  example, letting Dromanian Space customers build workflows in your n8n).

Read the current license at <https://github.com/n8n-io/n8n/blob/master/LICENSE.md> (and
`LICENSE_EE.md` for enterprise features) before any multi-tenant or commercial use.

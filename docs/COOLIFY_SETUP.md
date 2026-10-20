# Coolify production setup

Dromanian Space runs as one self-hosted Docker Compose resource. PostgreSQL,
PostgREST, the API, worker, file storage, web server and Coturn remain on your
server. No Supabase project or hosted database is used.

## 1. Prepare the host

Use Ubuntu with Docker Compose 2.24.4 or newer. Attach the intended application
and cloud-data disks, then run:

```sh
sudo deploy/prepare-host.sh --apply
```

If separate disks are deliberately unavailable, add `--allow-system-disk` and
make sure the off-server backup is enabled. The script creates fail-closed mount
markers and these persistent locations:

- `/srv/app-data/dromanian-space/postgres`
- `/srv/app-data/dromanian-space/config`
- `/srv/app-data/dromanian-space/coturn`
- `/srv/app-data/dromanian-space/backup-staging`
- `/srv/cloud-data/dromanian-space/storage`

## 2. DNS and firewall

Point `darkspace.purplehive.pro` and `turn.purplehive.pro` at the server. Permit:

- HTTPS for the application through the existing reverse proxy;
- TURN TCP and UDP 3478;
- TURN TLS TCP 5349;
- TURN relay TCP and UDP 49160–49200.

Put the TURN certificate and private key at
`/srv/app-data/dromanian-space/coturn/fullchain.pem` and `privkey.pem`.

## 3. Configure the resource

Create one Coolify Docker Compose resource from the repository root and use
`docker-compose.yml`. Copy `.env.production.example` into Coolify's environment
editor and supply every blank secret. Generate independent random values (at
least 32 bytes) for database, session, storage-signing and TURN secrets.

The required enrollment values are already the defaults:

```env
DEFAULT_WORKSPACE_SLUG=digital-romanian
DEFAULT_CHANNEL_SLUG=general
```

Only `@digitalromanian.com` can register. On an empty database the first account
must be `samuel.buzatu@digitalromanian.com`; it becomes the platform admin and
owner of Digital Romanian. Signup atomically creates/enrolls the profile,
workspace and General membership.

Set the web port to the loopback port used by the host proxy (3008 by default).
Never expose PostgreSQL or PostgREST publicly.

## 4. Back up before the first migration

Install age and rclone, configure a generic S3-compatible remote, keep the age
private identity offline, and install the timer described in
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md). Take a backup and complete the
isolated restore drill before deploying a migration to production.

An existing installation without a valid backup is a deployment blocker.

## 5. Deploy

Use a short maintenance window:

1. Confirm the newest encrypted archive exists remotely and its restore drill
   passed.
2. Deploy the Compose resource. The one-shot `migrate` service runs after the
   database is healthy; PostgREST and the app wait for it.
3. Confirm `https://darkspace.purplehive.pro/api/ready` returns 200.
4. Confirm every long-running service is healthy and the migration container
   exited successfully.
5. Enable the backup timer and monitoring.

The product-repair migration is additive and idempotent. It backfills General
membership, marks General as the default, locks call writes behind the API, and
adds server cleanup for stale calls/signals.

## 6. Acceptance checklist

- Register the first administrator, then a second company user; both land in
  Digital Romanian and `#general`.
- Confirm a non-company email is rejected and no account is left behind.
- Upload, overwrite, share, range-download, delete and restore a Drive file.
- Confirm a non-recipient cannot read a private file or signed URL after expiry.
- Test audio/video between two different networks and verify the selected ICE
  candidate is `relay`; then exercise a multi-user call.
- Enter Anthropic/OpenAI keys in Agents → AI settings as platform admin. Reload
  and confirm only configured/source state returns—not the key.
- Test desktop, tablet, mobile, keyboard focus and reduced-motion mode.
- Run the release gates in [TESTING.md](TESTING.md).

Monitor `/api/ready`, upload failures, storage reconciliation warnings, SSE
reconnects, call completion/missed-call rates, disk usage, worker health and the
timestamp in `backup-staging/last-success`.

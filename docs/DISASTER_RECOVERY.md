# Disaster recovery

The standalone stack targets a recovery point of at most 24 hours with the
default daily schedule and a recovery time of a few hours on prepared hardware.
Run backups more often if the business requires a smaller recovery point.

## Backup contents and guarantees

`deploy/backup/backup.sh` creates
`dromanian-space-<UTC stamp>.tar.age`, encrypted to the public recipients in
`backup-recipients.txt`.

| Archive member | Contents |
| --- | --- |
| `globals.sql` | PostgreSQL roles |
| `database.dump` | Custom-format logical dump of the standalone PostgreSQL database |
| `storage.tar` | Uploaded bytes plus encrypted AI-provider settings from the durable storage mount |
| `config.tar` | Protected operator configuration and backup settings |
| `n8n.dump` | Optional n8n database |
| `MANIFEST` | Image, migrations and SHA-256 checksums |

The exact running API and worker containers are resolved and verified by
Compose project/service labels and command before both are paused. While writes
are quiesced, the backup waits (for at most 30 seconds) for in-flight database
clients to become idle, then dumps the database first and archives
storage/config bytes, so every object the dump references must be present in
the following file archive. Any drain timeout, tar warning or tar error fails
the backup. Both containers are resumed immediately after that local capture
(and by the exit trap on any
failure), before optional n8n capture, encryption or off-site transfer. Live
PostgreSQL data directories are never copied.

Archives are retained locally for `RETENTION_DAYS` (14 by default).
`BACKUP_STORAGE_POLICY` accepts exactly `offsite` or `local` and defaults to
the recommended, fail-closed `offsite` policy. In offsite mode the archive is
copied to the required `RCLONE_REMOTE` and verified at the remote; an empty
destination or missing `rclone` fails before a backup is started. A successful
`rclone check` records the archive name and encrypted archive SHA-256 in
`last-offsite-success`. Verification streams the uploaded object back through
`rclone` and hashes its actual bytes, so a provider that lacks a compatible
native checksum cannot silently fall back to a size-only proof.

`BACKUP_STORAGE_POLICY=local` is an explicit weaker option for operators who
want the encrypted archive kept only in `BACKUP_ROOT`. It does not require
`rclone` or `RCLONE_REMOTE`, and the backup verifies the local archive bytes
before recording `last-success`. It prints a same-host risk warning: host or
disk loss can destroy both production data and its only backup. Production
preflight ignores even a stale `last-offsite-success` marker in this mode, but
still requires the newest archive's exact local SHA-256 proof and a matching
successful isolated restore drill. A success updates `last-success`; a failure
updates `last-failure`, exits non-zero and optionally pings
`HEALTHCHECK_URL/fail`.
`last-success`, `last-offsite-success` and
`last-restore-drill` all use `UTC-timestamp archive-name SHA-256`. The preflight
recalculates the newest archive's digest and rejects legacy, missing or
filename-only markers, so replacing bytes under a reused name cannot satisfy a
recovery gate.

Keep the age private identity offline in two independent encrypted locations.
The server only needs the public recipient file. Losing the private identity
makes every archive unrecoverable. Both production preflight and the backup
job reject age private-key material under the production config directory, so
an identity temporarily brought in for a drill cannot be captured in the next
archive.

## Installation

```sh
sudo cp deploy/backup/dromanian-backup.{service,timer} /etc/systemd/system/
sudo cp deploy/backup/backup.env.example /srv/app-data/dromanian-space/config/backup.env
sudo chmod 600 /srv/app-data/dromanian-space/config/backup.env
sudo systemctl daemon-reload
sudo systemctl enable --now dromanian-backup.timer
sudo systemctl start dromanian-backup.service
sudo systemctl status dromanian-backup.service --no-pager
```

Set `AGE_RECIPIENTS_FILE`, `PGPASSWORD_FILE`, `BACKUP_STORAGE_POLICY` and the
monitoring URL before enabling the timer. For the default `offsite` policy,
also configure the generic S3-compatible rclone remote. For an intentional
same-host-only backup, set `BACKUP_STORAGE_POLICY=local` and leave
`RCLONE_REMOTE` empty. Set
`APP_COMPOSE_PROJECT` to the exact `com.docker.compose.project` label of the
Darkspace stack (recommended for Coolify), or pin `DB_CONTAINER` explicitly.
The backup refuses generic service-name discovery and verifies the selected
container's Compose labels, PostgreSQL image and writable bind source before it
dumps anything. It likewise requires exactly one verified API and worker in
that same project; explicit `API_CONTAINER`/`WORKER_CONTAINER` overrides do not
bypass those checks.

## Verification and restore drill

Run the quick integrity/data check monthly and the complete application drill
after backup or migration changes:

```sh
AGE_IDENTITY_FILE=/secure/offline.key deploy/backup/verify-restore.sh <archive>

AGE_IDENTITY_FILE=/secure/offline.key \
STACK_ENV_FILE=/srv/app-data/dromanian-space/config/app.env \
deploy/backup/restore-test.sh run <archive>
deploy/backup/restore-test.sh down
```

The full drill uses an isolated Compose project, isolated files under
`/srv/app-data/dromanian-space-restore-test`, and a loopback-only web endpoint
on `127.0.0.1:18000`. It validates checksums, rebuilds the schema, restores rows
and files, starts the real database/migrator/PostgREST/Agno/worker/API/web
readiness chain, and requires `/api/ready` to pass. The drill network is
internal, preventing restored jobs or credentials from reaching third-party
services. LiveKit, Coturn, OnlyOffice and the browser scraper are not started;
the override also removes all LiveKit/Coturn host port bindings. A successful
run records the archive name and verified encrypted
archive SHA-256 in `backup-staging/last-restore-drill`. Remove the
offline identity from the server after the drill; production preflight rejects
both the known identity path and age private-key material anywhere under the
production config directory. The drill root is fixed: the script canonicalizes
the path and `down` deletes only the exact dedicated directory, never a custom
path containing a similar name.

The script obtains the isolated database container's effective password without
printing it, stores it as mode `0600` only under the fixed restore root, and
removes it after restore/storage verification (also via an exit trap on
failure). Restored production worker-heartbeat rows are cleared before startup,
so `/api/ready` must observe the drill's real worker rather than stale liveness
evidence from the backup.

Run these steps in this order before every production deployment:

1. Choose the policy in protected `backup.env` and run a new backup. With the
   recommended `offsite` policy, configure non-empty `RCLONE_REMOTE` and
   confirm `last-success` and `last-offsite-success` contain the same newest
   archive name and SHA-256. With an explicit `local` policy, confirm
   `last-success` names the newest local archive and contains its recalculated
   SHA-256; understand that the same host/disk remains a single failure domain.
2. Bring the age identity from offline storage only for the duration of the
   isolated drill, run `restore-test.sh run` against that newest archive, and
   complete any manual sign-in/file checks required by the change.
3. Run `restore-test.sh down`, securely remove the identity from the production
   host, then run `PREFLIGHT_PHASE=predeploy deploy/preflight.sh`. The preflight
   requires policy-appropriate proof and the restore marker to match the exact
   newest archive. Offsite mode requires the matching offsite marker; local
   mode ignores stale offsite markers. After the release starts, require
   `PREFLIGHT_PHASE=postdeploy deploy/preflight.sh` as the acceptance gate.

## Full recovery

1. Announce maintenance and stop the application. If PostgreSQL still runs,
   take one final encrypted backup.
2. Move the damaged data aside; do not delete it. For example, move
   `/srv/app-data/dromanian-space/postgres` to a timestamped `.broken` path and
   create an empty `postgres` directory owned by the database container.
3. Start only the fresh `db`, then run `docker compose run --rm migrate` with
   the original `POSTGRES_PASSWORD`, `DATABASE_API_PASSWORD` and
   `APP_JWT_SECRET`.
4. Inspect the archive:
   `AGE_IDENTITY_FILE=... deploy/backup/restore.sh <archive> --manifest`.
5. Restore into the fresh target with `DB_CONTAINER`, `DB_USER=postgres`,
   `STORAGE_DIR`, `PGPASSWORD_FILE`, and `AGE_IDENTITY_FILE` set.
6. Start the complete stack, require `/api/ready` to pass, then sign in and open
   a restored Drive object before ending maintenance.

`restore.sh` refuses a database that already contains users/workspaces and a
storage directory that already contains files.

## Incident notes

- Bad release: redeploy the prior application image; additive migrations keep
  the prior version usable.
- Failed migration: each migration and ledger entry is transactional. Fix
  forward with a new migration; never edit an applied migration.
- Provider-key leak: revoke it with the provider, replace it in the admin AI
  settings, and confirm the old key no longer authenticates.
- JWT-secret rotation: all sessions and saved AI-provider keys encrypted from
  that secret become invalid; replace provider keys after rotation.
- Backup identity leak: create new age recipients and retire archives encrypted
  to the compromised identity after a verified replacement backup exists.

## Restore record

| Date | Archive | Type | Result | Recovery point | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

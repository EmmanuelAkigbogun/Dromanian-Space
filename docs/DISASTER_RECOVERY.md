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

The worker is paused while the database and filesystem snapshots are made. The
database is dumped first, so every object it references must be present in the
following file archive. Live PostgreSQL data directories are never copied.

Archives are retained locally for `RETENTION_DAYS` (14 by default), copied to
`RCLONE_REMOTE`, and verified at the remote. A success updates `last-success`; a
failure updates `last-failure`, exits non-zero and optionally pings
`HEALTHCHECK_URL/fail`.

Keep the age private identity offline in two independent encrypted locations.
The server only needs the public recipient file. Losing the private identity
makes every archive unrecoverable.

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

Set `AGE_RECIPIENTS_FILE`, `PGPASSWORD_FILE`, the generic S3-compatible rclone
remote and monitoring URL before enabling the timer.

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
and files, starts the actual API, and requires `/api/ready` to pass. Record the
date, archive and result. Remove the offline identity from the server after the
drill.

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

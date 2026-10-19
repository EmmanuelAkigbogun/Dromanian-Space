# Disaster recovery

Targets with the default schedule: **recovery point** up to 24 hours (daily backup at 02:30),
**recovery time** a few hours on prepared hardware. Run backups more often if you need a smaller
recovery point.

## What is backed up

`deploy/backup/backup.sh` runs daily through `dromanian-backup.timer`. Each run writes one archive,
`dromanian-space-<UTC stamp>.tar.age`, encrypted with [age](https://age-encryption.org) to the
public key in `backup-recipients.txt`:

| File in the archive | Contents |
| --- | --- |
| `globals.sql` | Database roles |
| `database.dump` | Logical dump of the whole database (`pg_dump -Fc`): app data, Auth users, Storage metadata, migration history |
| `dbconfig.tar` | The database's key directory (pgsodium key, image config) |
| `storage.tar` | Uploaded file bytes (`/srv/cloud-data/dromanian-space/storage`) |
| `config.tar` | `/srv/app-data/dromanian-space/config`: `supabase.env` (all Supabase secrets), backup settings, password files |
| `n8n.dump` | n8n database (if `N8N_DB_CONTAINER` is set) |
| `MANIFEST` | Creation time, database image, applied migration versions, SHA-256 of every part |

Properties:

- The app worker is paused while the database and files are captured, so no file is purged midway.
- The database is dumped first, so every file it references is included.
- Copying a live PostgreSQL data directory is **not** a backup and is not used.
- **Retention:** 14 days locally (`RETENTION_DAYS`).
- **Off-server copy:** each archive is copied with rclone to `RCLONE_REMOTE` and verified there.
  Keep the remote on another provider or physical site. A backup that exists only on the server
  does not protect against losing the server.
- **Failure detection:** a failed run exits non-zero (systemd marks the unit failed) and writes
  `backup-staging/last-failure` with the failing step. Success writes `last-success`.
  `HEALTHCHECK_URL` pings a monitor on success and `/fail` on failure. `deploy/preflight.sh` fails
  when the newest backup is older than 26 hours.
- **The private key** (`dromanian-backup.key`) never lives on the server. Keep two offline copies
  (for example a password manager and an encrypted USB stick). Without it, no backup can be read.

## Routine verification (monthly, and after any change to backups)

```sh
# Quick check: integrity, record counts, sampled files present (throwaway container, no network)
AGE_IDENTITY_FILE=~/dromanian-backup.key deploy/backup/verify-restore.sh <archive>

# Full drill: isolated Supabase stack on the same server (own Compose project, own data under
# /srv/app-data/dromanian-space-restore-test, gateway on 127.0.0.1:18000 only, no public route)
AGE_IDENTITY_FILE=~/dromanian-backup.key deploy/backup/restore-test.sh run <archive>
#   builds the schema with migrations up to the backup's version, restores data and files,
#   applies newer migrations (the upgrade path), checks Auth health and sampled files
deploy/backup/restore-test.sh down
```

Copy the key to the server only for the drill, then delete it (`shred -u`). Record the date, the
archive and the result. Production is never the target: `restore.sh` refuses any database that
already has users or workspaces, and any storage directory that already has files.

## Scenarios

### Bad application release
Redeploy the previous commit in Coolify. Data is untouched. Migrations are additive, so the
previous version keeps working with the newer schema.

### A migration failed
Each file runs in one transaction with its bookkeeping row, so a failed file left **no** partial
changes, and later files did not run. Read the error, fix forward with a new migration, run
`deploy/preflight.sh` and then `deploy/migrate.sh apply`. Never edit a file that has already been
applied: `migrate.sh` detects that as drift and stops.

### A migration succeeded but damaged data
Migrations are not assumed reversible.

- **Small, identifiable damage:** repair it with a corrective migration, using values read from a
  restore-drill stack built from the last good backup.
- **Large damage:** restore the whole database (next scenario). This loses changes made since that
  backup.

### Database corruption, or a full restore on the same server
1. Announce downtime, stop the app resource in Coolify, and take a final backup if the database
   still starts.
2. Stop the Supabase resource. Move the data aside instead of deleting it:
   `mv /srv/app-data/dromanian-space/supabase/db/data /srv/app-data/dromanian-space/supabase/db/data.broken-$(date +%F)`.
   Then `mkdir` an empty `data` directory. Do the same for `storage` only if the files are damaged.
3. Start the Supabase resource. It initializes an empty database with the **same** secrets, from
   the Coolify variables or `supabase.env`.
4. Read the backup's schema version:
   `AGE_IDENTITY_FILE=… deploy/backup/restore.sh <archive> --manifest`.
5. `deploy/migrate.sh apply --to <that version>`.
6. `DB_CONTAINER=supabase-db STORAGE_DIR=/srv/cloud-data/dromanian-space/storage AGE_IDENTITY_FILE=… deploy/backup/restore.sh <archive>`
   (with `PGPASSWORD_FILE` set).
7. `deploy/migrate.sh apply` for anything newer, then redeploy Supabase and the app.
8. Run the acceptance checklist (COOLIFY_SETUP.md section 9). Delete the moved-aside directories
   only after a week of normal operation.

### Data disk lost
The mount guard keeps Supabase down: nothing is written to the system disk. Replace and mount the
disk, run `deploy/prepare-host.sh --apply` (creates directories and markers), then follow the full
restore above.

### Server lost
1. Provision a new Ubuntu server with Coolify (COOLIFY_SETUP.md sections 1–3).
2. Fetch the latest archive from the off-server remote, then decrypt `config.tar` on your computer.
   It holds `supabase.env` with the original secrets. Reusing them keeps existing API keys, the
   app's build variables and users' password hashes valid.
3. Put `supabase.env` in `/srv/app-data/dromanian-space/config/`, then deploy the Supabase resource
   (section 5), followed by restore steps 4–7 above.
4. Deploy the app resource with the same variables. Point DNS at the new server.

### Leaked secrets
- **App provider keys** (Anthropic, OpenAI, Voyage): revoke them in the provider console, set new
  values in Coolify, and redeploy the app.
- **Supabase secret key or JWT secret:** generate new keys following Supabase's self-hosted key
  rotation guide for the pinned release (`utils/rotate-new-api-keys.sh` upstream). Update the
  Supabase resource, then the app's `SUPABASE_SECRET_KEY` and `VITE_SUPABASE_ANON_KEY`, and rebuild
  the app. Users must sign in again.
- **Automation key:** revoke it in AI settings and create a new one.
- **Backup private key:** the archives encrypted to it are readable by whoever holds it. Create a
  new key pair, update `backup-recipients.txt`, and delete old archives once new backups exist.

## Restore record template

| Date | Archive | Type (verify / drill / real) | Result | Recovery point reached | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

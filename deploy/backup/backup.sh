#!/usr/bin/env bash
# Encrypted logical backup: database (pg_dump custom format plus roles), the
# database's key directory (pgsodium), uploaded file bytes (Supabase Storage
# file backend), the protected recovery configuration and, when present, the
# n8n database. A database dump alone does not contain files.
#
# Environment (defaults match docs/COOLIFY_SETUP.md; usually set in
# /srv/app-data/dromanian-space/config/backup.env, see backup.env.example):
#   AGE_RECIPIENTS_FILE  required; public keys (age) the archive is encrypted to
#   BACKUP_ROOT          /srv/app-data/dromanian-space/backup-staging
#   STORAGE_DIR          /srv/cloud-data/dromanian-space/storage
#   CONFIG_DIR           /srv/app-data/dromanian-space/config
#   DB_CONFIG_DIR        /srv/app-data/dromanian-space/supabase/db/config
#   DB_CONTAINER         auto-detected (supabase-db)
#   DB_USER              supabase_admin (superuser, needed for roles and all schemas)
#   PGPASSWORD_FILE      optional file with that user's password
#   WORKER_CONTAINER     optional; paused during the backup so no file is purged mid-way
#   N8N_DB_CONTAINER     optional; its database is added to the archive
#   RETENTION_DAYS       14 (local copies)
#   RCLONE_REMOTE        off-server destination, e.g. offsite:dromanian-space (strongly recommended)
#   HEALTHCHECK_URL      optional ping URL (healthchecks.io, Uptime Kuma push): <url> on
#                        success, <url>/fail on failure
# Writes BACKUP_ROOT/last-success or BACKUP_ROOT/last-failure for monitoring.
set -euo pipefail
umask 077

: "${AGE_RECIPIENTS_FILE:?Set AGE_RECIPIENTS_FILE to the age public keys file}"
BACKUP_ROOT=${BACKUP_ROOT:-/srv/app-data/dromanian-space/backup-staging}
STORAGE_DIR=${STORAGE_DIR:-/srv/cloud-data/dromanian-space/storage}
CONFIG_DIR=${CONFIG_DIR:-/srv/app-data/dromanian-space/config}
DB_CONFIG_DIR=${DB_CONFIG_DIR:-/srv/app-data/dromanian-space/supabase/db/config}
DB_USER=${DB_USER:-supabase_admin}
RETENTION_DAYS=${RETENTION_DAYS:-14}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
WORKER_CONTAINER=${WORKER_CONTAINER:-}
N8N_DB_CONTAINER=${N8N_DB_CONTAINER:-}
HEALTHCHECK_URL=${HEALTHCHECK_URL:-}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
step="starting"
paused=false
work=""

ping() { [[ -n "$HEALTHCHECK_URL" ]] && curl -fsS -m 10 --retry 3 "$1" >/dev/null 2>&1 || true; }
on_exit() {
  local code=$?
  if $paused; then docker unpause "$WORKER_CONTAINER" >/dev/null 2>&1 || true; fi
  [[ -n "$work" ]] && rm -rf "$work"
  if (( code != 0 )); then
    echo "$stamp failed during: $step (exit $code)" > "$BACKUP_ROOT/last-failure" 2>/dev/null || true
    echo "BACKUP FAILED during: $step" >&2
    ping "$HEALTHCHECK_URL/fail"
  fi
}
trap on_exit EXIT

for cmd in docker age tar sha256sum flock; do
  command -v "$cmd" >/dev/null || { step="checking $cmd"; echo "Missing command: $cmd" >&2; exit 1; }
done
step="checking data mounts"
for marker in /srv/app-data/dromanian-space/.dromanian-space-mount /srv/cloud-data/dromanian-space/.dromanian-space-mount; do
  [[ -f "$marker" ]] || { echo "Data mount missing ($marker). Not backing up." >&2; exit 1; }
done

# One backup at a time.
exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || { step="waiting for lock"; echo "Another backup is running." >&2; exit 1; }

step="finding the database container"
if [[ -z "${DB_CONTAINER:-}" ]]; then
  if docker inspect supabase-db >/dev/null 2>&1; then DB_CONTAINER=supabase-db
  else DB_CONTAINER=$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}} {{.Image}}' \
    | awk '$2 ~ /^(supabase\/postgres:|dromanian-supabase-db:)/ {print $1; exit}'); fi
fi
[[ -n "${DB_CONTAINER:-}" ]] || { echo "Cannot find the Supabase database container; set DB_CONTAINER." >&2; exit 1; }

# The password travels through the environment, never the command line.
PASS_ARGS=()
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  PASS_ARGS=(-e PGPASSWORD)
fi
dbexec() { docker exec ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" "$@"; }

# The app worker (container names change between Coolify deploys): the
# container running dist-server/worker-main.mjs.
if [[ -z "$WORKER_CONTAINER" ]]; then
  for c in $(docker ps --filter label=com.docker.compose.service=worker --format '{{.Names}}'); do
    if docker inspect -f '{{json .Config.Cmd}}' "$c" | grep -q 'worker-main.mjs'; then WORKER_CONTAINER=$c; break; fi
  done
fi

# Leftovers of interrupted runs.
find "$BACKUP_ROOT" -maxdepth 1 -name '.work-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d "$BACKUP_ROOT/.work-$stamp-XXXX")

if [[ -n "$WORKER_CONTAINER" ]]; then
  step="pausing the worker"
  docker pause "$WORKER_CONTAINER" >/dev/null && paused=true
fi

step="dumping the database"
echo "Dumping database"
dbexec pg_dumpall -h 127.0.0.1 -U "$DB_USER" --globals-only > "$work/globals.sql"
dbexec pg_dump -h 127.0.0.1 -U "$DB_USER" -d postgres -Fc > "$work/database.dump"
[[ -s "$work/database.dump" ]] || { echo "Empty database dump" >&2; exit 1; }
migrations=$(dbexec psql -h 127.0.0.1 -U "$DB_USER" -d postgres -At -c \
  "SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations" 2>/dev/null || echo "")

# Files after the database: every object the dump references already exists.
# GNU tar exits 1 when a file changes while it is read (an upload in
# progress); that is a warning, not a failed backup. Exit 2 is fatal.
step="archiving uploaded files"
echo "Archiving uploaded files"
tar -C "$STORAGE_DIR" -cf "$work/storage.tar" . || [[ $? -eq 1 ]]
step="archiving configuration"
tar -C "$CONFIG_DIR" --exclude='./*.lock' -cf "$work/config.tar" .
tar -C "$DB_CONFIG_DIR" -cf "$work/dbconfig.tar" .

if $paused; then docker unpause "$WORKER_CONTAINER" >/dev/null && paused=false; fi

parts=(globals.sql database.dump storage.tar config.tar dbconfig.tar)
if [[ -n "$N8N_DB_CONTAINER" ]]; then
  step="dumping the n8n database"
  docker exec "$N8N_DB_CONTAINER" pg_dump -U n8n -d n8n -Fc > "$work/n8n.dump"
  parts+=(n8n.dump)
fi

step="writing the manifest"
{
  echo "created_utc=$stamp"
  echo "db_image=$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")"
  echo "migrations=$migrations"
  (cd "$work" && sha256sum "${parts[@]}")
} > "$work/MANIFEST"

step="encrypting"
archive="$BACKUP_ROOT/dromanian-space-$stamp.tar.age"
tar -C "$work" -cf - MANIFEST "${parts[@]}" | age -R "$AGE_RECIPIENTS_FILE" -o "$archive.partial"
mv "$archive.partial" "$archive"
echo "Wrote $archive ($(du -h "$archive" | cut -f1))"

step="applying retention"
find "$BACKUP_ROOT" -maxdepth 1 -name 'dromanian-space-*.tar.age' -mtime +"$RETENTION_DAYS" -print -delete

if [[ -n "$RCLONE_REMOTE" ]]; then
  step="copying off-server"
  rclone copy "$archive" "$RCLONE_REMOTE"
  rclone check --one-way --include "$(basename "$archive")" "$BACKUP_ROOT" "$RCLONE_REMOTE"
  echo "Copied and verified off-server at $RCLONE_REMOTE"
else
  echo "WARNING: no RCLONE_REMOTE set; this backup exists only on this server." >&2
fi

echo "$stamp $(basename "$archive")" > "$BACKUP_ROOT/last-success"
rm -f "$BACKUP_ROOT/last-failure"
ping "$HEALTHCHECK_URL"
echo "Backup complete."

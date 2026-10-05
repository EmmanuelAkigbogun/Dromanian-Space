#!/usr/bin/env bash
# Encrypted logical backup: database (pg_dump custom format plus roles),
# uploaded file bytes (Supabase Storage file backend) and the protected
# recovery configuration. A database dump alone does not contain files.
#
# Environment (defaults match docs/SELF_HOSTING.md):
#   AGE_RECIPIENTS_FILE  required; public keys (age) the archive is encrypted to
#   BACKUP_ROOT          /srv/app-data/dromanian-space/backup-staging
#   STORAGE_DIR          /srv/cloud-data/dromanian-space/storage
#   CONFIG_DIR           /srv/app-data/dromanian-space/config
#   DB_CONTAINER         supabase-db
#   DB_USER              supabase_admin (superuser, needed for roles and all schemas)
#   PGPASSWORD_FILE      optional file with that user's password
#   WORKER_CONTAINER     optional; paused during the backup so no file is purged mid-way
#   RETENTION_DAYS       14 (local copies)
#   RCLONE_REMOTE        optional off-server destination, e.g. offsite:dromanian-space
set -euo pipefail
umask 077

: "${AGE_RECIPIENTS_FILE:?Set AGE_RECIPIENTS_FILE to the age public keys file}"
BACKUP_ROOT=${BACKUP_ROOT:-/srv/app-data/dromanian-space/backup-staging}
STORAGE_DIR=${STORAGE_DIR:-/srv/cloud-data/dromanian-space/storage}
CONFIG_DIR=${CONFIG_DIR:-/srv/app-data/dromanian-space/config}
DB_CONTAINER=${DB_CONTAINER:-supabase-db}
DB_USER=${DB_USER:-supabase_admin}
RETENTION_DAYS=${RETENTION_DAYS:-14}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
WORKER_CONTAINER=${WORKER_CONTAINER:-}

for cmd in docker age tar sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }
done
for marker in /srv/app-data/dromanian-space/.dromanian-space-mount /srv/cloud-data/dromanian-space/.dromanian-space-mount; do
  [[ -f "$marker" ]] || { echo "Data mount missing ($marker). Not backing up." >&2; exit 1; }
done

# The password travels through the environment, never the command line.
PASS_ARGS=()
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  PASS_ARGS=(-e PGPASSWORD)
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$BACKUP_ROOT/.work-$stamp-XXXX")
paused=false
cleanup() {
  if $paused; then docker unpause "$WORKER_CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

if [[ -n "$WORKER_CONTAINER" ]]; then
  docker pause "$WORKER_CONTAINER" >/dev/null && paused=true
fi

echo "Dumping database"
docker exec ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" pg_dumpall -h 127.0.0.1 -U "$DB_USER" --globals-only > "$work/globals.sql"
docker exec ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" pg_dump -h 127.0.0.1 -U "$DB_USER" -d postgres -Fc > "$work/database.dump"

# Files after the database: every object the dump references already exists.
echo "Archiving uploaded files"
tar -C "$STORAGE_DIR" -cf "$work/storage.tar" .
echo "Archiving recovery configuration"
tar -C "$CONFIG_DIR" -cf "$work/config.tar" .

if $paused; then docker unpause "$WORKER_CONTAINER" >/dev/null && paused=false; fi

{
  echo "created_utc=$stamp"
  echo "db_image=$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")"
  (cd "$work" && sha256sum globals.sql database.dump storage.tar config.tar)
} > "$work/MANIFEST"

archive="$BACKUP_ROOT/dromanian-space-$stamp.tar.age"
tar -C "$work" -cf - MANIFEST globals.sql database.dump storage.tar config.tar | age -R "$AGE_RECIPIENTS_FILE" -o "$archive"
echo "Wrote $archive ($(du -h "$archive" | cut -f1))"

find "$BACKUP_ROOT" -maxdepth 1 -name 'dromanian-space-*.tar.age' -mtime +"$RETENTION_DAYS" -print -delete

if [[ -n "$RCLONE_REMOTE" ]]; then
  rclone copy "$archive" "$RCLONE_REMOTE" && echo "Copied off-server to $RCLONE_REMOTE"
else
  echo "WARNING: no RCLONE_REMOTE set; this backup exists only on this server." >&2
fi

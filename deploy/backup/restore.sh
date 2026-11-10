#!/usr/bin/env bash
# Restores a backup's DATA into a FRESH standalone stack (new server, or an
# isolated recovery stack). It refuses any target that already holds users or
# workspaces, so it cannot overwrite a production database.
#
# Procedure (docs/DISASTER_RECOVERY.md has the full runbook):
#   1. Bring up an empty standalone stack with the SAME secrets as the backup.
#   2. Read the backup's schema version:   deploy/backup/restore.sh <archive> --manifest
#   3. Build that schema with migrations:  docker compose run --rm migrate
#   4. Restore the data and files:         DB_CONTAINER=... STORAGE_DIR=... deploy/backup/restore.sh <archive>
#   5. Restart the stack, sign in, and open a document.
#
# Environment: AGE_IDENTITY_FILE (private key; keep it off the server except
# during recovery), DB_CONTAINER (target database container; required, never
# guessed), STORAGE_DIR (target storage directory; required), PGPASSWORD_FILE.
set -euo pipefail
umask 077

archive=${1:?usage: restore.sh <archive.tar.age> [--manifest]}
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the private key file}"

work=$(mktemp -d)
cleanup() {
  [[ -n "${DB_CONTAINER:-}" ]] && docker exec "$DB_CONTAINER" rm -f /tmp/restore.dump /tmp/restore.list >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

age -d -i "$AGE_IDENTITY_FILE" "$archive" | tar -C "$work" -xf -
(cd "$work" && grep -E '^[0-9a-f]{64} ' MANIFEST | sha256sum -c --quiet -) || { echo "Checksum mismatch: the archive is damaged." >&2; exit 1; }
created=$(sed -n 's/^created_utc=//p' "$work/MANIFEST")
migrations=$(sed -n 's/^migrations=//p' "$work/MANIFEST")
latest=${migrations##*,}

if [[ "${2:-}" == "--manifest" ]]; then
  echo "Backup created: $created"
  echo "Database image: $(sed -n 's/^db_image=//p' "$work/MANIFEST")"
  echo "Latest migration: ${latest:-unknown}"
  echo "Next: run the repository migrator on a fresh standalone stack."
  exit 0
fi

: "${DB_CONTAINER:?Set DB_CONTAINER to the TARGET database container (never guessed)}"
: "${STORAGE_DIR:?Set STORAGE_DIR to the TARGET storage directory}"
PASS_ARGS=()
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  PASS_ARGS=(-e PGPASSWORD)
fi
DB_USER=${DB_USER:-postgres}
sql() { docker exec -i ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"; }

# ---- Guards: never overwrite a database or storage that holds data --------
users=$(sql -c "SELECT count(*) FROM auth.users")
workspaces=$(sql -c "SELECT CASE WHEN to_regclass('public.workspaces') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.workspaces) END")
if (( users > 0 || workspaces > 0 )); then
  echo "Refusing: the target already has $users user(s) and $workspaces workspace(s). Restore only into a fresh stack." >&2
  exit 1
fi
target=$(sql -c "SELECT coalesce(string_agg(version, ',' ORDER BY version), '') FROM app_migrations.schema_migrations" 2>/dev/null || echo "")
IFS=',' read -ra backup_versions <<< "$migrations"
for version in "${backup_versions[@]}"; do
  [[ -z "$version" || ",$target," == *",$version,"* ]] || {
    echo "The target is missing backup migration $version. Run the repository migrator, then retry." >&2
    exit 1
  }
done
if [[ ! -d "$STORAGE_DIR" ]] || find "$STORAGE_DIR" -type f -print -quit | grep -q .; then
  echo "Refusing: $STORAGE_DIR is missing or already contains files." >&2
  exit 1
fi

# ---- Data: public, auth and storage tables (not their migration ledgers) ---
docker cp "$work/database.dump" "$DB_CONTAINER:/tmp/restore.dump"
docker exec "$DB_CONTAINER" pg_restore -l /tmp/restore.dump > "$work/full.list"
grep -E '(TABLE DATA|SEQUENCE SET) (public|auth|storage) ' "$work/full.list" \
  | grep -Ev ' (auth schema_migrations|storage migrations) ' > "$work/restore.list"
docker cp "$work/restore.list" "$DB_CONTAINER:/tmp/restore.list"
# List lines read "<id>; <oid> <oid> TABLE DATA <schema> <table> <owner>".
tables=$(grep 'TABLE DATA' "$work/restore.list" | awk '{printf "\"%s\".\"%s\"\n", $(NF-2), $(NF-1)}' | sort -u | paste -sd, -)
echo "Restoring data for $(grep -c 'TABLE DATA' "$work/restore.list") tables (backup $created)"
# Rows seeded by migrations (catalogs, defaults) are replaced by the backup's.
sql -c "TRUNCATE TABLE $tables CASCADE"
docker exec ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" pg_restore -h 127.0.0.1 -U "$DB_USER" -d postgres \
  --data-only --disable-triggers --single-transaction --exit-on-error -L /tmp/restore.list /tmp/restore.dump

# ---- Files -----------------------------------------------------------------
echo "Restoring uploaded files into $STORAGE_DIR"
tar -C "$STORAGE_DIR" -xf "$work/storage.tar"

echo "Record counts"
sql -F ' ' -c "SELECT 'users', count(*) FROM auth.users UNION ALL SELECT 'workspaces', count(*) FROM public.workspaces
  UNION ALL SELECT 'messages', count(*) FROM public.messages UNION ALL SELECT 'drive_items', count(*) FROM public.drive_items
  UNION ALL SELECT 'storage_objects', count(*) FROM storage.objects"
echo "Data restored. Restart the standalone stack, then sign in and open a file."

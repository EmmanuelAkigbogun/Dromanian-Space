#!/usr/bin/env bash
# Restore a backup into an isolated, throwaway Postgres (same image as
# production, no network, no published ports) and check that database
# records and the matching file bytes are present. Production is not touched.
#
#   AGE_IDENTITY_FILE=key.txt deploy/backup/verify-restore.sh dromanian-space-<stamp>.tar.age
#
# This proves data recoverability. A full sign-in and document-access check
# needs the isolated stack described in docs/SELF_HOSTING.md.
set -euo pipefail
umask 077

archive=${1:?archive path required}
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the private key file}"
DB_IMAGE=${DB_IMAGE:-supabase/postgres:17.6.1.136}

work=$(mktemp -d)
name="dromanian-restore-check-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

age -d -i "$AGE_IDENTITY_FILE" "$archive" | tar -C "$work" -xf -
(cd "$work" && grep -E '^[0-9a-f]{64} ' MANIFEST | sha256sum -c -)
mkdir -p "$work/storage" && tar -C "$work/storage" -xf "$work/storage.tar"

password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker run -d --name "$name" --network none -e POSTGRES_PASSWORD="$password" "$DB_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 2
done

as_admin() { docker exec -i -e PGPASSWORD="$password" "$name" psql -h 127.0.0.1 -U supabase_admin -d postgres -X -q "$@"; }

echo "Restoring roles and database (errors about objects that already exist in the image are expected)"
as_admin -f - < "$work/globals.sql" >/dev/null 2>"$work/globals.err" || true
docker exec -i -e PGPASSWORD="$password" "$name" pg_restore -h 127.0.0.1 -U supabase_admin -d postgres --clean --if-exists --no-owner < "$work/database.dump" 2>"$work/restore.err" || true
echo "pg_restore reported $(grep -c 'error' "$work/restore.err" || true) error line(s); review $work/restore.err if the counts below look wrong."

echo "Record counts"
as_admin -A -t -F ' ' -c "SELECT 'users', count(*) FROM auth.users UNION ALL SELECT 'workspaces', count(*) FROM public.workspaces
  UNION ALL SELECT 'messages', count(*) FROM public.messages UNION ALL SELECT 'drive_items', count(*) FROM public.drive_items
  UNION ALL SELECT 'storage_objects', count(*) FROM storage.objects"

echo "Checking that stored objects have their bytes in the backup"
missing=0
checked=0
while IFS='|' read -r bucket objname; do
  [[ -z "$bucket" ]] && continue
  checked=$((checked + 1))
  if ! find "$work/storage" -path "*/$bucket/$objname*" -print -quit | grep -q .; then
    echo "  missing: $bucket/$objname"
    missing=$((missing + 1))
  fi
done < <(as_admin -A -t -c "SELECT bucket_id || '|' || name FROM storage.objects ORDER BY random() LIMIT 50")
echo "Checked $checked object(s); missing $missing."
[[ $missing -eq 0 ]] && echo "RESTORE CHECK PASSED" || { echo "RESTORE CHECK FAILED"; exit 1; }

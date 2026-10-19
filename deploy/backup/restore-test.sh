#!/usr/bin/env bash
# Full restore drill on an ISOLATED Supabase stack on the same server. The
# production database, files, containers, networks and public routes are
# never touched: the test stack has its own Compose project, data directory
# (RESTORE_ROOT) and a loopback-only gateway on 127.0.0.1:18000.
#
#   deploy/backup/restore-test.sh run <archive.tar.age>   up + restore + verify (stack left running)
#   deploy/backup/restore-test.sh down                   remove the test stack and its data
#
# Environment: AGE_IDENTITY_FILE (private key; bring it only for the drill),
# SUPABASE_ENV_FILE (default: the production supabase.env, so keys match the
# backup), RESTORE_ROOT (default /srv/app-data/dromanian-space-restore-test).
# Afterwards, sign-in can be checked by pointing a local app build at
# http://127.0.0.1:18000 through an SSH tunnel. Record the date and result.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
RESTORE_ROOT=${RESTORE_ROOT:-/srv/app-data/dromanian-space-restore-test}
SUPABASE_ENV_FILE=${SUPABASE_ENV_FILE:-/srv/app-data/dromanian-space/config/supabase.env}
export RESTORE_ROOT
project=dromanian-restore-test

case "$RESTORE_ROOT" in
  *restore-test*) ;;
  *) echo "RESTORE_ROOT must contain 'restore-test' (refusing $RESTORE_ROOT)" >&2; exit 1 ;;
esac

compose() {
  docker compose -p "$project" --env-file "$SUPABASE_ENV_FILE" \
    -f "$repo/deploy/supabase/docker-compose.yml" -f "$here/restore-test.override.yml" "$@"
}

case "${1:-}" in
  run)
    archive=${2:?archive path required}
    : "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE}"
    if [[ -e "$RESTORE_ROOT" ]]; then echo "$RESTORE_ROOT exists; run '$0 down' first." >&2; exit 1; fi
    mkdir -p "$RESTORE_ROOT/app/supabase/db/data" "$RESTORE_ROOT/app/supabase/db/config" "$RESTORE_ROOT/cloud/storage"
    touch "$RESTORE_ROOT/app/.dromanian-space-mount" "$RESTORE_ROOT/cloud/.dromanian-space-mount"
    echo "Starting the isolated stack (project $project)"
    compose up -d --wait db
    db=$(compose ps -q db)
    db_name=$(docker inspect -f '{{.Name}}' "$db" | sed 's#^/##')
    latest=$(AGE_IDENTITY_FILE="$AGE_IDENTITY_FILE" "$here/restore.sh" "$archive" --manifest | sed -n 's/^Latest migration: //p')
    [[ "$latest" =~ ^[0-9]{14}$ ]] || { echo "Could not read the backup's schema version" >&2; exit 1; }
    echo "Building schema up to $latest"
    DB_CONTAINER="$db_name" "$repo/deploy/migrate.sh" apply --to "$latest"
    echo "Restoring data and files"
    DB_CONTAINER="$db_name" STORAGE_DIR="$RESTORE_ROOT/cloud/storage" "$here/restore.sh" "$archive"
    echo "Applying newer migrations (the upgrade path)"
    DB_CONTAINER="$db_name" "$repo/deploy/migrate.sh" apply
    compose up -d --wait
    echo "Checking stored objects have their bytes"
    missing=0
    while IFS='|' read -r bucket objname; do
      [[ -z "$bucket" ]] && continue
      [[ -e "$RESTORE_ROOT/cloud/storage/stub/stub/$bucket/$objname" ]] \
        || find "$RESTORE_ROOT/cloud/storage" -path "*/$bucket/$objname*" -print -quit | grep -q . \
        || { echo "  missing: $bucket/$objname"; missing=$((missing + 1)); }
    done < <(docker exec "$db_name" psql -h 127.0.0.1 -U postgres -At -c "SELECT bucket_id || '|' || name FROM storage.objects ORDER BY random() LIMIT 100")
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/auth/v1/health -H "apikey: $(sed -n 's/^ANON_KEY=//p' "$SUPABASE_ENV_FILE")")
    echo "Auth health through the isolated gateway: $code"
    if (( missing == 0 )) && [[ "$code" == "200" ]]; then
      echo "RESTORE DRILL PASSED ($(date -u +%FT%TZ)). Stack left running for manual checks; remove with: $0 down"
    else
      echo "RESTORE DRILL FAILED (missing objects: $missing, auth health: $code)"; exit 1
    fi
    ;;
  down)
    compose down --remove-orphans
    docker volume rm "${project}_db-config" "${project}_deno-cache" >/dev/null 2>&1 || true
    # Data written by the database container belongs to its users; remove as root.
    rm -rf --one-file-system "$RESTORE_ROOT"
    echo "Isolated test stack and $RESTORE_ROOT removed."
    ;;
  *)
    echo "Usage: $0 run <archive.tar.age> | down" >&2
    exit 1
    ;;
esac

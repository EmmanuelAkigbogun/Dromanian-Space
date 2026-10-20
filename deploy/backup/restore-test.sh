#!/usr/bin/env bash
# Full restore drill on an isolated copy of the standalone stack.
#
#   deploy/backup/restore-test.sh run <archive.tar.age>
#   deploy/backup/restore-test.sh down
#
# STACK_ENV_FILE must contain POSTGRES_PASSWORD, DATABASE_API_PASSWORD and
# APP_JWT_SECRET. It may be a protected copy of the production stack env so
# encrypted provider settings can also be verified after restore.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
RESTORE_ROOT=${RESTORE_ROOT:-/srv/app-data/dromanian-space-restore-test}
STACK_ENV_FILE=${STACK_ENV_FILE:-/srv/app-data/dromanian-space/config/app.env}
export RESTORE_ROOT
project=dromanian-restore-test

case "$RESTORE_ROOT" in
  *restore-test*) ;;
  *) echo "RESTORE_ROOT must contain 'restore-test' (refusing $RESTORE_ROOT)" >&2; exit 1 ;;
esac

compose() {
  TURN_SHARED_SECRET=restore-test-only TURN_EXTERNAL_IP=127.0.0.1 \
    docker compose -p "$project" --env-file "$STACK_ENV_FILE" \
      -f "$repo/docker-compose.yml" -f "$here/restore-test.override.yml" "$@"
}

case "${1:-}" in
  run)
    archive=${2:?archive path required}
    : "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE}"
    [[ -f "$STACK_ENV_FILE" ]] || { echo "Missing STACK_ENV_FILE: $STACK_ENV_FILE" >&2; exit 1; }
    if [[ -e "$RESTORE_ROOT" ]]; then echo "$RESTORE_ROOT exists; run '$0 down' first." >&2; exit 1; fi
    mkdir -p "$RESTORE_ROOT/app/postgres" "$RESTORE_ROOT/app/coturn" "$RESTORE_ROOT/cloud/storage"
    touch "$RESTORE_ROOT/app/.dromanian-space-mount" "$RESTORE_ROOT/cloud/.dromanian-space-mount"
    echo "Starting isolated PostgreSQL (project $project)"
    compose up -d --wait db
    db_id=$(compose ps -q db)
    db_name=$(docker inspect -f '{{.Name}}' "$db_id" | sed 's#^/##')
    echo "Building the current schema"
    compose run --rm migrate
    echo "Restoring data and files"
    DB_CONTAINER="$db_name" DB_USER=postgres STORAGE_DIR="$RESTORE_ROOT/cloud/storage" \
      AGE_IDENTITY_FILE="$AGE_IDENTITY_FILE" "$here/restore.sh" "$archive"
    echo "Starting the isolated API and web application"
    compose up -d --wait rest api web
    echo "Checking sampled storage objects"
    missing=0
    while IFS='|' read -r bucket objname; do
      [[ -z "$bucket" ]] && continue
      [[ -e "$RESTORE_ROOT/cloud/storage/$bucket/$objname" ]] \
        || { echo "  missing: $bucket/$objname"; missing=$((missing + 1)); }
    done < <(docker exec "$db_name" psql -h 127.0.0.1 -U postgres -At -c \
      "SELECT bucket_id || '|' || name FROM storage.objects ORDER BY random() LIMIT 100")
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/api/ready)
    echo "Application readiness through isolated web gateway: $code"
    if (( missing == 0 )) && [[ "$code" == "200" ]]; then
      echo "RESTORE DRILL PASSED ($(date -u +%FT%TZ)). Stack left running for manual checks; remove with: $0 down"
    else
      echo "RESTORE DRILL FAILED (missing objects: $missing, readiness: $code)"; exit 1
    fi
    ;;
  down)
    compose down --remove-orphans
    rm -rf --one-file-system "$RESTORE_ROOT"
    echo "Isolated test stack and $RESTORE_ROOT removed."
    ;;
  *)
    echo "Usage: $0 run <archive.tar.age> | down" >&2
    exit 1
    ;;
esac

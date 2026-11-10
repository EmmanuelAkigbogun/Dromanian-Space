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
umask 077

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dedicated_restore_path=/srv/app-data/dromanian-space-restore-test
requested_restore_root=${RESTORE_ROOT:-$dedicated_restore_path}
STACK_ENV_FILE=${STACK_ENV_FILE:-/srv/app-data/dromanian-space/config/app.env}
BACKUP_ROOT=${BACKUP_ROOT:-/srv/app-data/dromanian-space/backup-staging}
RESTORE_DRILL_MARKER=${RESTORE_DRILL_MARKER:-$BACKUP_ROOT/last-restore-drill}
project=dromanian-restore-test
db_password_file=""

cleanup_restore_secret() {
  unset PGPASSWORD || true
  if [[ -n "$db_password_file" ]]; then
    rm -f -- "$db_password_file" || true
    db_password_file=""
  fi
}
trap cleanup_restore_secret EXIT

command -v realpath >/dev/null || { echo "realpath is required" >&2; exit 1; }
[[ ! -L "$requested_restore_root" && ! -L "$dedicated_restore_path" ]] || {
  echo "The dedicated restore-test root must be a real directory, not a symbolic link." >&2
  exit 1
}
dedicated_restore_root=$(realpath -m -- "$dedicated_restore_path")
[[ "$dedicated_restore_root" == "$dedicated_restore_path" ]] || {
  echo "The dedicated restore-test path has a symbolic parent (refusing $dedicated_restore_root)." >&2
  exit 1
}
RESTORE_ROOT=$(realpath -m -- "$requested_restore_root")
[[ "$RESTORE_ROOT" == "$dedicated_restore_root" ]] || {
  echo "RESTORE_ROOT must resolve to the dedicated restore-test root $dedicated_restore_root (refusing $requested_restore_root)" >&2
  exit 1
}
export RESTORE_ROOT

compose() {
  TURN_SHARED_SECRET=restore-test-only TURN_EXTERNAL_IP=127.0.0.1 \
    LIVEKIT_API_KEY=restore-test-only LIVEKIT_API_SECRET=restore-test-only \
    docker compose -p "$project" --env-file "$STACK_ENV_FILE" \
      -f "$repo/docker-compose.yml" -f "$here/restore-test.override.yml" "$@"
}

case "${1:-}" in
  run)
    archive=${2:?archive path required}
    : "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE}"
    command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }
    [[ -f "$archive" ]] || { echo "Backup archive does not exist: $archive" >&2; exit 1; }
    archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
    [[ "$archive_sha256" =~ ^[[:xdigit:]]{64}$ ]] \
      || { echo "Could not calculate the encrypted archive SHA-256." >&2; exit 1; }
    [[ -f "$STACK_ENV_FILE" ]] || { echo "Missing STACK_ENV_FILE: $STACK_ENV_FILE" >&2; exit 1; }
    if [[ -e "$RESTORE_ROOT" ]]; then echo "$RESTORE_ROOT exists; run '$0 down' first." >&2; exit 1; fi
    mkdir -p "$RESTORE_ROOT/app/postgres" "$RESTORE_ROOT/app/coturn" "$RESTORE_ROOT/cloud/storage"
    # Bind mounts keep host ownership. Match the production image users before
    # PostgreSQL or the application touches these otherwise-empty directories.
    # Failing here is safer than starting a drill that can never prove restore.
    mapfile -t restore_db_images < <(compose config --images | grep '^pgvector/pgvector:')
    (( ${#restore_db_images[@]} == 1 )) || {
      echo "Could not resolve exactly one pinned PostgreSQL image for the isolated drill." >&2
      exit 1
    }
    restore_db_image=${restore_db_images[0]}
    [[ "$restore_db_image" =~ ^pgvector/pgvector:[^@[:space:]]+@sha256:[[:xdigit:]]{64}$ ]] || {
      echo "The isolated PostgreSQL image is not pinned to a SHA-256 digest." >&2
      exit 1
    }
    docker image inspect "$restore_db_image" >/dev/null 2>&1 || docker pull "$restore_db_image" >/dev/null
    restore_db_owner=$(docker run --rm --network none --read-only --pids-limit 32 \
      --cap-drop ALL --security-opt no-new-privileges:true --entrypoint sh "$restore_db_image" \
      -c 'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')
    [[ "$restore_db_owner" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || {
      echo "Could not resolve a non-root PostgreSQL uid/gid from the pinned image." >&2
      exit 1
    }
    chown "$restore_db_owner" "$RESTORE_ROOT/app/postgres" || {
      echo "Could not assign the isolated PostgreSQL directory to the pinned image user." >&2
      exit 1
    }
    chown 1000:1000 "$RESTORE_ROOT/cloud/storage" || {
      echo "Could not assign the isolated storage directory to uid 1000." >&2
      exit 1
    }
    touch "$RESTORE_ROOT/app/.dromanian-space-mount" "$RESTORE_ROOT/cloud/.dromanian-space-mount"
    echo "Starting isolated PostgreSQL (project $project)"
    compose up -d --wait db
    db_id=$(compose ps -q db)
    db_name=$(docker inspect -f '{{.Name}}' "$db_id" | sed 's#^/##')
    db_password_file="$RESTORE_ROOT/.db-password"
    docker exec "$db_name" sh -c 'printf %s "$POSTGRES_PASSWORD"' > "$db_password_file"
    chmod 600 "$db_password_file"
    [[ -s "$db_password_file" ]] || { echo "Could not obtain the isolated database password." >&2; exit 1; }
    PGPASSWORD=$(< "$db_password_file")
    export PGPASSWORD
    db_psql() {
      docker exec -e PGPASSWORD "$db_name" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"
    }
    echo "Building the current schema"
    compose run --rm migrate
    echo "Restoring data and files"
    DB_CONTAINER="$db_name" DB_USER=postgres STORAGE_DIR="$RESTORE_ROOT/cloud/storage" \
      PGPASSWORD_FILE="$db_password_file" AGE_IDENTITY_FILE="$AGE_IDENTITY_FILE" "$here/restore.sh" "$archive"
    # Worker heartbeats are operational liveness, not business data. Removing
    # the restored production rows makes /api/ready prove this drill's worker.
    db_psql -c "TRUNCATE public.worker_heartbeats"
    echo "Starting the isolated readiness chain"
    compose up -d --wait --no-deps rest agno
    compose up -d --wait --no-deps worker
    compose up -d --wait --no-deps api
    compose up -d --wait --no-deps web
    echo "Checking sampled storage objects"
    missing=0
    sampled_objects=$(db_psql -c \
      "SELECT bucket_id || '|' || name FROM storage.objects ORDER BY random() LIMIT 100")
    while IFS='|' read -r bucket objname; do
      [[ -z "$bucket" ]] && continue
      [[ -e "$RESTORE_ROOT/cloud/storage/$bucket/$objname" ]] \
        || { echo "  missing: $bucket/$objname"; missing=$((missing + 1)); }
    done <<< "$sampled_objects"
    cleanup_restore_secret
    code=000
    for _ in {1..30}; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:18000/api/ready || true)
      [[ "$code" == "200" ]] && break
      sleep 2
    done
    echo "Application readiness through isolated web gateway: $code"
    verified_archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
    if [[ "$verified_archive_sha256" != "$archive_sha256" ]]; then
      echo "RESTORE DRILL FAILED (archive changed while the drill was running)" >&2
      exit 1
    fi
    if (( missing == 0 )) && [[ "$code" == "200" ]]; then
      drill_stamp=$(date -u +%Y%m%dT%H%M%SZ)
      marker_tmp="$BACKUP_ROOT/.last-restore-drill.$$"
      printf '%s %s %s\n' "$drill_stamp" "$(basename "$archive")" "$archive_sha256" > "$marker_tmp"
      mv -f -- "$marker_tmp" "$RESTORE_DRILL_MARKER"
      echo "RESTORE DRILL PASSED ($drill_stamp). Stack left running for manual checks; remove with: $0 down"
    else
      echo "RESTORE DRILL FAILED (missing objects: $missing, readiness: $code)"; exit 1
    fi
    ;;
  down)
    compose down --remove-orphans
    if [[ -e "$RESTORE_ROOT" || -L "$RESTORE_ROOT" ]]; then
      delete_root=$(realpath -e -- "$RESTORE_ROOT") || {
        echo "Cannot canonicalize restore-test root for deletion: $RESTORE_ROOT" >&2
        exit 1
      }
      [[ "$delete_root" == "$dedicated_restore_root" && ! -L "$RESTORE_ROOT" ]] || {
        echo "Refusing to delete anything except the exact dedicated restore-test directory." >&2
        exit 1
      }
      rm -rf --one-file-system -- "$delete_root"
    fi
    echo "Isolated test stack and $RESTORE_ROOT removed."
    ;;
  *)
    echo "Usage: $0 run <archive.tar.age> | down" >&2
    exit 1
    ;;
esac

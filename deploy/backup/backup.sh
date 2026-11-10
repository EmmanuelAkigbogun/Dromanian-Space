#!/usr/bin/env bash
# Encrypted logical backup: database (pg_dump custom format plus roles), the
# uploaded file bytes, the protected recovery configuration and, when present,
# the n8n database. A database dump alone does not contain files.
#
# Environment (defaults match docs/COOLIFY_SETUP.md; usually set in
# /srv/app-data/dromanian-space/config/backup.env, see backup.env.example):
#   AGE_RECIPIENTS_FILE  required; public keys (age) the archive is encrypted to
#   BACKUP_ROOT          /srv/app-data/dromanian-space/backup-staging
#   STORAGE_DIR          /srv/cloud-data/dromanian-space/storage
#   CONFIG_DIR           /srv/app-data/dromanian-space/config
#   APP_COMPOSE_PROJECT  exact app Compose project; required unless DB_CONTAINER is set
#   DB_CONTAINER         explicit app database container (alternative to APP_COMPOSE_PROJECT)
#   DB_DATA_DIR          expected PostgreSQL bind source
#   DB_USER              postgres (superuser, needed for roles and all schemas)
#   PGPASSWORD_FILE      optional file with that user's password
#   API_CONTAINER        optional override; exact project API is auto-discovered and paused
#   WORKER_CONTAINER     optional override; exact project worker is auto-discovered and paused
#   N8N_DB_CONTAINER     optional; its database is added to the archive
#   RETENTION_DAYS       14 (local copies)
#   BACKUP_STORAGE_POLICY offsite (default) or local. Local keeps the only copy
#                         on this host and is less resilient to host/disk loss.
#   RCLONE_REMOTE        required when BACKUP_STORAGE_POLICY=offsite, e.g.
#                         offsite:dromanian-space
#   HEALTHCHECK_URL      optional ping URL (healthchecks.io, Uptime Kuma push): <url> on
#                        success, <url>/fail on failure
# Writes BACKUP_ROOT/last-success or BACKUP_ROOT/last-failure for monitoring.
set -euo pipefail
umask 077

: "${AGE_RECIPIENTS_FILE:?Set AGE_RECIPIENTS_FILE to the age public keys file}"
BACKUP_ROOT=${BACKUP_ROOT:-/srv/app-data/dromanian-space/backup-staging}
STORAGE_DIR=${STORAGE_DIR:-/srv/cloud-data/dromanian-space/storage}
CONFIG_DIR=${CONFIG_DIR:-/srv/app-data/dromanian-space/config}
DB_DATA_DIR=${DB_DATA_DIR:-/srv/app-data/dromanian-space/postgres}
APP_COMPOSE_PROJECT=${APP_COMPOSE_PROJECT:-}
DB_USER=${DB_USER:-postgres}
RETENTION_DAYS=${RETENTION_DAYS:-14}
BACKUP_STORAGE_POLICY=${BACKUP_STORAGE_POLICY:-offsite}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
API_CONTAINER=${API_CONTAINER:-}
WORKER_CONTAINER=${WORKER_CONTAINER:-}
N8N_DB_CONTAINER=${N8N_DB_CONTAINER:-}
N8N_COMPOSE_PROJECT=${N8N_COMPOSE_PROJECT:-}
HEALTHCHECK_URL=${HEALTHCHECK_URL:-}
OFFSITE_SUCCESS_MARKER=${OFFSITE_SUCCESS_MARKER:-$BACKUP_ROOT/last-offsite-success}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
step="starting"
paused_containers=()
work=""

ping() { [[ -n "$HEALTHCHECK_URL" ]] && curl -fsS -m 10 --retry 3 "$1" >/dev/null 2>&1 || true; }
resume_app_writes() {
  local container failed=0
  local still_paused=()
  for container in "${paused_containers[@]}"; do
    if ! docker unpause "$container" >/dev/null 2>&1; then
      failed=1
      still_paused+=("$container")
    fi
  done
  paused_containers=("${still_paused[@]}")
  return "$failed"
}
on_exit() {
  local code=$?
  resume_app_writes || true
  [[ -n "$work" ]] && rm -rf "$work"
  if (( code != 0 )); then
    echo "$stamp failed during: $step (exit $code)" > "$BACKUP_ROOT/last-failure" 2>/dev/null || true
    echo "BACKUP FAILED during: $step" >&2
    ping "$HEALTHCHECK_URL/fail"
  fi
}
trap on_exit EXIT

mkdir -p "$BACKUP_ROOT"
case "$BACKUP_STORAGE_POLICY" in
  offsite)
    step="checking off-server destination"
    [[ -n "$RCLONE_REMOTE" ]] || {
      echo "Set RCLONE_REMOTE to an off-server rclone destination." >&2
      exit 1
    }
    ;;
  local)
    echo "WARNING: BACKUP_STORAGE_POLICY=local keeps recovery archives on this host; host or disk loss can destroy both production data and its backup." >&2
    ;;
  *)
    echo "BACKUP_STORAGE_POLICY must be exactly 'offsite' or 'local' (got '$BACKUP_STORAGE_POLICY')." >&2
    exit 1
    ;;
esac
required_commands=(docker age tar sha256sum flock realpath grep)
[[ "$BACKUP_STORAGE_POLICY" == offsite ]] && required_commands+=(rclone)
for cmd in "${required_commands[@]}"; do
  command -v "$cmd" >/dev/null || { step="checking $cmd"; echo "Missing command: $cmd" >&2; exit 1; }
done
step="checking data mounts"
for marker in /srv/app-data/dromanian-space/.dromanian-space-mount /srv/cloud-data/dromanian-space/.dromanian-space-mount; do
  [[ -f "$marker" ]] || { echo "Data mount missing ($marker). Not backing up." >&2; exit 1; }
done
step="checking for offline recovery keys"
if grep -R -q --binary-files=without-match 'AGE-SECRET-KEY-' "$CONFIG_DIR" 2>/dev/null; then
  echo "An age private identity is present under the production config directory; remove it before backup." >&2
  exit 1
else
  key_scan_status=$?
  [[ "$key_scan_status" == 1 ]] || {
    echo "Could not safely scan the production config directory for age private identities." >&2
    exit 1
  }
fi

# One backup at a time.
exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || { step="waiting for lock"; echo "Another backup is running." >&2; exit 1; }

step="finding the database container"
if [[ -z "${DB_CONTAINER:-}" ]]; then
  [[ -n "$APP_COMPOSE_PROJECT" ]] || {
    echo "Set APP_COMPOSE_PROJECT to the exact app Compose project or set DB_CONTAINER explicitly." >&2
    exit 1
  }
  mapfile -t db_matches < <(docker ps \
    --filter "label=com.docker.compose.project=$APP_COMPOSE_PROJECT" \
    --filter 'label=com.docker.compose.service=db' \
    --format '{{.Names}}')
  (( ${#db_matches[@]} == 1 )) || {
    echo "Expected exactly one running db container in Compose project $APP_COMPOSE_PROJECT; found ${#db_matches[@]}." >&2
    exit 1
  }
  DB_CONTAINER=${db_matches[0]}
fi

docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || { echo "Database container does not exist: $DB_CONTAINER" >&2; exit 1; }
[[ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER")" == true ]] \
  || { echo "Database container is not running: $DB_CONTAINER" >&2; exit 1; }
db_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$DB_CONTAINER")
db_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$DB_CONTAINER")
[[ "$db_service" == db && -n "$db_project" && "$db_project" != '<no value>' ]] \
  || { echo "$DB_CONTAINER is not a Compose db service." >&2; exit 1; }
[[ -z "$APP_COMPOSE_PROJECT" || "$db_project" == "$APP_COMPOSE_PROJECT" ]] \
  || { echo "$DB_CONTAINER belongs to Compose project $db_project, not $APP_COMPOSE_PROJECT." >&2; exit 1; }
APP_COMPOSE_PROJECT=$db_project
db_image=$(docker inspect -f '{{.Config.Image}}' "$DB_CONTAINER")
[[ "$db_image" == pgvector/pgvector:* || "$db_image" == postgres:* ]] \
  || { echo "$DB_CONTAINER uses unexpected database image $db_image." >&2; exit 1; }
db_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$DB_CONTAINER")
IFS='|' read -r db_mount_type db_mount_source db_mount_rw <<< "$db_mount"
expected_db_data=$(realpath -e -- "$DB_DATA_DIR") \
  || { echo "Expected database data directory is missing: $DB_DATA_DIR" >&2; exit 1; }
actual_db_data=$(realpath -e -- "$db_mount_source") \
  || { echo "Database bind source is missing: ${db_mount_source:-none}" >&2; exit 1; }
[[ "$db_mount_type" == bind && "$db_mount_rw" == true && "$actual_db_data" == "$expected_db_data" ]] \
  || { echo "$DB_CONTAINER does not use the expected writable database bind $expected_db_data." >&2; exit 1; }

# The password travels through the environment, never the command line.
PASS_ARGS=()
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  PASS_ARGS=(-e PGPASSWORD)
fi
dbexec() { docker exec ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" "$@"; }

# Resolve both application writers by exact Compose project/service labels.
# Container names change between Coolify deploys, so an explicit override is
# accepted only after the same labels, running state and expected command are
# verified. Multiple rolling-deploy containers fail closed.
if [[ -z "$API_CONTAINER" ]]; then
  mapfile -t api_matches < <(docker ps \
    --filter "label=com.docker.compose.project=$APP_COMPOSE_PROJECT" \
    --filter 'label=com.docker.compose.service=api' \
    --format '{{.Names}}')
  (( ${#api_matches[@]} == 1 )) || {
    echo "Expected exactly one running api container in Compose project $APP_COMPOSE_PROJECT; found ${#api_matches[@]}." >&2
    exit 1
  }
  API_CONTAINER=${api_matches[0]}
fi
api_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$API_CONTAINER" 2>/dev/null)
api_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$API_CONTAINER" 2>/dev/null)
api_command=$(docker inspect -f '{{json .Config.Cmd}}' "$API_CONTAINER" 2>/dev/null)
[[ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER" 2>/dev/null)" == true \
  && "$(docker inspect -f '{{.State.Paused}}' "$API_CONTAINER" 2>/dev/null)" == false \
  && "$api_service" == api && "$api_project" == "$APP_COMPOSE_PROJECT" \
  && "$api_command" == *main.mjs* && "$api_command" != *worker-main.mjs* ]] || {
  echo "$API_CONTAINER is not the selected running API from Compose project $APP_COMPOSE_PROJECT." >&2
  exit 1
}

if [[ -z "$WORKER_CONTAINER" ]]; then
  mapfile -t worker_matches < <(docker ps \
    --filter "label=com.docker.compose.project=$APP_COMPOSE_PROJECT" \
    --filter 'label=com.docker.compose.service=worker' \
    --format '{{.Names}}')
  (( ${#worker_matches[@]} == 1 )) || {
    echo "Expected exactly one running worker container in Compose project $APP_COMPOSE_PROJECT; found ${#worker_matches[@]}." >&2
    exit 1
  }
  WORKER_CONTAINER=${worker_matches[0]}
fi
worker_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$WORKER_CONTAINER" 2>/dev/null)
worker_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$WORKER_CONTAINER" 2>/dev/null)
worker_command=$(docker inspect -f '{{json .Config.Cmd}}' "$WORKER_CONTAINER" 2>/dev/null)
[[ "$(docker inspect -f '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null)" == true \
  && "$(docker inspect -f '{{.State.Paused}}' "$WORKER_CONTAINER" 2>/dev/null)" == false \
  && "$worker_service" == worker && "$worker_project" == "$APP_COMPOSE_PROJECT" \
  && "$worker_command" == *worker-main.mjs* ]] || {
  echo "$WORKER_CONTAINER is not the selected running worker from Compose project $APP_COMPOSE_PROJECT." >&2
  exit 1
}

# Leftovers of interrupted runs.
find "$BACKUP_ROOT" -maxdepth 1 -name '.work-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d "$BACKUP_ROOT/.work-$stamp-XXXX")

step="pausing application writes"
docker pause "$API_CONTAINER" >/dev/null
paused_containers+=("$API_CONTAINER")
docker pause "$WORKER_CONTAINER" >/dev/null
paused_containers+=("$WORKER_CONTAINER")

step="draining in-flight database writes"
active_clients=1
for _ in {1..30}; do
  active_clients=$(dbexec psql -h 127.0.0.1 -U "$DB_USER" -d postgres -At -c \
    "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle'")
  [[ "$active_clients" == 0 ]] && break
  sleep 1
done
[[ "$active_clients" == 0 ]] || {
  echo "Database clients did not become idle after application writers were paused." >&2
  exit 1
}

step="dumping the database"
echo "Dumping database"
dbexec pg_dumpall -h 127.0.0.1 -U "$DB_USER" --globals-only > "$work/globals.sql"
dbexec pg_dump -h 127.0.0.1 -U "$DB_USER" -d postgres -Fc > "$work/database.dump"
[[ -s "$work/database.dump" ]] || { echo "Empty database dump" >&2; exit 1; }
migrations=$(dbexec psql -h 127.0.0.1 -U "$DB_USER" -d postgres -At -c \
  "SELECT string_agg(version, ',' ORDER BY version) FROM app_migrations.schema_migrations" 2>/dev/null || echo "")

# Files after the database: every object the dump references already exists.
# API and worker writes remain paused, so any tar error (including a changed
# file) means the snapshot is not trustworthy and must fail closed.
step="archiving uploaded files"
echo "Archiving uploaded files"
tar -C "$STORAGE_DIR" -cf "$work/storage.tar" .
step="archiving configuration"
tar -C "$CONFIG_DIR" --exclude='./*.lock' -cf "$work/config.tar" .

step="resuming application writes"
resume_app_writes || {
  echo "Could not resume every application writer after the local snapshot." >&2
  exit 1
}

parts=(globals.sql database.dump storage.tar config.tar)
if [[ -z "$N8N_DB_CONTAINER" && -n "$N8N_COMPOSE_PROJECT" ]]; then
  mapfile -t n8n_db_matches < <(docker ps \
    --filter "label=com.docker.compose.project=$N8N_COMPOSE_PROJECT" \
    --filter 'label=com.docker.compose.service=n8n-db' \
    --format '{{.Names}}')
  (( ${#n8n_db_matches[@]} == 1 )) || {
    echo "Expected exactly one n8n database container for project $N8N_COMPOSE_PROJECT; found ${#n8n_db_matches[@]}." >&2
    exit 1
  }
  N8N_DB_CONTAINER=${n8n_db_matches[0]}
fi
if [[ -n "$N8N_DB_CONTAINER" ]]; then
  n8n_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$N8N_DB_CONTAINER" 2>/dev/null)
  n8n_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$N8N_DB_CONTAINER" 2>/dev/null)
  [[ "$(docker inspect -f '{{.State.Running}}' "$N8N_DB_CONTAINER" 2>/dev/null)" == true \
    && "$n8n_service" == n8n-db && -n "$n8n_project" \
    && ( -z "$N8N_COMPOSE_PROJECT" || "$n8n_project" == "$N8N_COMPOSE_PROJECT" ) ]] || {
    echo "$N8N_DB_CONTAINER is not the selected running n8n-db Compose service." >&2
    exit 1
  }
  step="dumping the n8n database"
  docker exec "$N8N_DB_CONTAINER" pg_dump -U n8n -d n8n -Fc > "$work/n8n.dump"
  parts+=(n8n.dump)
fi

step="writing the manifest"
{
  echo "created_utc=$stamp"
  echo "db_image=$db_image"
  echo "compose_project=$APP_COMPOSE_PROJECT"
  echo "migrations=$migrations"
  (cd "$work" && sha256sum "${parts[@]}")
} > "$work/MANIFEST"

step="encrypting"
archive="$BACKUP_ROOT/dromanian-space-$stamp.tar.age"
tar -C "$work" -cf - MANIFEST "${parts[@]}" | age -R "$AGE_RECIPIENTS_FILE" -o "$archive.partial"
mv "$archive.partial" "$archive"
archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
[[ "$archive_sha256" =~ ^[[:xdigit:]]{64}$ ]] \
  || { echo "Could not calculate the encrypted archive SHA-256." >&2; exit 1; }
echo "Wrote $archive ($(du -h "$archive" | cut -f1))"

step="applying retention"
find "$BACKUP_ROOT" -maxdepth 1 -name 'dromanian-space-*.tar.age' -mtime +"$RETENTION_DAYS" -print -delete

if [[ "$BACKUP_STORAGE_POLICY" == offsite ]]; then
  step="copying off-server"
  rclone copy "$archive" "$RCLONE_REMOTE"
  rclone check --one-way --include "$(basename "$archive")" "$BACKUP_ROOT" "$RCLONE_REMOTE"
  verified_archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
  [[ "$verified_archive_sha256" == "$archive_sha256" ]] || {
    echo "Encrypted archive changed while it was copied off-server; refusing recovery proof." >&2
    exit 1
  }
  remote_archive_sha256=$(rclone cat "${RCLONE_REMOTE%/}/$(basename "$archive")" | sha256sum | awk '{print $1}')
  [[ "$remote_archive_sha256" == "$archive_sha256" ]] || {
    echo "Off-server archive bytes do not match the local encrypted archive; refusing recovery proof." >&2
    exit 1
  }
  marker_tmp="$BACKUP_ROOT/.last-offsite-success.$$"
  printf '%s %s %s\n' "$stamp" "$(basename "$archive")" "$archive_sha256" > "$marker_tmp"
  mv -f -- "$marker_tmp" "$OFFSITE_SUCCESS_MARKER"
  echo "Copied and verified off-server at $RCLONE_REMOTE"
else
  step="verifying local encrypted archive"
  verified_archive_sha256=$(sha256sum "$archive" | awk '{print $1}')
  [[ "$verified_archive_sha256" == "$archive_sha256" ]] || {
    echo "Encrypted local archive changed before its recovery proof was recorded." >&2
    exit 1
  }
  echo "WARNING: Local encrypted archive verified, but no off-server copy exists under the selected policy." >&2
fi

success_marker_tmp="$BACKUP_ROOT/.last-success.$$"
printf '%s %s %s\n' "$stamp" "$(basename "$archive")" "$archive_sha256" > "$success_marker_tmp"
mv -f -- "$success_marker_tmp" "$BACKUP_ROOT/last-success"
rm -f "$BACKUP_ROOT/last-failure"
ping "$HEALTHCHECK_URL"
echo "Backup complete."

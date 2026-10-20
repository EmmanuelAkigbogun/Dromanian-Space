#!/usr/bin/env bash
# Read-only production checks. This script never starts, stops or mutates a
# service. Run before a migration or deployment.
set -uo pipefail

APP_DATA=${APP_DATA:-/srv/app-data}
CLOUD_DATA=${CLOUD_DATA:-/srv/cloud-data}
BACKUP_DIR=${BACKUP_DIR:-$APP_DATA/dromanian-space/backup-staging}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-26}
MIN_FREE_GB=${MIN_FREE_GB:-10}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
section() { printf '\n== %s ==\n' "$1"; }

section "Target"
host=$(hostname)
echo "Host: $host, $(uname -srm)"
if [[ -n "${EXPECT_HOST:-}" ]]; then
  [[ "$host" == "$EXPECT_HOST" ]] && pass "expected host" || fail "this is $host, expected $EXPECT_HOST"
else
  warn "EXPECT_HOST is not set; confirm this is the intended server"
fi

section "Docker"
docker info >/dev/null 2>&1 && pass "Docker reachable" || fail "Docker is not reachable"
compose=$(docker compose version --short 2>/dev/null | sed 's/^v//')
if [[ -n "$compose" ]] && printf '2.24.4\n%s\n' "$compose" | sort -V -C; then
  pass "Docker Compose $compose"
else
  fail "Docker Compose ${compose:-missing}; 2.24.4+ required"
fi

section "Persistent storage"
for base in "$APP_DATA" "$CLOUD_DATA"; do
  marker="$base/dromanian-space/.dromanian-space-mount"
  [[ -f "$marker" ]] && pass "mount marker $marker" || fail "missing mount marker $marker"
  if [[ -d "$base" ]]; then
    free_gb=$(df -BG --output=avail "$base" | tail -1 | tr -dc '0-9')
    (( free_gb >= MIN_FREE_GB )) && pass "$base has ${free_gb} GB free" || fail "$base has only ${free_gb:-0} GB free"
  fi
done
for directory in \
  "$APP_DATA/dromanian-space/postgres" \
  "$APP_DATA/dromanian-space/config" \
  "$APP_DATA/dromanian-space/coturn" \
  "$APP_DATA/dromanian-space/backup-staging" \
  "$CLOUD_DATA/dromanian-space/storage"; do
  [[ -d "$directory" ]] && pass "directory $directory" || fail "missing $directory"
done

section "Standalone services"
db_container=${DB_CONTAINER:-$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}} {{.Image}}' \
  | awk '$2 ~ /^(pgvector\/pgvector:|postgres:)/ {print $1; exit}')}
project=""
if [[ -n "$db_container" ]]; then
  project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$db_container" 2>/dev/null)
fi
for service in db rest api worker web coturn; do
  container=$(docker ps --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" --format '{{.Names}}' | head -1)
  if [[ -z "$project" || -z "$container" ]]; then fail "$service is not running"; continue; fi
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$container")
  [[ "$health" == healthy || "$health" == running ]] && pass "$service: $health" || fail "$service: $health"
done
for port in 5432 3000; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(0\\.0\\.0\\.0|\\[::\\]|\\*):$port$"; then
    fail "private service port $port is publicly bound"
  else
    pass "private service port $port is not publicly bound"
  fi
done

section "Database and migrations"
if [[ -n "$db_container" ]] && docker exec "$db_container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  pass "PostgreSQL ready"
  applied=$(docker exec "$db_container" psql -U postgres -d postgres -At -c \
    "SELECT coalesce(string_agg(version, ',' ORDER BY version), '') FROM app_migrations.schema_migrations" 2>/dev/null)
  missing=0
  for file in "$ROOT"/database/migrations/*.sql; do
    version=$(basename "$file"); version=${version%%_*}
    if [[ ",$applied," != *",$version,"* ]]; then echo "  pending: $(basename "$file")"; missing=$((missing + 1)); fi
  done
  (( missing == 0 )) && pass "all repository migrations applied" || warn "$missing migration(s) pending"
else
  fail "standalone PostgreSQL is not ready"
fi

section "Backups"
latest=$(ls -1t "$BACKUP_DIR"/dromanian-space-*.tar.age 2>/dev/null | head -1)
if [[ -n "$latest" ]]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$latest")) / 3600 ))
  (( age_h <= MAX_BACKUP_AGE_HOURS )) && pass "latest encrypted backup is ${age_h}h old" \
    || fail "latest encrypted backup is ${age_h}h old"
  [[ -f "$BACKUP_DIR/last-failure" ]] && fail "backup failure marker exists" || pass "no backup failure marker"
else
  fail "no encrypted backup found in $BACKUP_DIR"
fi

section "Public readiness"
if [[ -n "${APP_URL:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$APP_URL/api/ready")
  [[ "$code" == 200 ]] && pass "$APP_URL/api/ready" || fail "readiness returned ${code:-no response}"
else
  warn "APP_URL not set; public readiness was not checked"
fi
if [[ -n "${TURN_HOST:-}" ]]; then
  getent hosts "$TURN_HOST" >/dev/null 2>&1 && pass "$TURN_HOST resolves" || fail "$TURN_HOST does not resolve"
fi

printf '\n'
if (( fails > 0 )); then echo "Preflight FAILED ($fails problem(s)). Nothing was changed."; exit 1; fi
echo "Preflight passed."

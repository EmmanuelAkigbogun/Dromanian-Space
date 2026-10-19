#!/usr/bin/env bash
# Read-only checks before applying migrations or (re)deploying. Prints PASS,
# WARN and FAIL lines and exits non-zero when anything FAILs. Changes nothing.
#
#   deploy/preflight.sh                 all checks
#   EXPECT_HOST=<hostname> deploy/preflight.sh   also verify this is the intended server
#
# Environment: APP_DATA (/srv/app-data), CLOUD_DATA (/srv/cloud-data),
# SUPABASE_NETWORK (dromanian-supabase), BACKUP_DIR (APP_DATA/dromanian-space/
# backup-staging), MAX_BACKUP_AGE_HOURS (26), MIN_FREE_GB (10), DB_CONTAINER,
# PGPASSWORD_FILE, APP_URL / SUPABASE_PUBLIC_URL (optional public checks).
set -uo pipefail

APP_DATA=${APP_DATA:-/srv/app-data}
CLOUD_DATA=${CLOUD_DATA:-/srv/cloud-data}
NETWORK=${SUPABASE_NETWORK:-dromanian-supabase}
BACKUP_DIR=${BACKUP_DIR:-$APP_DATA/dromanian-space/backup-staging}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-26}
MIN_FREE_GB=${MIN_FREE_GB:-10}
HERE=$(cd "$(dirname "$0")" && pwd)

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
section() { printf '\n== %s ==\n' "$1"; }

section "Target"
host=$(hostname)
echo "Host: $host, $(uname -srm)"
if [[ -n "${EXPECT_HOST:-}" ]]; then
  [[ "$host" == "$EXPECT_HOST" ]] && pass "running on the expected host ($EXPECT_HOST)" || fail "this is $host, not $EXPECT_HOST"
else
  warn "EXPECT_HOST not set; confirm this is the intended server"
fi

section "Docker"
if docker info >/dev/null 2>&1; then
  pass "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
else
  fail "Docker is not reachable by this user"
fi
compose=$(docker compose version --short 2>/dev/null | sed 's/^v//')
if [[ -n "$compose" ]] && printf '2.24.4\n%s\n' "$compose" | sort -V -C; then
  pass "Docker Compose $compose (2.24.4+ required)"
else
  fail "Docker Compose ${compose:-missing}; 2.24.4 or newer is required"
fi

section "Data mounts"
for base in "$APP_DATA" "$CLOUD_DATA"; do
  if ! findmnt -T "$base" >/dev/null 2>&1; then fail "$base does not exist"; continue; fi
  target=$(findmnt -n -o TARGET -T "$base")
  source=$(findmnt -n -o SOURCE -T "$base")
  marker="$base/dromanian-space/.dromanian-space-mount"
  if [[ "$target" != "/" ]]; then pass "$base mounted at $target from $source"
  elif grep -qs system-disk-acknowledged "$marker"; then warn "$base is on the system disk (acknowledged with --allow-system-disk); rely on off-server backups"
  else fail "$base is on the root filesystem, not its own disk"; fi
  [[ -f "$marker" ]] && pass "marker present: $marker" || fail "marker missing: $marker (run deploy/prepare-host.sh --apply once the disk is mounted)"
  free_gb=$(df -BG --output=avail "$base" | tail -1 | tr -dc '0-9')
  used_pct=$(df --output=pcent "$base" | tail -1 | tr -dc '0-9')
  if (( free_gb < MIN_FREE_GB )); then fail "$base has ${free_gb} GB free (minimum ${MIN_FREE_GB} GB)"
  elif (( used_pct >= 85 )); then warn "$base is ${used_pct}% full (${free_gb} GB free)"
  else pass "$base: ${free_gb} GB free (${used_pct}% used)"; fi
done
for d in "$APP_DATA/dromanian-space/supabase/db/data" "$APP_DATA/dromanian-space/supabase/db/config" \
         "$APP_DATA/dromanian-space/config" "$APP_DATA/dromanian-space/backup-staging" "$CLOUD_DATA/dromanian-space/storage"; do
  [[ -d "$d" ]] && pass "directory exists: $d" || fail "directory missing: $d"
done
cfg="$APP_DATA/dromanian-space/config"
if [[ -d "$cfg" ]]; then
  mode=$(stat -c '%a' "$cfg")
  [[ "$mode" == "700" ]] && pass "config directory is private (700)" || warn "config directory mode is $mode; expected 700"
fi

section "Network"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  pass "network $NETWORK exists"
  members=$(docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}')
  echo "  attached: ${members:-none}"
  if docker run --rm --network "$NETWORK" busybox:1.37.0 nc -z -w 3 supabase-gateway 8000 >/dev/null 2>&1; then
    pass "supabase-gateway:8000 reachable on $NETWORK"
  else
    fail "supabase-gateway:8000 not reachable on $NETWORK (is the Supabase stack running and attached?)"
  fi
else
  fail "network $NETWORK is missing (deploy/prepare-host.sh --apply creates it)"
fi
docker network inspect coolify >/dev/null 2>&1 && pass "coolify proxy network exists" || warn "coolify network not found (needed for the Supabase public route)"

section "Supabase services"
for svc in db auth rest realtime storage api-gw; do
  name=$(docker ps --filter "label=com.docker.compose.service=$svc" --format '{{.Names}}' | grep -E 'supabase|realtime|envoy|db' | head -1)
  if [[ -z "$name" ]]; then fail "$svc: no running container"; continue; fi
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$name")
  [[ "$health" == "healthy" || "$health" == "running" ]] && pass "$svc ($name): $health" || fail "$svc ($name): $health"
done
for port in 5432 6543; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|[^0-9])(0\.0\.0\.0|\[::\]|\*):$port$"; then
    fail "port $port is published on all interfaces; PostgreSQL must stay private"
  else
    pass "port $port is not published publicly"
  fi
done

section "Database"
if "$HERE/migrate.sh" status >/tmp/dromanian-migrate-status.$$ 2>&1; then
  head -1 /tmp/dromanian-migrate-status.$$
  pending=$(grep -c '^PENDING' /tmp/dromanian-migrate-status.$$ || true)
  pass "database reachable; $pending pending migration(s)"
  tables=$(head -1 /tmp/dromanian-migrate-status.$$ | sed -n 's/.*public tables: \([0-9]*\).*/\1/p')
else
  cat /tmp/dromanian-migrate-status.$$
  fail "cannot query the database"
  tables=""
fi
rm -f /tmp/dromanian-migrate-status.$$
if "$HERE/migrate.sh" check >/dev/null 2>/tmp/dromanian-migrate-check.$$; then
  pass "migration history consistent (no drift, unknown or out-of-order versions)"
else
  sed 's/^/  /' /tmp/dromanian-migrate-check.$$
  fail "migration history needs attention before apply"
fi
rm -f /tmp/dromanian-migrate-check.$$
db=$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^supabase\/postgres:/ {print $1; exit}')
if [[ -n "$db" ]]; then
  ext=$(docker exec "$db" psql -h 127.0.0.1 -U postgres -At -c \
    "SELECT string_agg(name, ',') FROM pg_available_extensions WHERE name IN ('vector','pg_cron','pgcrypto','pg_trgm','uuid-ossp')" 2>/dev/null)
  for e in vector pg_cron pgcrypto pg_trgm uuid-ossp; do
    [[ ",$ext," == *",$e,"* ]] && pass "extension available: $e" || fail "extension not available: $e"
  done
fi

section "Backups"
latest=$(ls -1t "$BACKUP_DIR"/dromanian-space-*.tar.age 2>/dev/null | head -1)
if [[ -n "$latest" ]]; then
  age_h=$(( ($(date +%s) - $(stat -c %Y "$latest")) / 3600 ))
  if (( age_h <= MAX_BACKUP_AGE_HOURS )); then pass "latest backup $(basename "$latest") is ${age_h}h old"
  else fail "latest backup is ${age_h}h old (max ${MAX_BACKUP_AGE_HOURS}h): run deploy/backup/backup.sh first"; fi
  [[ -f "$BACKUP_DIR/last-success" ]] && echo "  last success marker: $(cat "$BACKUP_DIR/last-success")"
elif [[ "${tables:-1}" == "0" ]]; then
  pass "no backup yet, and the database has no application tables (fresh install)"
else
  fail "no backup found in $BACKUP_DIR: back up before migrating an existing database"
fi

section "Public endpoints (optional)"
if [[ -n "${SUPABASE_PUBLIC_URL:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SUPABASE_PUBLIC_URL/auth/v1/health")
  [[ "$code" =~ ^(200|401)$ ]] && pass "Supabase public URL answers ($code)" || warn "Supabase public URL returned ${code:-no answer}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SUPABASE_PUBLIC_URL/")
  [[ "$code" == "404" ]] && pass "Studio is not routed publicly (/ returns 404)" || warn "public / returned $code; Studio must not be public"
fi
if [[ -n "${APP_URL:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$APP_URL/api/ready")
  [[ "$code" == "200" ]] && pass "app ready ($APP_URL/api/ready)" || warn "app /api/ready returned ${code:-no answer}"
fi

printf '\n'
if (( fails > 0 )); then echo "Preflight FAILED ($fails problem(s)). Nothing was changed."; exit 1; fi
echo "Preflight passed."

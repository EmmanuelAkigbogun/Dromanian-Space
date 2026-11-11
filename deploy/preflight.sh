#!/usr/bin/env bash
# Read-only production checks. This script never starts, stops or mutates a
# service. Run before a migration or deployment.
set -uo pipefail

APP_DATA=${APP_DATA:-/srv/app-data}
CLOUD_DATA=${CLOUD_DATA:-/srv/cloud-data}
BACKUP_DIR=${BACKUP_DIR:-$APP_DATA/dromanian-space/backup-staging}
CONFIG_DIR=${CONFIG_DIR:-$APP_DATA/dromanian-space/config}
DB_DATA_DIR=${DB_DATA_DIR:-$APP_DATA/dromanian-space/postgres}
APP_COMPOSE_PROJECT=${APP_COMPOSE_PROJECT:-}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-$CONFIG_DIR/backup.env}
OFFSITE_SUCCESS_MARKER=${OFFSITE_SUCCESS_MARKER:-$BACKUP_DIR/last-offsite-success}
RESTORE_DRILL_MARKER=${RESTORE_DRILL_MARKER:-$BACKUP_DIR/last-restore-drill}
PRIVATE_AGE_IDENTITY_PATH=${PRIVATE_AGE_IDENTITY_PATH:-$CONFIG_DIR/backup-age-identity.txt}
OFFLINE_AGE_IDENTITY_PATH=${OFFLINE_AGE_IDENTITY_PATH:-/secure/offline.key}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-26}
MIN_FREE_GB=${MIN_FREE_GB:-10}
PREFLIGHT_PHASE=${PREFLIGHT_PHASE:-predeploy}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }
section() { printf '\n== %s ==\n' "$1"; }
container_networks() {
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$1" 2>/dev/null
}
container_ips() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$1" 2>/dev/null \
    | awk 'NF'
}
shared_networks() {
  local left right network
  left=$(container_networks "$1")
  right=$(container_networks "$2")
  while IFS= read -r network; do
    [[ -n "$network" ]] && grep -Fqx -- "$network" <<< "$right" && printf '%s\n' "$network"
  done <<< "$left"
}
network_count() {
  container_networks "$1" | awk 'NF { count += 1 } END { print count + 0 }'
}
container_port_bindings() {
  docker inspect -f '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' "$1" 2>/dev/null \
    | awk 'NF' | sort
}
container_env_value() {
  local container=$1 name=$2
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | sed -n "s/^${name}=//p" \
    | tail -1
}
check_private_port_bindings() {
  local service=$1 container=$2 binding container_port host_ip host_port found=false
  while IFS= read -r binding; do
    [[ -n "$binding" ]] || continue
    found=true
    IFS='|' read -r container_port host_ip host_port <<< "$binding"
    case "$host_ip" in
      127.*|::1|'[::1]') pass "$service host mapping $host_ip:$host_port -> $container_port is loopback-only" ;;
      *) fail "$service has non-loopback host mapping ${host_ip:-0.0.0.0}:$host_port -> $container_port" ;;
    esac
  done < <(container_port_bindings "$container")
  $found || pass "$service has no host port mappings"
}

case "$PREFLIGHT_PHASE" in
  predeploy|postdeploy) ;;
  *) echo "PREFLIGHT_PHASE must be predeploy or postdeploy" >&2; exit 2 ;;
esac

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
command -v realpath >/dev/null 2>&1 && pass "realpath available" || fail "realpath is required"
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
db_container=${DB_CONTAINER:-}
project=$APP_COMPOSE_PROJECT
db_target_valid=true
if [[ -z "$db_container" ]]; then
  if [[ -z "$project" ]]; then
    fail "set APP_COMPOSE_PROJECT to the exact app Compose project or set DB_CONTAINER explicitly"
    db_target_valid=false
  else
    mapfile -t db_matches < <(docker ps \
      --filter "label=com.docker.compose.project=$project" \
      --filter 'label=com.docker.compose.service=db' \
      --format '{{.Names}}')
    if (( ${#db_matches[@]} == 1 )); then
      db_container=${db_matches[0]}
    else
      fail "expected exactly one running db container in Compose project $project; found ${#db_matches[@]}"
      db_target_valid=false
    fi
  fi
fi
if $db_target_valid; then
  if ! docker inspect "$db_container" >/dev/null 2>&1; then
    fail "database container does not exist: $db_container"
    db_target_valid=false
  elif [[ "$(docker inspect -f '{{.State.Running}}' "$db_container" 2>/dev/null)" != true ]]; then
    fail "database container is not running: $db_container"
    db_target_valid=false
  fi
fi
if $db_target_valid; then
  db_service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$db_container" 2>/dev/null)
  db_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db_container" 2>/dev/null)
  if [[ "$db_service" != db || -z "$db_project" || "$db_project" == '<no value>' ]]; then
    fail "$db_container is not a Compose db service"
    db_target_valid=false
  elif [[ -n "$project" && "$db_project" != "$project" ]]; then
    fail "$db_container belongs to Compose project $db_project, not $project"
    db_target_valid=false
  else
    project=$db_project
  fi
fi
if $db_target_valid; then
  db_image=$(docker inspect -f '{{.Config.Image}}' "$db_container" 2>/dev/null)
  [[ "$db_image" == pgvector/pgvector:* || "$db_image" == postgres:* ]] \
    || { fail "$db_container uses unexpected database image $db_image"; db_target_valid=false; }
fi
if $db_target_valid; then
  db_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Source}}|{{.RW}}{{end}}{{end}}' "$db_container" 2>/dev/null)
  IFS='|' read -r db_mount_type db_mount_source db_mount_rw <<< "$db_mount"
  expected_db_data=$(realpath -e -- "$DB_DATA_DIR" 2>/dev/null)
  actual_db_data=$(realpath -e -- "$db_mount_source" 2>/dev/null)
  if [[ -z "$expected_db_data" || "$db_mount_type" != bind || "$db_mount_rw" != true || "$actual_db_data" != "$expected_db_data" ]]; then
    fail "$db_container does not use the expected writable database bind ${expected_db_data:-$DB_DATA_DIR}"
    db_target_valid=false
  else
    pass "database target verified: Compose project $project, bind $expected_db_data"
  fi
fi
if ! $db_target_valid; then
  db_container=""
  project=""
fi

declare -A app_containers=()
for service in db rest api worker agno onlyoffice web livekit coturn; do
  service_matches=()
  if [[ -n "$project" ]]; then
    mapfile -t service_matches < <(docker ps --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service" --format '{{.Names}}')
  fi
  if (( ${#service_matches[@]} != 1 )); then
    fail "$service must have exactly one running container in the selected project (found ${#service_matches[@]})"
    continue
  fi
  container=${service_matches[0]}
  app_containers[$service]=$container
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$container")
  [[ "$health" == healthy || "$health" == running ]] && pass "$service: $health" || fail "$service: $health"
done
crawl4ai_matches=()
if [[ -n "$project" ]]; then
  mapfile -t crawl4ai_matches < <(docker ps --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=crawl4ai" --format '{{.Names}}')
fi
crawl4ai_container=""
if (( ${#crawl4ai_matches[@]} == 1 )); then
  crawl4ai_container=${crawl4ai_matches[0]}
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$crawl4ai_container")
  [[ "$health" == healthy || "$health" == running ]] && pass "crawl4ai: $health" || fail "crawl4ai: $health"
elif (( ${#crawl4ai_matches[@]} > 1 )); then
  fail "crawl4ai must have exactly one running container in the selected project (found ${#crawl4ai_matches[@]})"
elif [[ "$PREFLIGHT_PHASE" == postdeploy ]]; then
  fail "crawl4ai is not running"
else
  warn "crawl4ai is not in the current release; the post-deploy gate will require it"
fi
gateway_matches=()
if [[ -n "$project" ]]; then
  mapfile -t gateway_matches < <(docker ps --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=crawl4ai-gateway" --format '{{.Names}}')
fi
crawl4ai_gateway_container=""
if (( ${#gateway_matches[@]} == 1 )); then
  crawl4ai_gateway_container=${gateway_matches[0]}
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$crawl4ai_gateway_container")
  [[ "$health" == healthy ]] && pass "crawl4ai-gateway: $health" || fail "crawl4ai-gateway: $health"
elif (( ${#gateway_matches[@]} > 1 )); then
  fail "crawl4ai-gateway must have exactly one running container in the selected project (found ${#gateway_matches[@]})"
elif [[ "$PREFLIGHT_PHASE" == postdeploy ]]; then
  fail "crawl4ai-gateway is not running"
else
  warn "crawl4ai-gateway is not in the current release; the post-deploy gate will require it"
fi

declare -A private_containers=()
for service in db rest api worker agno onlyoffice web; do
  [[ -n "${app_containers[$service]:-}" ]] && private_containers[$service]=${app_containers[$service]}
done
[[ -n "$crawl4ai_gateway_container" ]] && private_containers[crawl4ai-gateway]=$crawl4ai_gateway_container
for service in "${!private_containers[@]}"; do
  check_private_port_bindings "$service" "${private_containers[$service]}"
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
backup_storage_policy=offsite
if [[ -r "$BACKUP_ENV_FILE" ]]; then
  configured_backup_storage_policy=$(sed -n 's/^[[:space:]]*BACKUP_STORAGE_POLICY[[:space:]]*=[[:space:]]*//p' "$BACKUP_ENV_FILE" | tail -1)
  configured_backup_storage_policy=${configured_backup_storage_policy%%#*}
  configured_backup_storage_policy=$(printf '%s' "$configured_backup_storage_policy" | tr -d '[:space:]')
  configured_backup_storage_policy=${configured_backup_storage_policy#\"}; configured_backup_storage_policy=${configured_backup_storage_policy%\"}
  configured_backup_storage_policy=${configured_backup_storage_policy#\'}; configured_backup_storage_policy=${configured_backup_storage_policy%\'}
  [[ -n "$configured_backup_storage_policy" ]] && backup_storage_policy=$configured_backup_storage_policy
else
  fail "protected backup environment is missing or unreadable"
fi
case "$backup_storage_policy" in
  offsite) pass "backup storage policy is offsite" ;;
  local)
    warn "backup storage policy is local-only; host or disk loss can destroy both production data and its backup"
    ;;
  *)
    fail "BACKUP_STORAGE_POLICY must be exactly offsite or local"
    # Preserve the default fail-closed recovery requirements after invalid input.
    backup_storage_policy=offsite
    ;;
esac

latest=$(ls -1t "$BACKUP_DIR"/dromanian-space-*.tar.age 2>/dev/null | head -1)
if [[ -n "$latest" ]]; then
  latest_name=$(basename "$latest")
  latest_sha256=$(sha256sum "$latest" 2>/dev/null | awk '{print $1}')
  if [[ ! "$latest_sha256" =~ ^[[:xdigit:]]{64}$ ]]; then
    fail "latest encrypted backup SHA-256 could not be calculated"
    latest_sha256=""
  fi
  age_h=$(( ($(date +%s) - $(stat -c %Y "$latest")) / 3600 ))
  (( age_h <= MAX_BACKUP_AGE_HOURS )) && pass "latest encrypted backup is ${age_h}h old" \
    || fail "latest encrypted backup is ${age_h}h old"
  [[ -f "$BACKUP_DIR/last-failure" ]] && fail "backup failure marker exists" || pass "no backup failure marker"

  success_archive=""; success_sha256=""
  [[ -r "$BACKUP_DIR/last-success" ]] \
    && read -r _ success_archive success_sha256 _ < "$BACKUP_DIR/last-success"
  [[ -n "$latest_sha256" && "$success_archive" == "$latest_name" && "$success_sha256" == "$latest_sha256" ]] \
    && pass "latest encrypted backup completed successfully" \
    || fail "latest encrypted backup is not the recorded successful backup"

  if [[ "$backup_storage_policy" == offsite ]]; then
    offsite_archive=""; offsite_sha256=""
    [[ -r "$OFFSITE_SUCCESS_MARKER" ]] \
      && read -r _ offsite_archive offsite_sha256 _ < "$OFFSITE_SUCCESS_MARKER"
    [[ -n "$latest_sha256" && "$offsite_archive" == "$latest_name" && "$offsite_sha256" == "$latest_sha256" ]] \
      && pass "latest encrypted backup was verified off-server" \
      || fail "latest encrypted backup has no matching off-server verification"
  else
    warn "off-server proof is not required by the explicit local-only policy; any stale offsite marker is ignored"
  fi

  drill_archive=""; drill_sha256=""
  [[ -r "$RESTORE_DRILL_MARKER" ]] \
    && read -r _ drill_archive drill_sha256 _ < "$RESTORE_DRILL_MARKER"
  [[ -n "$latest_sha256" && "$drill_archive" == "$latest_name" && "$drill_sha256" == "$latest_sha256" ]] \
    && pass "latest encrypted backup passed an isolated restore drill" \
    || fail "latest encrypted backup has no matching isolated restore drill"
else
  fail "no encrypted backup found in $BACKUP_DIR"
fi

if [[ "$backup_storage_policy" == offsite && -r "$BACKUP_ENV_FILE" ]]; then
  rclone_remote=$(sed -n 's/^[[:space:]]*RCLONE_REMOTE[[:space:]]*=[[:space:]]*//p' "$BACKUP_ENV_FILE" | tail -1)
  rclone_remote=${rclone_remote%%#*}
  rclone_remote=$(printf '%s' "$rclone_remote" | tr -d '[:space:]')
  rclone_remote=${rclone_remote#\"}; rclone_remote=${rclone_remote%\"}
  rclone_remote=${rclone_remote#\'}; rclone_remote=${rclone_remote%\'}
  [[ -n "$rclone_remote" ]] && pass "off-server backup destination is configured" \
    || fail "RCLONE_REMOTE is empty in the protected backup environment"
fi

identity_found=false
for identity_path in "$PRIVATE_AGE_IDENTITY_PATH" "$OFFLINE_AGE_IDENTITY_PATH" "${AGE_IDENTITY_FILE:-}"; do
  [[ -n "$identity_path" && -e "$identity_path" ]] && identity_found=true
done
if [[ -d "$CONFIG_DIR" ]]; then
  while IFS= read -r -d '' candidate; do
    if grep -q 'AGE-SECRET-KEY-' "$candidate" 2>/dev/null; then
      identity_found=true
      break
    fi
  done < <(find "$CONFIG_DIR" -maxdepth 2 -type f -print0 2>/dev/null)
fi
if $identity_found; then
  fail "an age private identity is stored on the production server; remove it after the drill"
else
  pass "no age private identity was detected in production configuration"
fi

section "Private browser scraper"
api_container=${app_containers[api]:-}
worker_container=${app_containers[worker]:-}
if [[ "$PREFLIGHT_PHASE" == predeploy ]]; then
  predeploy_bridge_container_ids=()
  if predeploy_bridge_inventory=$(docker network inspect bridge \
    --format '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' 2>/dev/null); then
    mapfile -t predeploy_bridge_container_ids < <(printf '%s\n' "$predeploy_bridge_inventory" \
      | awk 'NF' | sort)
    if (( ${#predeploy_bridge_container_ids[@]} == 0 )); then
      pass "stock bridge is empty for the isolated scraper rollout"
    elif (( ${#predeploy_bridge_container_ids[@]} == 1 )) \
      && [[ -n "$crawl4ai_container" && -n "$crawl4ai_gateway_container" ]]; then
      existing_crawler_id=$(docker inspect -f '{{.Id}}' "$crawl4ai_container" 2>/dev/null)
      existing_crawler_network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$crawl4ai_container" 2>/dev/null)
      existing_gateway_network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$crawl4ai_gateway_container" 2>/dev/null)
      existing_crawler_network_count=$(network_count "$crawl4ai_container")
      existing_gateway_network_count=$(network_count "$crawl4ai_gateway_container")
      existing_crawler_endpoint=$(docker inspect \
        -f '{{with index .NetworkSettings.Networks "bridge"}}{{.EndpointID}}{{end}}' \
        "$crawl4ai_container" 2>/dev/null)
      existing_bridge_crawler_endpoint=$(docker network inspect bridge \
        --format "{{with index .Containers \"$existing_crawler_id\"}}{{.EndpointID}}{{end}}" 2>/dev/null)
      existing_bridge_gateway=$(docker network inspect bridge \
        --format '{{range .IPAM.Config}}{{if .Gateway}}{{println .Gateway}}{{end}}{{end}}' 2>/dev/null \
        | awk 'NF { print; exit }')
      existing_crawler_bindings=$(container_port_bindings "$crawl4ai_container")
      expected_existing_crawler_binding="8080/tcp|$existing_bridge_gateway|11235"

      if [[ -n "$existing_crawler_id" \
        && "${predeploy_bridge_container_ids[0]}" == "$existing_crawler_id" \
        && "$existing_crawler_network_mode" == bridge \
        && "$existing_crawler_network_count" == 1 \
        && "$existing_gateway_network_mode" == "container:$existing_crawler_id" \
        && "$existing_gateway_network_count" == 0 \
        && -n "$existing_crawler_endpoint" \
        && "$existing_bridge_crawler_endpoint" == "$existing_crawler_endpoint" \
        && -n "$existing_bridge_gateway" \
        && "$existing_crawler_bindings" == "$expected_existing_crawler_binding" ]]; then
        pass "stock bridge contains only the selected project's isolated Crawl4AI namespace"
      else
        fail "stock bridge does not match the selected project's isolated Crawl4AI and gateway topology"
      fi
    else
      fail "stock bridge contains unrelated or ambiguous endpoints; only the selected project's isolated Crawl4AI endpoint is allowed"
    fi
  else
    fail "stock bridge membership could not be inspected"
  fi
  warn "candidate scraper topology and authenticated runtime checks are deferred to PREFLIGHT_PHASE=postdeploy"
elif [[ -n "$crawl4ai_container" && -n "$crawl4ai_gateway_container" \
  && -n "$api_container" && -n "$worker_container" ]]; then
  scraper_peers=(db rest api worker agno onlyoffice web)
  topology_isolated=true
  for peer_name in "${scraper_peers[@]}"; do
    peer_container=${app_containers[$peer_name]:-}
    if [[ -z "$peer_container" || -n "$(shared_networks "$peer_container" "$crawl4ai_container")" ]]; then
      topology_isolated=false
    fi
  done
  crawler_id=$(docker inspect -f '{{.Id}}' "$crawl4ai_container" 2>/dev/null)
  crawler_network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$crawl4ai_container" 2>/dev/null)
  gateway_network_mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$crawl4ai_gateway_container" 2>/dev/null)
  crawler_network_count=$(network_count "$crawl4ai_container")
  gateway_network_count=$(network_count "$crawl4ai_gateway_container")
  crawler_endpoint=$(docker inspect -f '{{with index .NetworkSettings.Networks "bridge"}}{{.EndpointID}}{{end}}' "$crawl4ai_container" 2>/dev/null)
  bridge_crawler_endpoint=$(docker network inspect bridge \
    --format "{{with index .Containers \"$crawler_id\"}}{{.EndpointID}}{{end}}" 2>/dev/null)
  bridge_container_ids=()
  mapfile -t bridge_container_ids < <(docker network inspect bridge \
    --format '{{range $id, $_ := .Containers}}{{println $id}}{{end}}' 2>/dev/null \
    | awk 'NF' | sort)
  if [[ "$crawler_network_mode" == bridge && "$crawler_network_count" == 1 \
    && "$gateway_network_mode" == "container:$crawler_id" \
    && "$gateway_network_count" == 0 && "$topology_isolated" == true \
    && -n "$crawler_endpoint" && "$bridge_crawler_endpoint" == "$crawler_endpoint" \
    && ${#bridge_container_ids[@]} == 1 && "${bridge_container_ids[0]:-}" == "$crawler_id" ]]; then
    pass "Crawl4AI is the stock bridge's sole endpoint; its gateway shares that isolated namespace"
  else
    fail "Crawl4AI network topology permits lateral access or bypasses the gateway"
  fi

  bridge_gateway=$(docker network inspect bridge \
    --format '{{range .IPAM.Config}}{{if .Gateway}}{{println .Gateway}}{{end}}{{end}}' 2>/dev/null \
    | awk 'NF { print; exit }')
  crawler_bindings=$(container_port_bindings "$crawl4ai_container")
  expected_crawler_binding="8080/tcp|$bridge_gateway|11235"
  if [[ -n "$bridge_gateway" && "$crawler_bindings" == "$expected_crawler_binding" ]]; then
    pass "only the authenticated gateway is published on $bridge_gateway:11235"
  else
    fail "Crawl4AI must publish exactly $expected_crawler_binding (found ${crawler_bindings:-none})"
  fi

  for caller_name in api worker; do
    caller_container=${app_containers[$caller_name]}
    caller_url=$(container_env_value "$caller_container" CRAWL4AI_URL)
    [[ "$caller_url" == http://host.docker.internal:11235 ]] \
      && pass "$caller_name uses the authenticated host-gateway scraper URL" \
      || fail "$caller_name has unexpected CRAWL4AI_URL: ${caller_url:-missing}"
    if docker exec -e EXPECTED_HOST_GATEWAY="$bridge_gateway" "$caller_container" node -e '
const dns = require("node:dns");
dns.lookup("host.docker.internal", (error, address) => {
  process.exit(!error && address === process.env.EXPECTED_HOST_GATEWAY ? 0 : 1);
});
'; then
      pass "$caller_name resolves host.docker.internal only to the Docker bridge gateway"
    else
      fail "$caller_name does not resolve host.docker.internal to the Docker bridge gateway"
    fi
  done

  declare -A scraper_peer_ports=(
    [db]=5432 [rest]=3000 [api]=3000 [worker]=3001 [agno]=8000 [onlyoffice]=80 [web]=8080
  )
  scraper_target_specs=()
  for peer_name in "${scraper_peers[@]}"; do
    while IFS= read -r peer_ip; do
      [[ -n "$peer_ip" ]] && scraper_target_specs+=("$peer_ip:${scraper_peer_ports[$peer_name]}")
    done < <(container_ips "${app_containers[$peer_name]}")
  done
  scraper_peer_names=$(IFS=,; echo "${scraper_peers[*]}")
  scraper_targets=$(IFS=,; echo "${scraper_target_specs[*]}")
  if [[ -n "$scraper_targets" ]] \
    && docker exec -e PRIVATE_NAMES="$scraper_peer_names" -e PRIVATE_TARGETS="$scraper_targets" \
      "$crawl4ai_container" python -c '
import os, socket, sys
bad = []
for name in filter(None, os.environ["PRIVATE_NAMES"].split(",")):
    try:
        socket.getaddrinfo(name, None)
        bad.append("resolved:" + name)
    except socket.gaierror:
        pass
for target in filter(None, os.environ["PRIVATE_TARGETS"].split(",")):
    host, port = target.rsplit(":", 1)
    try:
        with socket.create_connection((host, int(port)), timeout=1):
            bad.append("reached:" + target)
    except OSError:
        pass
sys.exit(1 if bad else 0)
'; then
    pass "Crawl4AI cannot resolve or directly reach private application services"
  else
    fail "Crawl4AI can resolve or directly reach a private application service"
  fi

  crawler_ip=$(docker inspect -f '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}' "$crawl4ai_container" 2>/dev/null)
  for caller_name in api worker; do
    caller_container=${app_containers[$caller_name]}
    if [[ -n "$crawler_ip" ]] && docker exec -e CRAWLER_IP="$crawler_ip" "$caller_container" node -e '
const dns = require("node:dns");
const net = require("node:net");
let finished = false;
const done = (code) => {
  if (finished) return;
  finished = true;
  process.exit(code);
};
dns.lookup("crawl4ai", (error) => {
  if (!error) return done(1);
  const socket = net.createConnection({ host: process.env.CRAWLER_IP, port: 11235 });
  socket.once("connect", () => done(1));
  socket.once("error", () => done(0));
  socket.setTimeout(1500, () => done(0));
});
'; then
      pass "$caller_name cannot resolve or directly reach the raw Crawl4AI backend"
    else
      fail "$caller_name can resolve or directly reach the raw Crawl4AI backend"
    fi
  done

  if docker exec "$worker_container" node -e '
fetch(`${process.env.CRAWL4AI_URL}/health`)
  .then((response) => process.exit(response.status === 404 ? 0 : 1))
  .catch(() => process.exit(1));
'; then
    pass "the published scraper endpoint exposes the fixed-route gateway, not raw Crawl4AI"
  else
    fail "the published scraper endpoint can bypass the fixed-route gateway"
  fi

  if docker exec "$worker_container" node -e '
const fs = require("node:fs");
const token = fs.readFileSync(process.env.CRAWL4AI_API_TOKEN_FILE, "utf8").trim();
fetch(`${process.env.CRAWL4AI_URL}/schema`, { headers: { authorization: `Bearer ${token}` } })
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
'; then
    pass "worker reaches authenticated Crawl4AI schema through the gateway"
  else
    fail "worker cannot reach authenticated Crawl4AI schema through the gateway"
  fi

  if docker exec "$api_container" node tools/browser-scraper-smoke.mjs; then
    pass "api reaches authenticated Crawl4AI browser scrape through the gateway"
  else
    fail "api cannot complete authenticated Crawl4AI browser scrape through the gateway"
  fi
else
  fail "isolated authenticated Crawl4AI checks could not run"
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

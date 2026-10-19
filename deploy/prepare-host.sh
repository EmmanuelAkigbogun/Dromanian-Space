#!/usr/bin/env bash
# Inventory and (with --apply) prepare the server for Dromanian Space.
# Read-only by default. Never formats disks, changes ownership recursively,
# prints secrets, or removes volumes. Run as a user allowed to use Docker.
set -euo pipefail

APP_DATA=${APP_DATA:-/srv/app-data}
CLOUD_DATA=${CLOUD_DATA:-/srv/cloud-data}
NETWORK=${APP_NETWORK:-dromanian-space}
APPLY=false
WITH_N8N=false
# Servers without separate data disks: an explicit, recorded decision to keep
# the data directories on the system disk (the mount guard then protects
# against a wrong or missing directory, not against losing the disk).
ALLOW_SYSTEM_DISK=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    --with-n8n) WITH_N8N=true ;;
    --allow-system-disk) ALLOW_SYSTEM_DISK=true ;;
    *) echo "Usage: $0 [--apply] [--with-n8n] [--allow-system-disk]" >&2; exit 1 ;;
  esac
done

section() { printf '\n== %s ==\n' "$1"; }

section "System"
uname -m
cores=$(nproc 2>/dev/null || echo 0)
mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
echo "CPU cores: $cores, memory: ${mem_gb} GB"
free -h 2>/dev/null || true
(( cores >= 4 )) || echo "  WARNING: fewer than 4 CPU cores; lower WORKER_CONCURRENCY and expect slower agents."
(( mem_gb >= 4 )) || echo "  WARNING: less than 4 GB RAM; reduce database and worker limits."

section "Docker"
docker version --format 'Docker {{.Server.Version}}' 2>/dev/null || echo "Docker is not reachable"
docker compose version 2>/dev/null || echo "Docker Compose plugin not found (2.24.4+ required)"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true

section "Listening ports"
(ss -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || true) | head -40

section "Data mounts"
for base in "$APP_DATA" "$CLOUD_DATA"; do
  if findmnt -T "$base" >/dev/null 2>&1; then
    target=$(findmnt -n -o TARGET -T "$base")
    source=$(findmnt -n -o SOURCE -T "$base")
    printf '%s -> mounted at %s from %s\n' "$base" "$target" "$source"
    if [[ "$target" == "/" ]]; then
      echo "  WARNING: $base is on the root filesystem, not a dedicated mount."
    fi
    df -h "$base" | tail -1
  else
    echo "$base does not exist"
  fi
done

section "Docker network"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "$NETWORK exists"
else
  echo "$NETWORK does not exist"
fi

if ! $APPLY; then
  printf '\nNothing changed. Review the output, then run with --apply to create directories, mount markers and the network.\n'
  exit 0
fi

section "Applying"
for base in "$APP_DATA" "$CLOUD_DATA"; do
  target=$(findmnt -n -o TARGET -T "$base" 2>/dev/null || echo "/")
  if [[ "$target" == "/" ]]; then
    if $ALLOW_SYSTEM_DISK; then
      echo "NOTE: $base is on the system disk (--allow-system-disk). Back up off-server; disk loss loses local data."
    else
      echo "Refusing: $base is not a dedicated mount. Mount it first (fail closed), or pass --allow-system-disk deliberately." >&2
      exit 1
    fi
  fi
done
mkdir -p "$APP_DATA/dromanian-space/postgres" \
         "$APP_DATA/dromanian-space/config" \
         "$APP_DATA/dromanian-space/backup-staging" \
         "$CLOUD_DATA/dromanian-space/storage"
chmod 700 "$APP_DATA/dromanian-space/config" "$APP_DATA/dromanian-space/backup-staging"
chown 999:999 "$APP_DATA/dromanian-space/postgres" 2>/dev/null || echo "Note: run as root to chown postgres to uid 999"
chown 1000:1000 "$CLOUD_DATA/dromanian-space/storage" 2>/dev/null || echo "Note: run as root to chown storage to uid 1000"
if $WITH_N8N; then
  mkdir -p "$APP_DATA/dromanian-space/n8n/db" "$APP_DATA/dromanian-space/n8n/data"
  # The n8n image runs as the "node" user (uid 1000); only its data directory needs it.
  chown 1000:1000 "$APP_DATA/dromanian-space/n8n/data" 2>/dev/null || echo "Note: run as root to chown n8n/data to 1000:1000"
fi
# Marker files prove the expected server disks are mounted; Compose fails closed without them.
for marker in "$APP_DATA/dromanian-space/.dromanian-space-mount" "$CLOUD_DATA/dromanian-space/.dromanian-space-mount"; do
  if $ALLOW_SYSTEM_DISK; then echo "system-disk-acknowledged $(date -u +%F)" > "$marker"; else touch "$marker"; fi
done
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"
echo "Prepared. Directories, markers and network are in place."

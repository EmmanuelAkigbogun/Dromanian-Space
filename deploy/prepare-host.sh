#!/usr/bin/env bash
# Inventory and (with --apply) prepare the server for Dromanian Space.
# Read-only by default. Never formats disks, changes ownership recursively,
# prints secrets, or removes volumes. Run as a user allowed to use Docker.
set -euo pipefail

APP_DATA=${APP_DATA:-/srv/app-data}
CLOUD_DATA=${CLOUD_DATA:-/srv/cloud-data}
NETWORK=${SUPABASE_NETWORK:-dromanian-supabase}
APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

section() { printf '\n== %s ==\n' "$1"; }

section "System"
uname -m
nproc 2>/dev/null || true
free -h 2>/dev/null || true

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
    echo "Refusing: $base is not a dedicated mount. Mount it first (fail closed)." >&2
    exit 1
  fi
done
mkdir -p "$APP_DATA/dromanian-space/supabase/db/data" \
         "$APP_DATA/dromanian-space/config" \
         "$APP_DATA/dromanian-space/backup-staging" \
         "$CLOUD_DATA/dromanian-space/storage"
chmod 700 "$APP_DATA/dromanian-space/config" "$APP_DATA/dromanian-space/backup-staging"
# Marker files prove the real disks are mounted; the Supabase mount guard checks them.
touch "$APP_DATA/dromanian-space/.dromanian-space-mount" "$CLOUD_DATA/dromanian-space/.dromanian-space-mount"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"
echo "Prepared. Directories, markers and network are in place."

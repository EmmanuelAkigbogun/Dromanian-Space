#!/usr/bin/env bash
# Run the repository's one-shot PostgreSQL migrator against the standalone stack.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for name in POSTGRES_PASSWORD DATABASE_API_PASSWORD APP_JWT_SECRET; do
  [[ -n "${!name:-}" ]] || { echo "$name is required (load the production environment first)." >&2; exit 1; }
done

docker compose run --rm migrate

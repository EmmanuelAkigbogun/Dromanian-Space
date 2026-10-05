#!/usr/bin/env bash
# Apply supabase/migrations to the self-hosted database, in order, each file
# and its bookkeeping row in one transaction. Compatible with the Supabase
# CLI's supabase_migrations.schema_migrations table.
#
#   deploy/migrate.sh status                  list applied and pending files
#   deploy/migrate.sh apply                   apply pending files (stops at the first error)
#   deploy/migrate.sh mark-applied <version>  record a version without running it
#                                             (only for the legacy baseline; see docs/DATABASE.md)
#
# Environment: DB_CONTAINER (default supabase-db), DB_USER (default postgres),
# PGPASSWORD_FILE (file containing the database password; optional).
# Take a backup first (deploy/backup/backup.sh). Rehearse on staging.
set -euo pipefail

DB_CONTAINER=${DB_CONTAINER:-supabase-db}
DB_USER=${DB_USER:-postgres}
DIR=$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations
# The password travels through the environment, never the command line.
PASS_ARGS=()
if [[ -n "${PGPASSWORD_FILE:-}" ]]; then
  PGPASSWORD=$(cat "$PGPASSWORD_FILE")
  export PGPASSWORD
  PASS_ARGS=(-e PGPASSWORD)
fi

psql_exec() {
  docker exec -i ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} "$DB_CONTAINER" psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -X -q "$@"
}

psql_exec -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);"
applied=$(psql_exec -A -t -c "SELECT version FROM supabase_migrations.schema_migrations")

is_applied() { grep -qx "$1" <<<"$applied"; }

case "${1:-status}" in
  status)
    for f in "$DIR"/*.sql; do
      v=$(basename "$f" | cut -d_ -f1)
      if is_applied "$v"; then echo "applied  $(basename "$f")"; else echo "PENDING  $(basename "$f")"; fi
    done
    ;;
  apply)
    for f in "$DIR"/*.sql; do
      name=$(basename "$f")
      v=${name%%_*}
      is_applied "$v" && continue
      echo "Applying $name"
      { cat "$f"; printf "\nINSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('%s', '%s');\n" "$v" "${name%.sql}"; } \
        | psql_exec --single-transaction
    done
    echo "Up to date."
    ;;
  mark-applied)
    v=${2:?version required}
    [[ "$v" =~ ^[0-9]{14}$ ]] || { echo "Invalid version" >&2; exit 1; }
    psql_exec -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$v', 'marked applied') ON CONFLICT DO NOTHING"
    echo "Recorded $v as applied."
    ;;
  *)
    echo "Usage: $0 status|apply|mark-applied <version>" >&2
    exit 1
    ;;
esac

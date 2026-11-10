#!/usr/bin/env bash
set -euo pipefail

psql_base=(psql -v ON_ERROR_STOP=1 -X -q)
MIGRATION_LOCK_TIMEOUT_SECONDS=${MIGRATION_LOCK_TIMEOUT_SECONDS:-60}
MIGRATION_DDL_LOCK_TIMEOUT_SECONDS=${MIGRATION_DDL_LOCK_TIMEOUT_SECONDS:-15}

if ! [[ "$MIGRATION_LOCK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
  || ! [[ "$MIGRATION_DDL_LOCK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Migration lock timeouts must be positive whole seconds." >&2
  exit 2
fi

emit_migration_lock() {
  # statement_timeout provides a hard upper bound even if PostgreSQL's
  # lock_timeout semantics change for advisory locks. Reset it immediately
  # after the lock is owned so long migrations are not killed by this guard.
  printf "SET LOCAL lock_timeout = '%ss';\n" "$MIGRATION_LOCK_TIMEOUT_SECONDS"
  printf "SET LOCAL statement_timeout = '%ss';\n" "$MIGRATION_LOCK_TIMEOUT_SECONDS"
  echo "SELECT pg_advisory_xact_lock(hashtextextended('dromanian-space:migrations', 0));"
  echo "SET LOCAL statement_timeout = '0';"
}

# Bootstrap and the migration ledger share the same database lock as normal
# migrations. Two first-install containers can both observe an empty database;
# the second must re-check only after the first transaction commits.
echo "Checking database bootstrap and migration ledger"
{
  emit_migration_lock
  echo "SELECT to_regclass('auth.users') IS NOT NULL AS database_initialized \\gset"
  echo '\if :database_initialized'
  echo '\else'
  echo '\echo Initializing database roles and schemas'
  sed 's/CREATE EXTENSION IF NOT EXISTS pg_cron;/-- scheduling is handled by the Node worker/g' /app/database/bootstrap.sql
  echo '\endif'
  cat <<'SQL'
ALTER ROLE authenticator PASSWORD :'api_password';
CREATE SCHEMA IF NOT EXISTS app_migrations;
CREATE TABLE IF NOT EXISTS app_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
} | "${psql_base[@]}" --set=api_password="$DATABASE_API_PASSWORD" --single-transaction

for file in /app/database/migrations/*.sql; do
  name=$(basename "$file")
  version=${name%%_*}
  checksum=$(sha256sum "$file" | cut -d' ' -f1)
  recorded=$("${psql_base[@]}" -Atc "SELECT sha256 FROM app_migrations.schema_migrations WHERE version = '$version'")
  if [[ -n "$recorded" ]]; then
    [[ "$recorded" == "$checksum" ]] || { echo "Migration drift: $name" >&2; exit 1; }
    continue
  fi
  echo "Applying $name"
  {
    # Serialize deployers in PostgreSQL itself. A second Coolify container can
    # pass the shell pre-check while the first is still applying this file, so
    # re-check only after the transaction owns the advisory lock.
    emit_migration_lock
    printf "SELECT EXISTS (SELECT 1 FROM app_migrations.schema_migrations WHERE version = '%s') AS migration_applied \\gset\n" "$version"
    echo '\if :migration_applied'
    printf "DO \$\$ BEGIN IF (SELECT sha256 FROM app_migrations.schema_migrations WHERE version = '%s') <> '%s' THEN RAISE EXCEPTION 'Migration drift: %s'; END IF; END \$\$;\n" "$version" "$checksum" "$name"
    echo '\else'
    printf "SET LOCAL lock_timeout = '%ss';\n" "$MIGRATION_DDL_LOCK_TIMEOUT_SECONDS"
    sed 's/CREATE EXTENSION IF NOT EXISTS pg_cron;/-- scheduling is handled by the Node worker/g' "$file"
    printf "INSERT INTO app_migrations.schema_migrations (version,name,sha256) VALUES ('%s','%s','%s');\n" "$version" "${name%.sql}" "$checksum"
    echo '\endif'
  } | "${psql_base[@]}" --single-transaction
done

echo "Database migrations are up to date."


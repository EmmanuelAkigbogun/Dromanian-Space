#!/usr/bin/env bash
set -euo pipefail

psql_base=(psql -v ON_ERROR_STOP=1 -X -q)

initialized=$("${psql_base[@]}" -Atc "SELECT to_regclass('auth.users') IS NOT NULL")
if [[ "$initialized" != "t" ]]; then
  echo "Initializing database roles and schemas"
  sed 's/CREATE EXTENSION IF NOT EXISTS pg_cron;/-- scheduling is handled by the Node worker/g' /app/database/bootstrap.sql \
    | "${psql_base[@]}" --single-transaction
fi

"${psql_base[@]}" --set=api_password="$DATABASE_API_PASSWORD" <<'SQL'
ALTER ROLE authenticator PASSWORD :'api_password';
CREATE SCHEMA IF NOT EXISTS app_migrations;
CREATE TABLE IF NOT EXISTS app_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

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
    echo "SET LOCAL lock_timeout = '15s';"
    sed 's/CREATE EXTENSION IF NOT EXISTS pg_cron;/-- scheduling is handled by the Node worker/g' "$file"
    printf "INSERT INTO app_migrations.schema_migrations (version,name,sha256) VALUES ('%s','%s','%s');\n" "$version" "${name%.sql}" "$checksum"
  } | "${psql_base[@]}" --single-transaction
done

echo "Database migrations are up to date."


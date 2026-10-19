#!/usr/bin/env bash
# Apply supabase/migrations to the self-hosted database, in order. Each file
# and its bookkeeping rows run in one transaction; the first error stops the
# run and leaves that file entirely unapplied. Compatible with the Supabase
# CLI's supabase_migrations.schema_migrations table.
#
#   deploy/migrate.sh status                  applied, pending and drifted files
#   deploy/migrate.sh check                   exit 0 only if apply would be safe (used by preflight.sh)
#   deploy/migrate.sh apply [--to <version>]  apply pending files (stops at the first error);
#                                             --to stops after that version (restores)
#   deploy/migrate.sh mark-applied <version>  record the legacy baseline as present without running it
#                                             (existing installations only; see docs/DATABASE.md)
#
# Safety rules enforced here:
#   * An existing database with application tables but no migration history
#     is never migrated: the legacy baseline must not be replayed on it.
#   * A file whose content changed after it was applied (checksum drift), a
#     version applied in the database but missing from the repository, or a
#     pending file older than the newest applied one stops `apply`.
#   * Each migration waits at most LOCK_TIMEOUT for table locks, so a busy
#     table makes the migration fail cleanly instead of blocking the app.
#
# Environment: DB_CONTAINER (auto-detected; default supabase-db), DB_USER
# (default postgres), PGPASSWORD_FILE (file with the database password),
# LOCK_TIMEOUT (default 15s). Take a backup first (deploy/backup/backup.sh).
set -euo pipefail

DB_USER=${DB_USER:-postgres}
LOCK_TIMEOUT=${LOCK_TIMEOUT:-15s}
DIR=$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations
BASELINE=20261004000000

detect_container() {
  if [[ -n "${DB_CONTAINER:-}" ]]; then echo "$DB_CONTAINER"; return; fi
  if docker inspect supabase-db >/dev/null 2>&1; then echo supabase-db; return; fi
  # Coolify may name containers after the resource; find the Supabase db service.
  local found
  found=$(docker ps --filter label=com.docker.compose.service=db --format '{{.Names}} {{.Image}}' \
    | awk '$2 ~ /^(supabase\/postgres:|dromanian-supabase-db:)/ {print $1}')
  if [[ $(wc -w <<<"$found") -eq 1 ]]; then echo "$found"; return; fi
  echo "Cannot identify the Supabase database container (found: ${found:-none}). Set DB_CONTAINER." >&2
  exit 1
}
DB_CONTAINER=$(detect_container)

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

sha() { sha256sum "$1" | cut -d' ' -f1; }

command=${1:-status}
# Bookkeeping tables are created only by commands that write; status and
# check are read-only.
if [[ "$command" == "apply" || "$command" == "mark-applied" ]]; then
  psql_exec -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    CREATE TABLE IF NOT EXISTS supabase_migrations.dromanian_checksums (
      version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), how text NOT NULL DEFAULT 'applied');" >/dev/null
fi

applied=""
checksums=""
if [[ $(psql_exec -A -t -c "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL") == "t" ]]; then
  applied=$(psql_exec -A -t -c "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version")
fi
if [[ $(psql_exec -A -t -c "SELECT to_regclass('supabase_migrations.dromanian_checksums') IS NOT NULL") == "t" ]]; then
  checksums=$(psql_exec -A -t -F' ' -c "SELECT version, sha256 FROM supabase_migrations.dromanian_checksums")
fi
app_tables=$(psql_exec -A -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")

is_applied() { grep -qx "$1" <<<"$applied"; }
recorded_sha() { awk -v v="$1" '$1 == v {print $2}' <<<"$checksums"; }

files=("$DIR"/*.sql)
versions=()
for f in "${files[@]}"; do versions+=("$(basename "$f" | cut -d_ -f1)"); done
newest_applied=$(tail -n1 <<<"$applied")

problems=()
for i in "${!files[@]}"; do
  v=${versions[$i]}
  if is_applied "$v"; then
    rec=$(recorded_sha "$v")
    if [[ -n "$rec" && "$rec" != "$(sha "${files[$i]}")" ]]; then
      problems+=("DRIFT: $(basename "${files[$i]}") changed after it was applied (recorded ${rec:0:12}…)")
    fi
  elif [[ -n "$newest_applied" && "$v" < "$newest_applied" ]]; then
    problems+=("OUT OF ORDER: $(basename "${files[$i]}") is older than the newest applied version $newest_applied")
  fi
done
while read -r v; do
  [[ -z "$v" ]] && continue
  printf '%s\n' "${versions[@]}" | grep -qx "$v" || problems+=("UNKNOWN: version $v is applied in the database but not in this repository")
done <<<"$applied"
if [[ -z "$applied" && "$app_tables" -gt 0 ]]; then
  problems+=("EXISTING DATABASE WITHOUT HISTORY: $app_tables public tables exist but no migrations are recorded. Do not replay the legacy baseline; follow docs/DATABASE.md (verify, then mark-applied $BASELINE).")
fi

report_problems() {
  local p
  for p in "${problems[@]}"; do echo "$p" >&2; done
}

case "$command" in
  status)
    echo "Database container: $DB_CONTAINER, public tables: $app_tables"
    for i in "${!files[@]}"; do
      if is_applied "${versions[$i]}"; then echo "applied  $(basename "${files[$i]}")"; else echo "PENDING  $(basename "${files[$i]}")"; fi
    done
    ((${#problems[@]})) && report_problems
    exit 0
    ;;
  check)
    if ((${#problems[@]})); then report_problems; exit 1; fi
    pending=0
    for v in "${versions[@]}"; do is_applied "$v" || pending=$((pending + 1)); done
    echo "Migration history consistent; $pending pending."
    ;;
  apply)
    # Optional upper bound, used when restoring a backup taken at an older schema.
    upto=""
    if [[ "${2:-}" == "--to" ]]; then
      upto=${3:?version required after --to}
      [[ "$upto" =~ ^[0-9]{14}$ ]] || { echo "Invalid version" >&2; exit 1; }
    fi
    if ((${#problems[@]})); then
      report_problems
      echo "Nothing applied. Resolve the problems above first." >&2
      exit 1
    fi
    for i in "${!files[@]}"; do
      f=${files[$i]}
      name=$(basename "$f")
      v=${versions[$i]}
      is_applied "$v" && continue
      [[ -n "$upto" && "$v" > "$upto" ]] && break
      echo "Applying $name"
      {
        printf "SET LOCAL lock_timeout = '%s';\n" "$LOCK_TIMEOUT"
        cat "$f"
        printf "\nINSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('%s', '%s');\n" "$v" "${name%.sql}"
        printf "INSERT INTO supabase_migrations.dromanian_checksums (version, sha256) VALUES ('%s', '%s');\n" "$v" "$(sha "$f")"
      } | psql_exec --single-transaction
    done
    echo "Up to date."
    ;;
  mark-applied)
    v=${2:?version required}
    [[ "$v" =~ ^[0-9]{14}$ ]] || { echo "Invalid version" >&2; exit 1; }
    [[ "$v" == "$BASELINE" ]] || { echo "Only the legacy baseline ($BASELINE) may be marked applied." >&2; exit 1; }
    f=$(ls "$DIR/${v}_"*.sql)
    psql_exec -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$v', 'marked applied') ON CONFLICT DO NOTHING;
      INSERT INTO supabase_migrations.dromanian_checksums (version, sha256, how) VALUES ('$v', '$(sha "$f")', 'marked') ON CONFLICT DO NOTHING;"
    echo "Recorded $v as applied."
    ;;
  *)
    echo "Usage: $0 status|check|apply [--to <version>]|mark-applied <version>" >&2
    exit 1
    ;;
esac

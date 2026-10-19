#!/usr/bin/env sh
# Creates the Supabase environment file with freshly generated secrets, using
# the pinned upstream generators (utils/generate-keys.sh, utils/add-new-auth-keys.sh).
#
#   deploy/supabase/generate-env.sh [OUTPUT]
#
# OUTPUT defaults to /srv/app-data/dromanian-space/config/supabase.env. The file
# is created with mode 600 and never overwritten: rotating secrets on a running
# installation is a separate, deliberate procedure (docs/DISASTER_RECOVERY.md).
# Requires openssl and node >= 16 (or docker). Prints nothing secret.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-/srv/app-data/dromanian-space/config/supabase.env}

if [ -e "$out" ]; then
  echo "Refusing to overwrite $out (it may hold the secrets of a running installation)." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
cp "$here/.env.example" "$work/.env"
cp "$here/utils/generate-keys.sh" "$here/utils/add-new-auth-keys.sh" "$work/"
# add-new-auth-keys.sh checks that the compose file enables the asymmetric
# keys; ours already does, so it only verifies a throwaway copy.
cp "$here/docker-compose.yml" "$work/docker-compose.yml"

# The upstream scripts fill in variables that already exist in .env.
for name in LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN MINIO_ROOT_PASSWORD; do
  grep -q "^$name=" "$work/.env" || echo "$name=" >> "$work/.env"
done

(cd "$work" && sh ./generate-keys.sh --update-env >/dev/null && sh ./add-new-auth-keys.sh --update-env >/dev/null)

# Values this stack does not use.
sed -i '/^LOGFLARE_PUBLIC_ACCESS_TOKEN=/d; /^LOGFLARE_PRIVATE_ACCESS_TOKEN=/d; /^MINIO_ROOT_PASSWORD=/d' "$work/.env"

missing=""
for name in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRET_KEY_BASE REALTIME_DB_ENC_KEY VAULT_ENC_KEY \
            PG_META_CRYPTO_KEY S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET DASHBOARD_PASSWORD \
            SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY JWT_KEYS JWT_JWKS ANON_KEY_ASYMMETRIC SERVICE_ROLE_KEY_ASYMMETRIC; do
  grep -q "^$name=..*" "$work/.env" || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "Generation incomplete; missing:$missing" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
cp "$work/.env" "$out"
chmod 600 "$out"
echo "Wrote $out (mode 600)."
echo "Next: fill in SMTP_* and check the URLs, then paste the variables into the Coolify Supabase resource."
echo "The app needs SUPABASE_PUBLISHABLE_KEY (as VITE_SUPABASE_ANON_KEY) and SUPABASE_SECRET_KEY from this file."

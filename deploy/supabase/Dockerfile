# Coolify treats repository-relative Compose bind mounts as persistent paths.
# Bake versioned configuration into thin layers over the pinned upstream images
# so a first deployment cannot turn missing source files into directories.

FROM supabase/studio:2026.09.07-sha-7996410 AS studio
COPY volumes/snippets/ /app/snippets/
COPY volumes/functions/ /app/edge-functions/

FROM envoyproxy/envoy:v1.39.1 AS api-gw
COPY volumes/api/envoy/envoy.yaml /etc/envoy/envoy.yaml
COPY volumes/api/envoy/cds.yaml /etc/envoy/cds.yaml
COPY volumes/api/envoy/lds.template.yaml /etc/envoy/lds.template.yaml
COPY volumes/api/envoy/docker-entrypoint.sh /docker-entrypoint.sh

FROM supabase/edge-runtime:v1.76.2 AS functions
COPY volumes/functions/ /home/deno/functions/

FROM supabase/postgres:17.6.1.136 AS db
COPY volumes/db/realtime.sql /docker-entrypoint-initdb.d/migrations/99-realtime.sql
COPY volumes/db/webhooks.sql /docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql
COPY volumes/db/roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
COPY volumes/db/jwt.sql /docker-entrypoint-initdb.d/init-scripts/99-jwt.sql
COPY volumes/db/_supabase.sql /docker-entrypoint-initdb.d/migrations/97-_supabase.sql
COPY volumes/db/logs.sql /docker-entrypoint-initdb.d/migrations/99-logs.sql
COPY volumes/db/pooler.sql /docker-entrypoint-initdb.d/migrations/99-pooler.sql
COPY volumes/db/init/data.sql /docker-entrypoint-initdb.d/migrations/99-data.sql

FROM supabase/supavisor:2.9.12 AS supavisor
COPY volumes/pooler/pooler.exs /etc/pooler/pooler.exs

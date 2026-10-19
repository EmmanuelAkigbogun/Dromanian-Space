# Disposable test environment: runs the repository's full check suite
# (unit, database and server tests, build, lint) against a throwaway
# PostgreSQL 17 + pgvector + PostgREST inside this container. Nothing is
# published and no production resource is touched. See deploy/test/run.sh.
FROM node:24.15.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17 postgresql-17-pgvector \
 && curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v14.17/postgrest-v14.17-linux-static-x86-64.tar.xz \
      | tar -xJ -C /usr/local/bin \
 && rm -rf /var/lib/apt/lists/*

ENV LOCAL_PG_BIN=/usr/lib/postgresql/17/bin \
    LOCAL_POSTGREST_BIN=/usr/local/bin/postgrest \
    CI=1

# PostgreSQL refuses to run as root.
USER node
WORKDIR /home/node/app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .

CMD ["sh", "-c", "npm test && npm run build && npm run build:server && npm run lint"]

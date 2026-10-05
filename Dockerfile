# syntax=docker/dockerfile:1.7
# Images for a Coolify (or any Docker Compose) deployment:
#   target "web"    — Nginx (unprivileged) serving the built SPA and proxying /api/*
#   target "server" — Node runtime for the API (server/main.ts) and the worker
#                     (server/worker-main.ts); the compose file picks the command.
# Base images are pinned; update them deliberately (see docs/SELF_HOSTING.md).

FROM node:24.15.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
# Public browser configuration is compiled into the bundle (never secrets).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_APP_NAME="Dromanian Space"
ARG VITE_APP_URL
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY} \
    VITE_APP_NAME=${VITE_APP_NAME} \
    VITE_APP_URL=${VITE_APP_URL}
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY" \
    || (echo "Set the VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY build arguments" && exit 1)
RUN npm run build && npm run build:server

FROM node:24.15.0-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist-server/main.mjs"]

FROM nginxinc/nginx-unprivileged:1.30.5-alpine AS web
ENV API_UPSTREAM=api:3000
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

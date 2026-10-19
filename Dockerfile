# syntax=docker/dockerfile:1.7

FROM node:24.15.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ARG VITE_APP_NAME="Dromanian Space"
ARG VITE_APP_URL
ENV VITE_APP_NAME=${VITE_APP_NAME} VITE_APP_URL=${VITE_APP_URL}
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

FROM postgres:17.6-bookworm AS migrations
COPY database/ /app/database/
RUN chmod 755 /app/database/migrate.sh
ENTRYPOINT ["/app/database/migrate.sh"]

FROM nginxinc/nginx-unprivileged:1.30.5-alpine AS web
ENV API_UPSTREAM=api:3000
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

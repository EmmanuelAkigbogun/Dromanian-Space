# syntax=docker/dockerfile:1.7

FROM node:24.15.0-bookworm-slim AS deps
ENV PUPPETEER_SKIP_DOWNLOAD=true
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
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/server/templates ./server/templates
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist-server/main.mjs"]

FROM postgres:17.6-bookworm AS migrations
COPY database/ /app/database/
RUN chmod 755 /app/database/migrate.sh
ENTRYPOINT ["/app/database/migrate.sh"]

FROM nginxinc/nginx-unprivileged:1.30.5-alpine AS web
ENV API_UPSTREAM=api:3000 \
    LIVEKIT_UPSTREAM=livekit:7880 \
    ONLYOFFICE_UPSTREAM=onlyoffice:80
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/nginx/office-headers.conf /etc/nginx/snippets/office-headers.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

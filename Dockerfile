# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS deps
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

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS server
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/server/templates ./server/templates
COPY --from=build /app/tools/browser-scraper-smoke.mjs ./tools/browser-scraper-smoke.mjs
USER node
EXPOSE 3000 3001
CMD ["node", "--enable-source-maps", "dist-server/main.mjs"]

FROM python:3.13.17-slim-bookworm@sha256:e32be0e55814a08977501ca863271d9bd02443710db8f2afaf8372e2c4508530 AS agno
COPY --from=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OTEL_SDK_DISABLED=true \
    HOME=/tmp
WORKDIR /app
COPY agno/pyproject.toml agno/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY agno/app.py ./app.py
# Same uid as the server image's `node` user, which writes the shared storage
# volume: provider keys saved in AI settings are owner-only (0600 in a 0700
# directory). The volume is mounted read-only here, so Agno can read them but
# never change them.
USER 1000:1000
EXPOSE 8000
CMD ["/app/.venv/bin/python", "app.py"]

FROM postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3 AS migrations
COPY database/ /app/database/
RUN chmod 755 /app/database/migrate.sh
ENTRYPOINT ["/app/database/migrate.sh"]

FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86 AS crawl4ai-gateway
COPY deploy/nginx/crawl4ai-gateway.conf /etc/nginx/nginx.conf
EXPOSE 8080

FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86 AS web
ENV API_UPSTREAM=api:3000 \
    LIVEKIT_UPSTREAM=livekit:7880 \
    ONLYOFFICE_UPSTREAM=onlyoffice:80
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/nginx/office-headers.conf /etc/nginx/snippets/office-headers.conf
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

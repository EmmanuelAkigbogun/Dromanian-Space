import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('standalone compose safety', () => {
  const compose = read('docker-compose.yml');

  it('pins every production image reference to an immutable digest', () => {
    const imageRef = /:[^@\s]+@sha256:[a-f0-9]{64}$/;
    for (const composeFile of ['docker-compose.yml', 'deploy/n8n/docker-compose.yml']) {
      const refs = [...read(composeFile).matchAll(/^\s+image:\s+([^\s#]+)/gm)].map((match) => match[1]);
      expect(refs.length, composeFile).toBeGreaterThan(0);
      for (const ref of refs) expect(ref, `${composeFile}: ${ref}`).toMatch(imageRef);
    }

    const dockerfile = read('Dockerfile');
    const syntaxRef = dockerfile.match(/^# syntax=(\S+)/m)?.[1];
    expect(syntaxRef, 'Dockerfile frontend').toMatch(imageRef);
    const internalStages = new Set(
      [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((match) => match[1]),
    );
    const fromRefs = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((match) => match[1]);
    const copyRefs = [...dockerfile.matchAll(/^COPY\s+--from=(\S+)/gim)].map((match) => match[1]);
    const externalRefs = [...fromRefs, ...copyRefs].filter((ref) => !internalStages.has(ref));
    for (const ref of externalRefs) expect(ref, `Dockerfile: ${ref}`).toMatch(imageRef);

    const databaseImage = compose.match(/^\s+image:\s+(pgvector\/pgvector:[^\s#]+)/m)?.[1];
    expect(databaseImage).toBeTruthy();
    expect(read('deploy/backup/verify-restore.sh')).toContain(`DB_IMAGE=\${DB_IMAGE:-${databaseImage}}`);
  });

  it('keeps operator CRM spreadsheets out of source and Docker contexts', () => {
    for (const ignoreFile of ['.gitignore', '.dockerignore']) {
      const ignored = read(ignoreFile);
      expect(ignored).toContain('database/*.xls');
      expect(ignored).toContain('database/*.xlsx');
      expect(ignored).toContain('**/.pytest_cache/');
      if (ignoreFile === '.dockerignore') expect(ignored).toContain('release/');
    }
  });

  it('keeps PostgreSQL and storage on the dedicated server disks', () => {
    expect(compose).toContain('source: /srv/app-data/dromanian-space/postgres');
    expect(compose).toContain('source: /srv/cloud-data/dromanian-space/storage');
    expect(compose.match(/create_host_path: false/g)?.length).toBeGreaterThanOrEqual(3);
    expect(compose).toMatch(/db:[\s\S]*?mount-guard:\s*\n\s*condition: service_completed_successfully/);
  });

  it('publishes web on loopback and only the authenticated scraper gateway on the bridge gateway', () => {
    expect(compose).toContain('127.0.0.1:${WEB_HOST_PORT:-3008}:8080');
    expect(compose).toContain(
      '${DOCKER_HOST_GATEWAY_IP:?DOCKER_HOST_GATEWAY_IP must be the Docker bridge gateway}:11235:8080',
    );
    expect(compose).not.toMatch(/-\s*['"]?\d+:5432/);
    expect(compose).not.toMatch(/-\s*['"]?\d+:3000/);
  });

  it('keeps database credentials out of the browser build', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).not.toMatch(/VITE_(DATABASE|JWT|POSTGRES)/);
    expect(compose).toContain('APP_JWT_SECRET: ${APP_JWT_SECRET:?APP_JWT_SECRET}');
  });

  it('passes the optional Cloudflare Domains fallback only to the API', () => {
    const api = compose.match(/\n  api:\n([\s\S]*?)\n  agno:/)?.[1] ?? '';
    const worker = compose.match(/\n  worker:\n([\s\S]*?)\n  livekit:/)?.[1] ?? '';
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_TUNNEL_ID',
      'CLOUDFLARE_TUNNEL_SERVICE',
    ]) {
      expect(api).toContain(`${name}: \${${name}:-`);
      expect(worker).not.toContain(`${name}:`);
    }
    expect(api).toContain(
      'CLOUDFLARE_TUNNEL_SERVICE: ${CLOUDFLARE_TUNNEL_SERVICE:-http://web:8080}',
    );
  });

  it('keeps the social browser outside secret-bearing app containers', () => {
    const dockerfile = read('Dockerfile');
    const social = read('server/social.ts');
    const productionEnv = read('.env.production.example');
    expect(dockerfile).toContain('PUPPETEER_SKIP_DOWNLOAD=true');
    expect(dockerfile).not.toContain('PUPPETEER_EXECUTABLE_PATH');
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*chromium/);
    expect(compose).toContain('SOCIAL_BROWSER_WS_ENDPOINT: ${SOCIAL_BROWSER_WS_ENDPOINT:-}');
    expect(compose).toContain('SOCIAL_BROWSER_TOKEN: ${SOCIAL_BROWSER_TOKEN:-}');
    expect(social).not.toContain('--no-sandbox');
    expect(social).toContain("url.protocol !== 'wss:'");
    expect(social).toContain('browser.createBrowserContext()');
    expect(social).toContain('isolated.context.newPage()');
    expect(social).toContain('session.browser.disconnect()');
    expect(social).not.toMatch(/await\s+browser\.newPage\(/);
    expect(social).not.toMatch(/await\s+browser(?:\?)?\.close\(/);
    expect(productionEnv).toContain('CRAWL4AI_TOKEN_EPOCH=1');
    expect(productionEnv).toContain('DOCKER_HOST_GATEWAY_IP=');
    expect(productionEnv).toContain('SOCIAL_BROWSER_WS_ENDPOINT=');
    expect(productionEnv).toContain('SOCIAL_BROWSER_TOKEN=');
  });

  it('runs the agent orchestrator as an isolated, pinned Agno service', () => {
    const dockerfile = read('Dockerfile');
    const project = read('agno/pyproject.toml');
    expect(compose).toMatch(/agno:\s*[\s\S]*?target: agno/);
    expect(compose).toContain('AGNO_URL: http://agno:8000');
    expect(compose).toContain('AGNO_TOOL_CALLBACK_URL: http://worker:3001/tool');
    expect(dockerfile).toContain('ghcr.io/astral-sh/uv:0.13.5');
    expect(dockerfile).toContain('uv sync --locked');
    // Agno must run as the server's uid to read provider keys saved in AI settings (0600).
    expect(dockerfile).toMatch(/FROM python[^\n]* AS agno[\s\S]*?USER 1000:1000/);
    expect(dockerfile).not.toContain('USER nobody');
    expect(project).toContain('agno[anthropic,cerebras,google,openai]==3.1.10');
    expect(project).not.toContain('google-adk');
    expect(compose).toContain('AI_DEFAULT_PROVIDER: ${AI_DEFAULT_PROVIDER:-openai}');
    expect(compose).toContain('AI_DEFAULT_OPENAI_MODEL: ${AI_DEFAULT_OPENAI_MODEL:-gpt-6.1-sol}');
    expect(compose).toContain('CEREBRAS_API_KEY: ${CEREBRAS_API_KEY:-}');
    const lock = read('agno/uv.lock');
    expect(lock).toContain('name = "agno"');
    expect(lock).not.toContain('name = "google-adk"');
  });

  it('runs the browser scraper as a pinned private authenticated service', () => {
    const service = compose.match(/\n  crawl4ai:\n([\s\S]*?)\n  crawl4ai-gateway:/)?.[1] ?? '';
    const gateway = compose.match(/\n  crawl4ai-gateway:\n([\s\S]*?)\n  db:/)?.[1] ?? '';
    const api = compose.match(/\n  api:\n([\s\S]*?)\n  agno:/)?.[1] ?? '';
    const worker = compose.match(/\n  worker:\n([\s\S]*?)\n  livekit:/)?.[1] ?? '';
    const gatewayConfig = read('deploy/nginx/crawl4ai-gateway.conf');
    const dockerfile = read('Dockerfile');
    expect(service).toContain('image: unclecode/crawl4ai:0.9.5');
    expect(service).toContain('browser-scraper-token:/run/secrets:ro');
    expect(service).toContain('read_only: true');
    expect(service).toContain('cap_drop:');
    expect(service).toContain('CRAWL4AI_ALLOW_DEEP_CRAWL: "false"');
    expect(service).toContain('Authorization: Bearer $$TOKEN');
    expect(service).toContain('network_mode: bridge');
    expect(service).toContain('DOCKER_HOST_GATEWAY_IP must be the Docker bridge gateway}:11235:8080');
    expect(service).not.toContain('networks:');
    expect(service).not.toContain(':11235:11235');
    expect(gateway).toContain('build:\n      context: .\n      dockerfile: Dockerfile\n      target: crawl4ai-gateway');
    expect(gateway).toContain('read_only: true');
    expect(gateway).toContain('cap_drop:\n      - ALL');
    expect(gateway).not.toContain('volumes:');
    expect(gateway).toContain('network_mode: service:crawl4ai');
    expect(gateway).toContain('CRAWL4AI_TOKEN_EPOCH: ${CRAWL4AI_TOKEN_EPOCH:-1}');
    expect(gateway).not.toContain('networks:');
    expect(gateway).not.toMatch(/\n\s+ports:/);
    expect(gateway).not.toContain('browser-scraper-token:/');
    expect(compose).toContain('CRAWL4AI_API_TOKEN_FILE: /run/browser-scraper/api_token');
    expect(compose).toContain('CRAWL4AI_URL: http://host.docker.internal:11235');
    expect(compose).toMatch(/browser-scraper-token:[\s\S]*?network_mode: none/);
    expect(compose).toContain('busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec');
    expect(compose).toMatch(/browser-scraper-token:[\s\S]*?head -c 32 \/dev\/urandom/);
    expect(compose).toContain('current_epoch="$$(cat /run/browser-scraper/token_epoch 2>/dev/null || true)"');
    expect(compose).toContain('[ "$$current_epoch" != "$$epoch" ]');
    expect(compose).toContain('mv /run/browser-scraper/.token_epoch.tmp /run/browser-scraper/token_epoch');
    expect(compose.match(/browser-scraper-token:[\s\S]*?network_mode: none/)?.[0]).not.toContain('APP_JWT_SECRET');
    expect(compose).toContain('CRAWL4AI_TOKEN_EPOCH: ${CRAWL4AI_TOKEN_EPOCH:-1}');
    expect(api).toContain('networks:\n      - default');
    expect(api).toContain('extra_hosts:\n      - "host.docker.internal:host-gateway"');
    expect(worker).toContain('networks:\n      - default');
    expect(worker).toContain('extra_hosts:\n      - "host.docker.internal:host-gateway"');
    expect(compose).not.toContain('browser-egress');
    expect(gatewayConfig).toContain('server 127.0.0.1:11235;');
    expect(gatewayConfig).not.toContain('resolver 127.0.0.11');
    expect(gatewayConfig).toContain('location = /schema');
    expect(gatewayConfig).toContain('limit_except GET');
    expect(gatewayConfig).toContain('location = /md');
    expect(gatewayConfig).toContain('limit_except POST');
    expect(gatewayConfig).toContain('proxy_set_header Authorization $http_authorization;');
    expect(gatewayConfig).toContain('fastcgi_temp_path /tmp/fastcgi_temp;');
    expect(gatewayConfig).toContain('uwsgi_temp_path /tmp/uwsgi_temp;');
    expect(gatewayConfig).toContain('scgi_temp_path /tmp/scgi_temp;');
    expect(gatewayConfig).toMatch(/location \/ \{\s*return 404;/);
    expect(gatewayConfig).not.toMatch(/proxy_pass\s+http:\/\/\$/);
    expect(dockerfile).toContain('FROM nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86 AS crawl4ai-gateway');
    expect(dockerfile).toMatch(/AS crawl4ai-gateway\nCOPY deploy\/nginx\/crawl4ai-gateway\.conf \/etc\/nginx\/nginx\.conf\nEXPOSE 8080/);
    expect(dockerfile).toContain('tools/browser-scraper-smoke.mjs');
    const smoke = read('tools/browser-scraper-smoke.mjs');
    expect(smoke).toContain("'http://host.docker.internal:11235'");
    expect(smoke).toContain("authorization: `Bearer ${token}`");
    expect(smoke).toContain("`${baseUrl}/schema`");
    expect(smoke).toContain("`${baseUrl}/md`");
    expect(smoke).toContain("redirect: 'error'");
  });

  it('enforces the selected recovery policy and fails preflight closed on unverified recovery', () => {
    const preflight = read('deploy/preflight.sh');
    const backup = read('deploy/backup/backup.sh');
    const restoreDrill = read('deploy/backup/restore-test.sh');

    expect(backup).toContain('rclone check --one-way');
    expect(backup).toContain('remote_archive_sha256=$(rclone cat');
    expect(backup).toContain('[[ "$remote_archive_sha256" == "$archive_sha256" ]]');
    expect(backup).toContain('last-offsite-success');
    expect(backup).toContain('Set RCLONE_REMOTE to an off-server rclone destination.');
    expect(backup).toContain('BACKUP_STORAGE_POLICY=${BACKUP_STORAGE_POLICY:-offsite}');
    expect(backup).toContain('case "$BACKUP_STORAGE_POLICY" in');
    expect(backup).toContain("BACKUP_STORAGE_POLICY must be exactly 'offsite' or 'local'");
    expect(backup).toContain('[[ "$BACKUP_STORAGE_POLICY" == offsite ]] && required_commands+=(rclone)');
    expect(backup).toContain('if [[ "$BACKUP_STORAGE_POLICY" == offsite ]]; then');
    expect(backup).toContain('BACKUP_STORAGE_POLICY=local keeps recovery archives on this host');
    expect(backup).toContain('Local encrypted archive verified, but no off-server copy exists');
    expect(backup).toContain("grep -R -q --binary-files=without-match 'AGE-SECRET-KEY-'");
    expect(backup).toContain('remove it before backup');
    expect(backup).not.toContain('WARNING: no RCLONE_REMOTE set');
    expect(backup.indexOf('rclone check --one-way')).toBeLessThan(backup.indexOf('mv -f -- "$marker_tmp" "$OFFSITE_SUCCESS_MARKER"'));
    expect(backup).toContain('archive_sha256=$(sha256sum "$archive"');
    expect(backup).toContain('[[ "$verified_archive_sha256" == "$archive_sha256" ]]');
    expect(backup).toContain("printf '%s %s %s\\n' \"$stamp\" \"$(basename \"$archive\")\" \"$archive_sha256\"");
    expect(restoreDrill).toContain('last-restore-drill');
    expect(restoreDrill.indexOf('[[ "$code" == "200" ]]')).toBeLessThan(restoreDrill.indexOf('mv -f -- "$marker_tmp" "$RESTORE_DRILL_MARKER"'));
    expect(restoreDrill).toContain('archive_sha256=$(sha256sum "$archive"');
    expect(restoreDrill).toContain('[[ "$verified_archive_sha256" != "$archive_sha256" ]]');
    expect(restoreDrill).toContain("printf '%s %s %s\\n' \"$drill_stamp\" \"$(basename \"$archive\")\" \"$archive_sha256\"");
    expect(restoreDrill).toContain("compose config --images | grep '^pgvector/pgvector:'");
    expect(restoreDrill).toContain('^pgvector/pgvector:[^@[:space:]]+@sha256:[[:xdigit:]]{64}$');
    expect(restoreDrill).toContain('--network none --read-only --pids-limit 32');
    expect(restoreDrill).toContain('--cap-drop ALL --security-opt no-new-privileges:true');
    expect(restoreDrill).toContain('chown "$restore_db_owner" "$RESTORE_ROOT/app/postgres"');
    expect(restoreDrill).toContain('chown 1000:1000 "$RESTORE_ROOT/cloud/storage"');
    expect(restoreDrill).toContain('DOCKER_HOST_GATEWAY_IP=127.0.0.1');
    expect(restoreDrill.indexOf('chown "$restore_db_owner"')).toBeLessThan(restoreDrill.indexOf('compose up -d --wait db'));
    expect(preflight).toContain('RCLONE_REMOTE is empty in the protected backup environment');
    expect(preflight).toContain('backup_storage_policy=offsite');
    expect(preflight).toContain('BACKUP_STORAGE_POLICY must be exactly offsite or local');
    expect(preflight).toContain('backup storage policy is local-only; host or disk loss can destroy both production data and its backup');
    expect(preflight).toContain('if [[ "$backup_storage_policy" == offsite ]]; then');
    expect(preflight).toContain('any stale offsite marker is ignored');
    expect(preflight).toContain('latest encrypted backup has no matching off-server verification');
    expect(preflight).toContain('latest encrypted backup has no matching isolated restore drill');
    expect(preflight).toContain('latest_sha256=$(sha256sum "$latest"');
    expect(preflight).toContain('"$success_sha256" == "$latest_sha256"');
    expect(preflight).toContain('"$offsite_sha256" == "$latest_sha256"');
    expect(preflight).toContain('"$drill_sha256" == "$latest_sha256"');
    expect(preflight).toContain("grep -q 'AGE-SECRET-KEY-'");
    expect(preflight).toContain('an age private identity is stored on the production server');
    expect(preflight).toContain('PREFLIGHT_PHASE=${PREFLIGHT_PHASE:-predeploy}');
    expect(preflight).toContain('for service in db rest api worker agno onlyoffice web livekit coturn');
    expect(preflight).toContain('elif [[ "$PREFLIGHT_PHASE" == postdeploy ]]');
    expect(preflight).toContain('fail "crawl4ai is not running"');
    expect(preflight).toContain('fail "crawl4ai-gateway is not running"');
    expect(preflight).toContain('stock bridge is empty for the isolated scraper rollout');
    expect(preflight).toContain('stock bridge must be empty before deploying the isolated scraper');
    expect(preflight).toContain('stock bridge membership could not be inspected');
    expect(preflight).toContain("| awk 'NF' | sort");
    expect(preflight).toContain('candidate scraper topology and authenticated runtime checks are deferred to PREFLIGHT_PHASE=postdeploy');
    expect(preflight).toMatch(/if \[\[ "\$PREFLIGHT_PHASE" == predeploy \]\]; then[\s\S]*elif \[\[ -n "\$crawl4ai_container"/);
    expect(preflight).toContain('Crawl4AI cannot resolve or directly reach private application services');
    expect(preflight).toContain('cannot resolve or directly reach the raw Crawl4AI backend');
    expect(preflight).toContain('only the authenticated gateway is published on');
    expect(preflight).toContain('the published scraper endpoint exposes the fixed-route gateway, not raw Crawl4AI');
    expect(preflight).toContain('"$crawler_network_mode" == bridge');
    expect(preflight).toContain('"$gateway_network_mode" == "container:$crawler_id"');
    expect(preflight).toContain('scraper_peers=(db rest api worker agno onlyoffice web)');
    expect(preflight).toContain('"$gateway_network_count" == 0');
    expect(preflight).toContain('bridge_crawler_endpoint');
    expect(preflight).toContain('${#bridge_container_ids[@]} == 1');
    expect(preflight).toContain("'{{range $id, $_ := .Containers}}{{println $id}}{{end}}'");
    expect(preflight).toContain('expected_crawler_binding="8080/tcp|$bridge_gateway|11235"');
    expect(preflight).toContain('worker reaches authenticated Crawl4AI schema through the gateway');
    expect(preflight).toContain('api reaches authenticated Crawl4AI browser scrape through the gateway');
    expect(preflight).toContain('socket.getaddrinfo(name, None)');
    expect(preflight).toContain('container_ips "${app_containers[$peer_name]}"');
    expect(preflight).toContain('os.environ["PRIVATE_TARGETS"].split(",")');
    expect(preflight).toContain('.HostConfig.PortBindings');
    expect(preflight).toContain("127.*|::1|'[::1]'");
    expect(preflight).toContain('has non-loopback host mapping');
    expect(preflight).toContain('for service in db rest api worker agno onlyoffice web');
    expect(preflight).not.toContain('private_containers[crawl4ai]=$crawl4ai_container');
    expect(preflight).toContain('private_containers[crawl4ai-gateway]=$crawl4ai_gateway_container');
    expect(preflight).not.toContain('private_containers[coturn]');
    expect(preflight).not.toContain('private_containers[livekit]');
    expect(preflight).not.toContain('ss -ltn');
    expect(preflight).toContain('node tools/browser-scraper-smoke.mjs');
    expect(backup).toContain('Set APP_COMPOSE_PROJECT to the exact app Compose project or set DB_CONTAINER explicitly.');
    expect(backup).toContain('label=com.docker.compose.project=$APP_COMPOSE_PROJECT');
    expect(backup).toContain('com.docker.compose.service');
    expect(backup).toContain('eq .Destination "/var/lib/postgresql/data"');
    expect(backup).toContain('actual_db_data');
    expect(backup).toContain("label=com.docker.compose.service=api");
    expect(backup).toContain("label=com.docker.compose.service=worker");
    expect(backup).toContain('Expected exactly one running api container');
    expect(backup).toContain('Expected exactly one running worker container');
    expect(backup).toContain('api_command" == *main.mjs*');
    expect(backup).toContain('worker_command" == *worker-main.mjs*');
    expect(backup).toContain('docker pause "$API_CONTAINER"');
    expect(backup).toContain('docker pause "$WORKER_CONTAINER"');
    expect(backup).toContain('step="draining in-flight database writes"');
    expect(backup).toContain("state IS DISTINCT FROM 'idle'");
    expect(backup).toContain('Database clients did not become idle');
    expect(backup).toContain('resume_app_writes');
    expect(backup.indexOf('step="resuming application writes"')).toBeLessThan(backup.indexOf('step="encrypting"'));
    expect(backup).toContain('tar -C "$STORAGE_DIR" -cf "$work/storage.tar" .');
    expect(backup).not.toContain('tar -C "$STORAGE_DIR" -cf "$work/storage.tar" . ||');
    expect(preflight).toContain('set APP_COMPOSE_PROJECT to the exact app Compose project or set DB_CONTAINER explicitly');
    expect(preflight).toContain('database target verified: Compose project');
    expect(preflight).toContain('expected writable database bind');
    expect(restoreDrill).toContain('realpath -m -- "$requested_restore_root"');
    expect(restoreDrill).toContain('[[ "$dedicated_restore_root" == "$dedicated_restore_path" ]]');
    expect(restoreDrill).toContain('[[ "$RESTORE_ROOT" == "$dedicated_restore_root" ]]');
    expect(restoreDrill).toContain('[[ "$delete_root" == "$dedicated_restore_root" && ! -L "$RESTORE_ROOT" ]]');
    expect(restoreDrill).not.toContain('*restore-test*');
    expect(restoreDrill).toContain('compose up -d --wait --no-deps rest agno');
    expect(restoreDrill).toContain('compose up -d --wait --no-deps worker');
    expect(restoreDrill).toContain('compose up -d --wait --no-deps api');
    expect(restoreDrill).toContain('compose up -d --wait --no-deps web');
    expect(restoreDrill).toContain('for _ in {1..30}');
    expect(restoreDrill).toContain('db_password_file="$RESTORE_ROOT/.db-password"');
    expect(restoreDrill).toContain('chmod 600 "$db_password_file"');
    expect(restoreDrill).toContain('docker exec -e PGPASSWORD "$db_name" psql');
    expect(restoreDrill).toContain('PGPASSWORD_FILE="$db_password_file"');
    expect(restoreDrill).toContain('TRUNCATE public.worker_heartbeats');
    expect(restoreDrill).toContain('trap cleanup_restore_secret EXIT');
    expect(restoreDrill.indexOf('cleanup_restore_secret\n')).toBeLessThan(restoreDrill.indexOf('code=000'));
    expect(restoreDrill).not.toContain('echo "$PGPASSWORD"');

    const restoreOverride = read('deploy/backup/restore-test.override.yml');
    expect(restoreOverride).toMatch(/api:[\s\S]*?depends_on: !override[\s\S]*?rest:/);
    expect(restoreOverride).toMatch(/api:[\s\S]*?depends_on: !override[\s\S]*?agno:/);
    expect(restoreOverride).toMatch(/worker:[\s\S]*?depends_on: !override[\s\S]*?rest:[\s\S]*?agno:/);
    expect(restoreOverride).toMatch(/agno:[\s\S]*?source: \$\{RESTORE_ROOT:\?RESTORE_ROOT\}\/cloud\/storage/);
    expect(restoreOverride).toMatch(/web:[\s\S]*?depends_on: !override[\s\S]*?api:/);
    expect(restoreOverride).toMatch(/livekit:[\s\S]*?profiles: \["media-restore-test"\][\s\S]*?ports: !override \[\]/);
    expect(restoreOverride).toMatch(/coturn:[\s\S]*?profiles: \["media-restore-test"\][\s\S]*?ports: !override \[\]/);
    expect(restoreOverride).toMatch(/networks:[\s\S]*?default:[\s\S]*?internal: true/);
    expect(restoreOverride).toContain('- "127.0.0.1:18000:8080"');
    expect(restoreOverride).toContain('networks: !override\n      - default\n      - restore-loopback');
    expect(restoreOverride.match(/- restore-loopback/g)).toHaveLength(1);
    expect(restoreOverride).toContain('restore-loopback:\n    driver: bridge');
    expect(restoreOverride).toContain('default:\n    internal: true');
  });

  it('contains no external auth or managed backend service', () => {
    expect(compose).not.toMatch(/gotrue|studio|realtime|storage-api|supabase\//i);
  });

  it('allows configured web fonts and only the exact ONLYOFFICE compatibility handler', () => {
    const headers = read('deploy/nginx/security-headers.conf');
    expect(headers).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(headers).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(headers).toContain("script-src 'self' 'unsafe-hashes' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(headers).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe('migrations', () => {
  const files = readdirSync(path.join(root, 'database/migrations')).filter((file) => file.endsWith('.sql')).sort();
  it('serializes concurrent deployers and rechecks after taking the database lock', () => {
    const runner = read('database/migrate.sh');
    expect(runner).toContain("pg_advisory_xact_lock(hashtextextended('dromanian-space:migrations', 0))");
    expect(runner).toContain('MIGRATION_LOCK_TIMEOUT_SECONDS=${MIGRATION_LOCK_TIMEOUT_SECONDS:-60}');
    expect(runner).toContain("SET LOCAL statement_timeout = '%ss';");
    expect(runner.indexOf("AS database_initialized \\\\gset")).toBeGreaterThan(runner.indexOf('emit_migration_lock'));
    expect(runner).toContain('CREATE TABLE IF NOT EXISTS app_migrations.schema_migrations');
    expect(runner).toContain('AS migration_applied \\\\gset');
    expect(runner).toContain('\\if :migration_applied');
  });
  it('have unique, ordered 14-digit versions', () => {
    const versions = files.map((file) => file.split('_')[0]);
    for (const version of versions) expect(version).toMatch(/^\d{14}$/);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it('are transaction-safe for the runner', () => {
    for (const file of files) {
      const sql = read(`database/migrations/${file}`);
      expect(sql, file).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
      expect(sql, file).not.toMatch(/\bCONCURRENTLY\b/i);
    }
  });
});

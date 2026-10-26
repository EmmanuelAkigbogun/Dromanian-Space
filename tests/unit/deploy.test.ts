import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

describe('standalone compose safety', () => {
  const compose = read('docker-compose.yml');

  it('keeps PostgreSQL and storage on the dedicated server disks', () => {
    expect(compose).toContain('source: /srv/app-data/dromanian-space/postgres');
    expect(compose).toContain('source: /srv/cloud-data/dromanian-space/storage');
    expect(compose.match(/create_host_path: false/g)?.length).toBeGreaterThanOrEqual(3);
    expect(compose).toMatch(/db:[\s\S]*?mount-guard:\s*\n\s*condition: service_completed_successfully/);
  });

  it('publishes only the loopback web port', () => {
    expect(compose).toContain('127.0.0.1:${WEB_HOST_PORT:-3008}:8080');
    expect(compose).not.toMatch(/-\s*['"]?\d+:5432/);
    expect(compose).not.toMatch(/-\s*['"]?\d+:3000/);
  });

  it('keeps database credentials out of the browser build', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).not.toMatch(/VITE_(DATABASE|JWT|POSTGRES)/);
    expect(compose).toContain('APP_JWT_SECRET: ${APP_JWT_SECRET:?APP_JWT_SECRET}');
  });

  it('ships one system Chromium without downloading Puppeteer browsers', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('PUPPETEER_SKIP_DOWNLOAD=true');
    expect(dockerfile).toContain('PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium');
    expect(dockerfile).toMatch(/apt-get install[^\n]*chromium/);
  });

  it('runs the agent orchestrator as an isolated, pinned CrewAI service', () => {
    const dockerfile = read('Dockerfile');
    const project = read('crew/pyproject.toml');
    expect(compose).toMatch(/crew:\s*[\s\S]*?target: crew/);
    expect(compose).toContain('CREWAI_URL: http://crew:8000');
    expect(compose).toContain('CREW_TOOL_CALLBACK_URL: http://worker:3001/tool');
    expect(dockerfile).toContain('ghcr.io/astral-sh/uv:0.13.5');
    expect(dockerfile).toContain('uv sync --locked');
    expect(project).toContain('crewai[anthropic,google-genai]==1.15.28');
    expect(read('crew/uv.lock')).toContain('name = "crewai"');
  });

  it('contains no external auth or managed backend service', () => {
    expect(compose).not.toMatch(/gotrue|studio|realtime|storage-api|supabase\//i);
  });
});

describe('migrations', () => {
  const files = readdirSync(path.join(root, 'database/migrations')).filter((file) => file.endsWith('.sql')).sort();
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

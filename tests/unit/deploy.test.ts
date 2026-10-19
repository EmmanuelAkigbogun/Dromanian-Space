// Deployment assets that must not drift silently: vendored upstream Supabase
// files, the Edge Function copy used by the self-hosted stack, the migration
// order, and the safety properties of the compose files.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel));

describe('vendored Supabase files', () => {
  const manifest = read('deploy/supabase/UPSTREAM.md').toString();
  const entries = [...manifest.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)].map((m) => ({ hash: m[1], file: m[2] }));

  it('lists the vendored files', () => {
    expect(entries.length).toBeGreaterThanOrEqual(17);
  });
  it.each(entries)('$file is unchanged from upstream', ({ hash, file }) => {
    // Line endings are normalized to LF in the repository (.gitattributes).
    const content = read(`deploy/supabase/${file}`).toString().replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(content).digest('hex')).toBe(hash);
  });
  it('ships the same link-preview function as supabase/functions', () => {
    // Compared without line endings: checkouts may differ by platform.
    const text = (rel: string) => read(rel).toString().replace(/\r\n/g, '\n');
    expect(text('deploy/supabase/volumes/functions/fetch-link-preview/index.ts')).toBe(text('supabase/functions/fetch-link-preview/index.ts'));
  });
});

describe('compose safety', () => {
  const supabase = read('deploy/supabase/docker-compose.yml').toString();
  const app = read('docker-compose.yml').toString();

  it('keeps database data on the dedicated disk and fails closed', () => {
    expect(supabase).toContain('source: /srv/app-data/dromanian-space/supabase/db/data');
    expect(supabase).toContain('source: /srv/cloud-data/dromanian-space/storage');
    expect(supabase.match(/create_host_path: false/g)?.length).toBeGreaterThanOrEqual(4);
    expect(supabase).toMatch(/db:[\s\S]*?mount-guard:\s*\n\s*condition: service_completed_successfully/);
    expect(supabase).not.toMatch(/\.\/volumes\/db\/data/);
    expect(supabase).not.toMatch(/\.\/volumes\/storage/);
  });

  it('does not report Postgres healthy before first-run initialization completes', () => {
    expect(supabase).toContain("to_regnamespace('_realtime') IS NOT NULL");
    expect(supabase).toContain("datname = '_supabase'");
    expect(supabase).toContain("rolname = 'authenticator' AND rolpassword IS NOT NULL");
  });

  it('bakes versioned Supabase files into images instead of Coolify-relative mounts', () => {
    expect(supabase).not.toMatch(/^\s+- \.\/volumes\//m);
    for (const target of ['studio', 'api-gw', 'functions', 'db', 'supavisor']) {
      expect(supabase).toContain(`target: ${target}`);
    }
  });

  it('recognizes the layered database image in operational scripts', () => {
    for (const file of ['deploy/migrate.sh', 'deploy/preflight.sh', 'deploy/backup/backup.sh']) {
      expect(read(file).toString()).toContain('dromanian-supabase-db:');
    }
  });
  it('publishes no database or pooler ports and only a loopback gateway port', () => {
    const ports = [...supabase.matchAll(/^\s+- "?([^"\n]*:\d+(?::\d+)?)"?\s*$/gm)].map((m) => m[1]).filter((p) => /^\S*:\$?\{?[A-Z_:-]*\d*\}?:\d+$|^\d/.test(p));
    for (const p of ports) expect(p.startsWith('127.0.0.1:')).toBe(true);
    expect(supabase).not.toMatch(/\$\{POSTGRES_PORT\}:5432/);
    expect(supabase).not.toMatch(/POOLER_PROXY_PORT_TRANSACTION\}:6543/);
  });
  it('routes only the browser APIs publicly', () => {
    const rule = /routers\.dromanian-supabase\.rule=(.*)$/m.exec(supabase)?.[1] ?? '';
    for (const p of ['/auth/v1', '/rest/v1', '/realtime/v1', '/storage/v1', '/functions/v1']) expect(rule).toContain(`PathPrefix(\`${p}\`)`);
    expect(rule).not.toContain('PathPrefix(`/`)');
    expect(rule).not.toMatch(/analytics|pg|project/);
  });
  it('keeps email confirmation on by default and requires SMTP', () => {
    expect(supabase).toContain('GOTRUE_MAILER_AUTOCONFIRM: ${ENABLE_EMAIL_AUTOCONFIRM:-false}');
    expect(supabase).toContain('GOTRUE_SMTP_HOST: ${SMTP_HOST:?SMTP_HOST}');
  });
  it('never passes server secrets to the browser build', () => {
    const build = /web:[\s\S]*?args:([\s\S]*?)environment:/.exec(app)?.[1] ?? '';
    expect(build).not.toMatch(/SECRET|ANTHROPIC|OPENAI|SERVICE_ROLE|VOYAGE/);
    expect(app).toMatch(/OPENAI_API_KEY: \$\{OPENAI_API_KEY:-\}/);
  });
});

describe('migrations', () => {
  const files = readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  it('have unique, ordered 14-digit versions', () => {
    const versions = files.map((f) => f.split('_')[0]);
    for (const v of versions) expect(v).toMatch(/^\d{14}$/);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it('never manage their own transactions (the runner wraps each file)', () => {
    for (const f of files) {
      const sql = read(`supabase/migrations/${f}`).toString();
      expect(sql, f).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
      expect(sql, f).not.toMatch(/\bCONCURRENTLY\b/i);
    }
  });
  it('new migrations are additive (no DROP TABLE or TRUNCATE)', () => {
    for (const f of files.filter((x) => x >= '20261019')) {
      const sql = read(`supabase/migrations/${f}`).toString();
      expect(sql, f).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|COLUMN)\b/i);
      expect(sql, f).not.toMatch(/\bTRUNCATE\b/i);
      expect(sql, f).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });
});

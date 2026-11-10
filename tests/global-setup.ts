import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { ENV_FILE, REPO_ROOT } from '../tools/local-database/lib.ts';

/**
 * Starts (or reuses) the local PostgreSQL test stack and applies every migration.
 * Safe to run repeatedly; it never touches a hosted project.
 */
export default function setup(): void {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'tools', 'local-database', 'cli.ts'), 'start'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Local database failed to start:\n${result.stderr || result.stdout}`);
  }
  // Vitest workers import server/database.ts before per-file beforeAll hooks.
  // Load the freshly generated local endpoints and signing secret here so the
  // server modules capture the safe local configuration, never hosted values.
  loadEnvFile(ENV_FILE);
}

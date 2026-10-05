import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../tools/local-supabase/lib.ts';

/**
 * Starts (or reuses) the local Supabase emulation and applies every migration.
 * Safe to run repeatedly; it never touches a hosted project.
 */
export default function setup(): void {
  const result = spawnSync(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    [path.join(REPO_ROOT, 'tools', 'local-supabase', 'cli.ts'), 'start'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Local Supabase failed to start:\n${result.stderr || result.stdout}`);
  }
}

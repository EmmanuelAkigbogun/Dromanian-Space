/**
 * Self-hosting operations: one authoritative scheduler per maintenance task,
 * worker heartbeats and the readiness summary.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnvFile } from 'node:process';
import { ENV_FILE } from '../../tools/local-supabase/lib.ts';
import { admin, asService, createUser, expectDenied, pool, q } from '../helpers/db.ts';
import { GET as readyEndpoint } from '../../api/ready.js';

const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asService(async (c) => (await c.query(sql, params)).rows as T[]);

afterAll(async () => {
  await admin(`UPDATE cron.job SET active = false WHERE jobname = 'send-due-scheduled-messages'`);
  await pool.end();
});

describe('maintenance scheduling', () => {
  it('leaves a task to pg_cron when its job is active and runs it in the worker otherwise', async () => {
    await admin(`UPDATE cron.job SET active = false WHERE jobname = 'send-due-scheduled-messages'`);
    const byWorker = (await svc<{ r: Record<string, string> }>('SELECT run_unscheduled_maintenance() AS r'))[0].r;
    expect(byWorker.scheduled_messages).not.toBe('pg_cron');
    expect(byWorker.scheduled_messages).toMatch(/^\d+$/);

    await admin(`INSERT INTO cron.job (jobname, schedule, command, active) VALUES ('send-due-scheduled-messages', '* * * * *', 'x', true)
                 ON CONFLICT (jobname) DO UPDATE SET active = true`);
    const byCron = (await svc<{ r: Record<string, string> }>('SELECT run_unscheduled_maintenance() AS r'))[0].r;
    expect(byCron.scheduled_messages).toBe('pg_cron');
    const readiness = (await svc<{ r: { scheduler: Record<string, string> } }>('SELECT system_readiness() AS r'))[0].r;
    expect(readiness.scheduler.scheduled_messages).toBe('pg_cron');
  });

  it('is not callable by signed-in users', async () => {
    const user = await createUser('ops-user');
    await expectDenied(q(user, 'SELECT run_unscheduled_maintenance()'), /permission/);
    await expectDenied(q(user, 'SELECT system_readiness()'), /permission/);
    await expectDenied(q(user, 'SELECT * FROM worker_heartbeats'), /permission/);
  });
});

describe('worker heartbeats and readiness', () => {
  it('reports fresh workers with their job progress and removes stopped ones', async () => {
    await svc(`SELECT worker_heartbeat('ops-test-worker', 2, 10, 1, now())`);
    const r = (await svc<{ r: { fresh_workers: number; workers: Array<{ worker: string; jobs_completed: number; jobs_running: number }> } }>(
      'SELECT system_readiness() AS r'))[0].r;
    expect(r.fresh_workers).toBeGreaterThanOrEqual(1);
    expect(r.workers.find((w) => w.worker === 'ops-test-worker')).toMatchObject({ jobs_completed: 10, jobs_running: 2 });

    loadEnvFile(ENV_FILE);
    const response = await readyEndpoint();
    const body = await response.json() as { checks: Record<string, string> };
    expect(body.checks.database).toBe('ok');
    expect(body.checks.worker).toBe('ok');

    await svc(`SELECT worker_stopped('ops-test-worker')`);
    const after = (await svc<{ r: { workers: Array<{ worker: string }> } }>('SELECT system_readiness() AS r'))[0].r;
    expect(after.workers.find((w) => w.worker === 'ops-test-worker')).toBeUndefined();
  });
});

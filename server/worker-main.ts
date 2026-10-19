// Entry point of the worker container.
import { log } from './log.js';
import { enforceEnv, reportPlatform, waitForDatabase } from './startup.js';
import { startWorker } from './worker.js';

enforceEnv('worker');

void (async () => {
  // The loop itself survives database outages; waiting first keeps the logs
  // readable while PostgreSQL is still starting after a host reboot.
  await waitForDatabase();
  await reportPlatform();
  const worker = startWorker();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('worker shutting down', { signal });
      void worker.stop().then(() => process.exit(0));
    });
  }
})();

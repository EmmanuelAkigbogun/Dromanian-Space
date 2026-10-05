// Entry point of the worker container.
import { startWorker } from './worker.js';

const worker = startWorker();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void worker.stop().then(() => process.exit(0));
  });
}

// Local preview: Vite, the API adapter and the worker in one process, against
// the local Supabase emulator (npm run supabase:local -- start).
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { handleApi } from '../server/node-http.js';
import { startWorker } from '../server/worker.js';

createServer((req, res) => void handleApi(req, res)).listen(5174, '127.0.0.1');
const worker = startWorker({ concurrency: 2, aliveFile: null });
const vite = await createViteServer({ server: { host: '127.0.0.1' } });
await vite.listen();
vite.printUrls();
console.log('Local API: http://127.0.0.1:5174 · worker running');
process.once('SIGINT', () => void worker.stop(2000).then(() => process.exit(0)));

// Entry point of the API container. Static files are served by the web
// container (Caddy), which forwards /api/* here.
import { createServer } from 'node:http';
import { handleApi } from './node-http.js';
import { log } from './log.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    void handleApi(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }));
});
server.requestTimeout = 0; // streamed agent responses can last several minutes
server.listen(port, host, () => log.info('api listening', { host, port }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('api shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

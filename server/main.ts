// Entry point of the API container. Static files are served by the web
// container (Nginx), which forwards /api/* here.
import { createServer } from 'node:http';
import { handleApi } from './node-http.js';
import { log } from './log.js';
import { enforceEnv, reloadDatabaseApiSchema, reportPlatform, waitForDatabase } from './startup.js';

enforceEnv('api');

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

// PostgREST starts after migrations, but explicitly refresh its cache before
// accepting browser traffic so freshly added columns/RPCs are immediately usable.
await reloadDatabaseApiSchema().catch((error) =>
  log.warn('could not reload database API schema', { error: error instanceof Error ? error : String(error) }),
);

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    void handleApi(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }));
});
// Streamed agent responses can last several minutes, so there is no overall
// request timeout; slow or idle clients are still cut off while sending headers.
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;
server.listen(port, host, () => log.info('api listening', { host, port }));

// Liveness does not wait for the database (/api/ready reports it); the
// provider state is recorded once the database answers.
void waitForDatabase().then((ok) => (ok ? reportPlatform() : undefined));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('api shutting down', { signal });
    server.close(() => process.exit(0));
    // Open event streams end here; viewers reattach to the persisted run.
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 10_000).unref();
  });
}

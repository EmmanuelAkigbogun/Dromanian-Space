// The HTTP API surface, shared by the production server and the local adapter.
import * as health from '../api/health.js';
import * as ready from '../api/ready.js';
import * as status from '../api/ai/status.js';
import * as run from '../api/agents/run.js';
import * as mention from '../api/agents/mention.js';
import * as jobs from '../api/jobs/run.js';

export type Handler = (request: Request) => Promise<Response>;

export const ROUTES: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
  '/api/health': health,
  '/api/ready': ready,
  '/api/ai/status': status,
  '/api/agents/run': run,
  '/api/agents/mention': mention,
  '/api/jobs/run': jobs,
};

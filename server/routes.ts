// The HTTP API surface, shared by the production server and the local adapter.
import * as health from '../api/health.js';
import * as ready from '../api/ready.js';
import * as status from '../api/ai/status.js';
import * as run from '../api/agents/run.js';
import * as mention from '../api/agents/mention.js';
import * as jobs from '../api/jobs/run.js';
import * as n8n from '../api/integrations/n8n.js';
import * as auth from '../api/auth.js';
import * as events from '../api/events.js';

export type Handler = (request: Request) => Promise<Response>;
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD';

export const ROUTES: Record<string, Partial<Record<ApiMethod, Handler>>> = {
  '/api/health': health,
  '/api/ready': ready,
  '/api/ai/status': status,
  '/api/agents/run': run,
  '/api/agents/mention': mention,
  '/api/jobs/run': jobs,
  '/api/integrations/n8n/runs': n8n,
  '/api/auth/signup': { POST: auth.signup },
  '/api/auth/signin': { POST: auth.signin },
  '/api/auth/session': { GET: auth.session },
  '/api/auth/signout': { POST: auth.signout },
  '/api/auth/user': { POST: auth.updateUser },
  '/api/auth/forgot-password': { POST: auth.forgotPassword },
  '/api/auth/recover': { POST: auth.recover },
  '/api/events': { GET: events.stream },
  '/api/events/broadcast': { POST: events.broadcast },
  '/api/events/presence': { POST: events.presence },
};

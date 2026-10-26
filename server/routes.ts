// The HTTP API surface, shared by the production server and the local adapter.
import * as health from '../api/health.js';
import * as ready from '../api/ready.js';
import * as status from '../api/ai/status.js';
import * as providerKeys from '../api/ai/provider-keys.js';
import * as run from '../api/agents/run.js';
import * as mention from '../api/agents/mention.js';
import * as sessions from '../api/agents/sessions.js';
import * as push from '../api/push.js';
import * as drive from '../api/drive.js';
import * as office from '../api/office.js';
import * as jobs from '../api/jobs/run.js';
import * as n8n from '../api/integrations/n8n.js';
import * as auth from '../api/auth.js';
import * as events from '../api/events.js';
import * as calls from '../api/calls.js';

export type Handler = (request: Request) => Promise<Response>;
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD';

export const ROUTES: Record<string, Partial<Record<ApiMethod, Handler>>> = {
  '/api/health': health,
  '/api/ready': ready,
  '/api/ai/status': status,
  '/api/ai/provider-keys': providerKeys,
  '/api/agents/run': run,
  '/api/agents/mention': mention,
  '/api/agents/sessions': sessions,
  '/api/push': push,
  '/api/drive/unzip': { POST: drive.unzip },
  '/api/drive/new-office': { POST: drive.newOfficeFile },
  '/api/office/status': { GET: office.status },
  '/api/office/config': { POST: office.config },
  '/api/office/file': { GET: office.file },
  '/api/office/callback': { POST: office.callback },
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
  '/api/calls': { POST: calls.create },
  '/api/calls/active': { GET: calls.active },
  '/api/calls/ice': { GET: calls.ice },
};

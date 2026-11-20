// GitHub's browser redirects back to Darkspace. They carry no Darkspace
// session, so the signed `state` names the person and the address to return to.
//   GET /api/github/app-created  manifest flow finished: save the app, then install it
//   GET /api/github/callback     sign-in (and install) finished: save the account
import { appConfig, installUrl, readState, saveAccountFromCode, saveCreatedApp, signState } from '../server/github-accounts.js';
import { HttpError } from '../server/http.js';
import { log } from '../server/log.js';

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
const accountsPage = (origin: string, query: string) => `${origin}/settings?tab=accounts&${query}`;

function failure(origin: string | null, err: unknown) {
  const message = err instanceof HttpError ? err.message : 'GitHub sign-in did not complete. Try again.';
  if (!(err instanceof HttpError)) log.warn('github redirect failed', { error: err instanceof Error ? err : String(err) });
  if (!origin) return new Response(message, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return redirect(accountsPage(origin, `github_error=${encodeURIComponent(message)}`));
}

export async function appCreated(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let origin: string | null = null;
  try {
    const state = readState(url.searchParams.get('state'));
    origin = state.o;
    if (state.k !== 'app') throw new HttpError(400, 'bad_state', 'This GitHub link is not valid.');
    const code = url.searchParams.get('code');
    if (!code) throw new HttpError(400, 'github_app_failed', 'GitHub did not return the new app.');
    const app = await saveCreatedApp(code, state.u, state.o);
    // Straight on to installing it, which also signs the admin in.
    return redirect(installUrl(app, signState({ k: 'connect', u: state.u, o: state.o })));
  } catch (err) {
    return failure(origin, err);
  }
}

export async function callback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let origin: string | null = null;
  try {
    const state = readState(url.searchParams.get('state'));
    origin = state.o;
    if (state.k !== 'connect') throw new HttpError(400, 'bad_state', 'This GitHub link is not valid.');
    const app = await appConfig();
    if (!app) throw new HttpError(400, 'github_app_missing', 'GitHub sign-in is not set up on this server.');
    const code = url.searchParams.get('code');
    if (!code) return redirect(accountsPage(state.o, 'github=updated'));
    const saved = await saveAccountFromCode(app, state.u, code);
    // Signed in but the app is on no account yet: choose repositories next.
    if (!saved.installations) return redirect(installUrl(app, signState({ k: 'connect', u: state.u, o: state.o })));
    return redirect(accountsPage(state.o, `github=connected&login=${encodeURIComponent(saved.login)}`));
  } catch (err) {
    return failure(origin, err);
  }
}

// Social accounts: logging in through a remote browser, or with pasted cookies.
//   GET  /api/social/status         whether this server can run a browser
//   POST /api/social/login/start    open a login window for an account (admins)
//   GET  /api/social/login/frame    the window's current picture (JPEG)
//   POST /api/social/login/input    a click, typing, a key or scrolling
//   POST /api/social/login/finish   save the signed-in session and close
//   POST /api/social/login/cancel   close without saving
//   POST /api/social/cookies        save cookies exported from a browser
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { authenticate } from '../server/database.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';
import { browserPath, cancelLogin, finishLogin, loginFrame, loginInput, saveCookies, startLogin } from '../server/social.js';

const id = z.string().uuid();

export async function status(request: Request): Promise<Response> {
  try {
    await authenticate(request);
    const path = browserPath();
    return json({ browser: path ? existsSync(path) : true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function start(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const { account_id } = await readJson(request, z.object({ account_id: id }));
    return json(await startLogin(user.id, account_id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function frame(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const parsed = id.safeParse(new URL(request.url).searchParams.get('id'));
    if (!parsed.success) throw new HttpError(400, 'invalid', 'Missing login id.');
    const image = await loginFrame(user.id, parsed.data);
    return new Response(image as unknown as BodyInit, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}

const inputSchema = z.object({
  id,
  input: z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), x: z.number(), y: z.number() }),
    z.object({ type: z.literal('type'), text: z.string().max(500) }),
    z.object({ type: z.literal('key'), key: z.string().max(20) }),
    z.object({ type: z.literal('scroll'), dy: z.number() }),
    z.object({ type: z.literal('back') }),
  ]),
});

export async function input(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, inputSchema);
    await loginInput(user.id, body.id, body.input);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function finish(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, z.object({ id }));
    return json(await finishLogin(user.id, body.id));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function cancel(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, z.object({ id }));
    await cancelLogin(user.id, body.id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function cookies(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, z.object({ account_id: id, cookies: z.unknown() }), 512 * 1024);
    await saveCookies(user.id, body.account_id, body.cookies);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

// /api/push — Web Push for this browser. GET returns whether push is set up
// and the VAPID public key; POST saves the browser's subscription for the
// signed-in person; DELETE removes it (on sign-out or when turned off).
import { z } from 'zod';
import { authenticate, databasePool } from '../server/database.js';
import { env } from '../server/env.js';
import { errorResponse, HttpError, json, readJson } from '../server/http.js';
import { isPushEndpoint } from '../server/push.js';

const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);
const Subscription = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: base64url.min(40).max(200), auth: base64url.min(10).max(100) }),
});
const Unsubscribe = z.object({ endpoint: z.string().url().max(2048) });

export async function GET(request: Request): Promise<Response> {
  try {
    await authenticate(request);
    const config = env().webPush;
    return json({ enabled: Boolean(config), public_key: config?.publicKey ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    if (!env().webPush) throw new HttpError(503, 'not_configured', 'Push notifications are not set up on this server.');
    const body = await readJson(request, Subscription);
    if (!isPushEndpoint(body.endpoint)) throw new HttpError(400, 'invalid_endpoint', 'This browser’s push service is not supported.');
    // A browser profile has one endpoint; whoever signs in on it now owns it.
    await databasePool().query(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, failures = 0`,
      [user.id, body.endpoint, body.keys.p256dh, body.keys.auth, request.headers.get('user-agent')?.slice(0, 500) ?? null],
    );
    return json({ status: 'subscribed' }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const user = await authenticate(request);
    const body = await readJson(request, Unsubscribe);
    await databasePool().query('DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2::uuid', [body.endpoint, user.id]);
    return json({ status: 'unsubscribed' });
  } catch (err) {
    return errorResponse(err);
  }
}

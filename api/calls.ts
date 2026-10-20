import { createHmac, randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { z } from 'zod';
import { authenticate, databasePool } from '../server/database.js';
import { publishToUsers } from '../server/events.js';
import { HttpError, json, readJson } from '../server/http.js';

const uuid = z.string().uuid();
const createBody = z.object({
  workspaceId: uuid,
  targetUserIds: z.array(uuid).min(1).max(5),
  callType: z.enum(['direct', 'group', 'channel']),
  channelId: uuid.nullish(),
  conversationId: uuid.nullish(),
  withVideo: z.boolean().default(false),
});
const signalBody = z.object({
  toUserId: uuid,
  type: z.enum(['offer', 'answer', 'ice-candidate', 'end-call']),
  payload: z.record(z.string(), z.unknown()).default({}),
  clientMessageId: uuid.optional(),
});

const cloudflareIceResponse = z.object({
  iceServers: z.array(z.object({
    urls: z.union([z.string(), z.array(z.string())]),
    username: z.string().optional(),
    credential: z.string().optional(),
  })),
});

async function managedIceServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !apiToken) return undefined;

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 14_400 }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) {
    throw new HttpError(502, 'turn_credentials_failed', 'Cloudflare could not issue call relay credentials.');
  }
  const parsed = cloudflareIceResponse.safeParse(await response.json());
  if (!parsed.success || parsed.data.iceServers.length === 0) {
    throw new HttpError(502, 'turn_credentials_invalid', 'Cloudflare returned invalid call relay credentials.');
  }
  return parsed.data.iceServers;
}
const participantStateBody = z.object({ isMuted: z.boolean() });

function databaseEvent(table: string, event: 'INSERT' | 'UPDATE', row: unknown) {
  return { kind: 'postgres_changes' as const, table, event, payload: { eventType: event, new: row, old: {}, table, schema: 'public' } };
}

async function participantIds(callId: string): Promise<string[]> {
  const rows = await databasePool().query('SELECT user_id FROM public.call_participants WHERE call_id = $1::uuid', [callId]);
  return rows.rows.map((row) => row.user_id);
}

async function requireParticipant(callId: string, userId: string) {
  const result = await databasePool().query(
    `SELECT cs.* FROM public.call_sessions cs
     JOIN public.call_participants cp ON cp.call_id = cs.id
     WHERE cs.id = $1::uuid AND cp.user_id = $2::uuid`,
    [callId, userId],
  );
  if (!result.rowCount) throw new HttpError(403, 'call_forbidden', 'You are not a participant in this call.');
  return result.rows[0];
}

export async function create(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const body = await readJson(request, createBody);
  const targets = [...new Set(body.targetUserIds)].filter((id) => id !== user.id);
  if (!targets.length || targets.length > 5) throw new HttpError(400, 'invalid_participants', 'Calls require between 2 and 6 participants.');
  const client = await databasePool().connect();
  try {
    await client.query('BEGIN');
    const member = await client.query(
      'SELECT 1 FROM public.workspace_members WHERE workspace_id = $1::uuid AND user_id = $2::uuid',
      [body.workspaceId, user.id],
    );
    if (!member.rowCount) throw new HttpError(403, 'workspace_forbidden', 'You are not a member of this workspace.');
    const validTargets = await client.query(
      'SELECT user_id FROM public.workspace_members WHERE workspace_id = $1::uuid AND user_id = ANY($2::uuid[])',
      [body.workspaceId, targets],
    );
    if (validTargets.rowCount !== targets.length) throw new HttpError(400, 'invalid_participants', 'Every participant must belong to the same workspace.');
    if (body.callType === 'channel') {
      if (!body.channelId) throw new HttpError(400, 'channel_required', 'A channel call requires a channel.');
      const channelMembers = await client.query(
        `SELECT user_id FROM public.channel_members
         WHERE channel_id = $1::uuid AND user_id = ANY($2::uuid[])`,
        [body.channelId, [user.id, ...targets]],
      );
      if (channelMembers.rowCount !== targets.length + 1) throw new HttpError(403, 'channel_forbidden', 'Every participant must belong to this channel.');
    }
    const sessionResult = await client.query(
      `INSERT INTO public.call_sessions
        (workspace_id, channel_id, conversation_id, call_type, with_video, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::boolean, 'ringing', $6::uuid)
       RETURNING *`,
      [body.workspaceId, body.channelId ?? null, body.conversationId ?? null, body.callType, body.withVideo, user.id],
    );
    const session = sessionResult.rows[0];
    const participantsResult = await client.query(
      `INSERT INTO public.call_participants (call_id, user_id, status, joined_at)
       SELECT $1::uuid, participant.user_id,
              CASE WHEN participant.user_id = $2::uuid THEN 'connected' ELSE 'ringing' END,
              CASE WHEN participant.user_id = $2::uuid THEN now() ELSE NULL END
       FROM unnest($3::uuid[]) AS participant(user_id)
       RETURNING *`,
      [session.id, user.id, [user.id, ...targets]],
    );
    await client.query('COMMIT');
    for (const participant of participantsResult.rows) {
      publishToUsers([participant.user_id], databaseEvent('call_participants', 'INSERT', participant));
    }
    return json({ session, participants: participantsResult.rows }, 201);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function active(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const url = new URL(request.url);
  const workspaceId = uuid.parse(url.searchParams.get('workspaceId'));
  const rows = await databasePool().query(
    `SELECT cs.* FROM public.call_sessions cs
     JOIN public.call_participants cp ON cp.call_id = cs.id
     WHERE cp.user_id = $1::uuid AND cs.workspace_id = $2::uuid AND cs.status IN ('ringing', 'active')
     ORDER BY cs.created_at DESC`,
    [user.id, workspaceId],
  );
  return json(rows.rows);
}

export async function ice(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const managed = await managedIceServers();
  if (managed) return json({ iceServers: managed, expiresAt: Math.floor(Date.now() / 1000) + 14_400 });

  const host = process.env.TURN_HOST?.trim();
  const secret = process.env.TURN_SHARED_SECRET?.trim();
  if (!host || !secret) throw new HttpError(503, 'turn_not_configured', 'The TURN relay is not configured.');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expires}:${user.id}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return json({ iceServers: [
    { urls: [`stun:${host}:3478`] },
    { urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`], username, credential },
  ], expiresAt: expires });
}

export async function mediaToken(request: Request, callId: string): Promise<Response> {
  const user = await authenticate(request);
  const session = await requireParticipant(callId, user.id);
  if (!['ringing', 'active'].includes(session.status)) {
    throw new HttpError(409, 'call_ended', 'This call is no longer active.');
  }
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  const url = process.env.LIVEKIT_PUBLIC_URL?.trim();
  if (!apiKey || !apiSecret || !url) {
    throw new HttpError(503, 'media_not_configured', 'The self-hosted media server is not configured.');
  }
  const profile = await databasePool().query(
    'SELECT coalesce(display_name, username, email, $2::text) AS name FROM public.profiles WHERE id = $1::uuid',
    [user.id, user.id.slice(0, 8)],
  );
  const token = new AccessToken(apiKey, apiSecret, {
    identity: user.id,
    name: profile.rows[0]?.name ?? user.email ?? user.id.slice(0, 8),
    ttl: '2h',
  });
  token.addGrant({
    roomJoin: true,
    room: `call-${callId}`,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const iceServers = await managedIceServers();
  return json({ token: await token.toJwt(), url, room: `call-${callId}`, iceServers });
}

export async function action(request: Request, callId: string, operation: string): Promise<Response> {
  const user = await authenticate(request);
  const session = await requireParticipant(callId, user.id);
  const terminal = ['ended', 'missed', 'declined', 'cancelled'].includes(session.status);
  if (terminal) return json({ session });
  let status: string;
  if (operation === 'answer') status = 'active';
  else if (operation === 'decline') status = 'declined';
  else if (operation === 'cancel') {
    if (session.created_by !== user.id) throw new HttpError(403, 'call_forbidden', 'Only the caller can cancel this call.');
    status = 'cancelled';
  } else if (operation === 'end') status = 'ended';
  else throw new HttpError(404, 'not_found', 'Call action not found.');

  const client = await databasePool().connect();
  let participantChanges: Record<string, unknown>[] = [];
  try {
    await client.query('BEGIN');
    if (operation === 'answer') {
      const participant = await client.query(
        `UPDATE public.call_participants SET status = 'connected', joined_at = coalesce(joined_at, now())
         WHERE call_id = $1::uuid AND user_id = $2::uuid RETURNING *`, [callId, user.id],
      );
      participantChanges = participant.rows;
    }
    const updated = await client.query(
      `UPDATE public.call_sessions SET status = $2::text,
         started_at = CASE WHEN $2 = 'active' THEN coalesce(started_at, now()) ELSE started_at END,
         answered_at = CASE WHEN $2 = 'active' THEN coalesce(answered_at, now()) ELSE answered_at END,
         ended_at = CASE WHEN $2 IN ('ended','declined','cancelled') THEN now() ELSE ended_at END,
         duration = CASE WHEN $2 = 'ended' AND answered_at IS NOT NULL THEN greatest(0, extract(epoch FROM now() - answered_at)::integer) ELSE duration END
       WHERE id = $1::uuid RETURNING *`,
      [callId, status],
    );
    if (status !== 'active') {
      const participants = await client.query(
        `UPDATE public.call_participants SET
           status = CASE WHEN user_id = $2::uuid AND $3 = 'declined' THEN 'declined' ELSE 'left' END,
           left_at = coalesce(left_at, now())
         WHERE call_id = $1::uuid AND status IN ('invited','ringing','connected') RETURNING *`,
        [callId, user.id, status],
      );
      participantChanges = participants.rows;
      await client.query('DELETE FROM public.call_signaling WHERE call_id = $1::uuid', [callId]);
    }
    await client.query('COMMIT');
    const audience = await participantIds(callId);
    publishToUsers(audience, databaseEvent('call_sessions', 'UPDATE', updated.rows[0]));
    for (const participant of participantChanges) {
      publishToUsers(audience, databaseEvent('call_participants', 'UPDATE', participant));
    }
    return json({ session: updated.rows[0] });
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
}

export async function signals(request: Request, callId: string): Promise<Response> {
  const user = await authenticate(request);
  await requireParticipant(callId, user.id);
  if (request.method === 'GET') {
    const rows = await databasePool().query(
      `SELECT * FROM public.call_signaling
       WHERE call_id = $1::uuid AND to_user_id = $2::uuid AND created_at > now() - interval '1 hour'
       ORDER BY created_at`,
      [callId, user.id],
    );
    return json(rows.rows);
  }
  const body = await readJson(request, signalBody);
  const recipient = await databasePool().query(
    'SELECT 1 FROM public.call_participants WHERE call_id = $1::uuid AND user_id = $2::uuid',
    [callId, body.toUserId],
  );
  if (!recipient.rowCount || body.toUserId === user.id) throw new HttpError(400, 'invalid_recipient', 'The signal recipient is not another call participant.');
  const messageId = body.clientMessageId ?? randomUUID();
  const inserted = await databasePool().query(
    `INSERT INTO public.call_signaling
      (call_id, from_user_id, to_user_id, type, payload, client_message_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb, $6::uuid)
     ON CONFLICT (call_id, from_user_id, client_message_id) WHERE client_message_id IS NOT NULL
     DO UPDATE SET client_message_id = excluded.client_message_id
     RETURNING *`,
    [callId, user.id, body.toUserId, body.type, JSON.stringify(body.payload), messageId],
  );
  publishToUsers([body.toUserId], databaseEvent('call_signaling', 'INSERT', inserted.rows[0]));
  return json(inserted.rows[0], 201);
}

export async function participantState(request: Request, callId: string): Promise<Response> {
  const user = await authenticate(request);
  await requireParticipant(callId, user.id);
  const body = await readJson(request, participantStateBody);
  const updated = await databasePool().query(
    `UPDATE public.call_participants
     SET is_muted = $3::boolean
     WHERE call_id = $1::uuid AND user_id = $2::uuid
     RETURNING *`,
    [callId, user.id, body.isMuted],
  );
  const audience = await participantIds(callId);
  publishToUsers(audience, databaseEvent('call_participants', 'UPDATE', updated.rows[0]));
  return json(updated.rows[0]);
}

export async function removeHistory(request: Request, callId: string): Promise<Response> {
  const user = await authenticate(request);
  const session = await requireParticipant(callId, user.id);
  if (!['ended', 'missed', 'declined', 'cancelled'].includes(session.status)) {
    throw new HttpError(409, 'call_active', 'An active call cannot be removed from history.');
  }
  await databasePool().query(
    'DELETE FROM public.call_participants WHERE call_id = $1::uuid AND user_id = $2::uuid',
    [callId, user.id],
  );
  return new Response(null, { status: 204 });
}

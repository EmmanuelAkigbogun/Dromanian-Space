import { z } from 'zod';
import { ensureChangeFeed } from '../server/change-feed.js';
import { authenticate, databasePool } from '../server/database.js';
import { addEventClient, publishBroadcast, updatePresence } from '../server/events.js';
import { HttpError, json, readJson, sseResponse } from '../server/http.js';

export async function stream(request: Request): Promise<Response> {
  const user = await authenticate(request);
  void ensureChangeFeed();
  const memberships = await databasePool().query('SELECT workspace_id FROM public.workspace_members WHERE user_id = $1::uuid', [user.id]);
  return sseResponse((channel) => {
    const remove = addEventClient(channel, user.id, memberships.rows.map((row) => row.workspace_id));
    const original = channel.close.bind(channel);
    channel.close = () => { remove(); original(); };
    channel.send('message', { kind: 'connected', payload: {} });
  });
}

async function topicAudience(userId: string, topic: string): Promise<string[]> {
  let query: string;
  let id: string;
  const workspace = /^workspace:([0-9a-f-]{36}):presence$/i.exec(topic);
  const channel = /^(?:channel|dm):([0-9a-f-]{36}):(?:typing|receipts)$/i.exec(topic);
  const call = /^(?:meeting|meeting-chat|whiteboard):([0-9a-f-]{36})$/i.exec(topic);
  if (workspace) {
    id = workspace[1];
    query = `SELECT target.user_id FROM public.workspace_members actor
             JOIN public.workspace_members target ON target.workspace_id = actor.workspace_id
             WHERE actor.workspace_id = $1::uuid AND actor.user_id = $2::uuid`;
  } else if (channel) {
    id = channel[1];
    query = `SELECT target.user_id FROM public.channel_members actor
             JOIN public.channel_members target ON target.channel_id = actor.channel_id
             WHERE actor.channel_id = $1::uuid AND actor.user_id = $2::uuid`;
  } else if (call) {
    id = call[1];
    query = `SELECT target.user_id FROM public.call_participants actor
             JOIN public.call_participants target ON target.call_id = actor.call_id
             WHERE actor.call_id = $1::uuid AND actor.user_id = $2::uuid`;
  } else {
    throw new HttpError(403, 'topic_forbidden', 'This realtime topic is not publishable.');
  }
  const result = await databasePool().query(query, [id, userId]);
  if (!result.rowCount) throw new HttpError(403, 'topic_forbidden', 'You are not a member of this realtime audience.');
  return result.rows.map((row) => row.user_id);
}

export async function broadcast(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const body = await readJson(request, z.object({ topic: z.string().min(1).max(200), event: z.string().min(1).max(100), payload: z.unknown(), type: z.string().optional() }));
  const audience = await topicAudience(user.id, body.topic);
  publishBroadcast(body.topic, body.event, { event: body.event, payload: body.payload, type: body.type ?? 'broadcast' }, audience);
  return json({ status: 'ok' });
}

export async function presence(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const body = await readJson(request, z.object({ topic: z.string().min(1).max(200), payload: z.unknown() }));
  const audience = await topicAudience(user.id, body.topic);
  updatePresence(body.topic, user.id, body.payload, audience);
  return json({ status: 'ok' });
}


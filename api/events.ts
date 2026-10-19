import { z } from 'zod';
import { authenticate } from '../server/database.js';
import { addEventClient, publishBroadcast, updatePresence } from '../server/events.js';
import { json, readJson, sseResponse } from '../server/http.js';

export async function stream(request: Request): Promise<Response> {
  await authenticate(request);
  return sseResponse((channel) => {
    const remove = addEventClient(channel);
    const original = channel.close.bind(channel);
    channel.close = () => { remove(); original(); };
    channel.send('message', { kind: 'connected', payload: {} });
  });
}

export async function broadcast(request: Request): Promise<Response> {
  await authenticate(request);
  const body = await readJson(request, z.object({ topic: z.string().min(1).max(200), event: z.string().min(1).max(100), payload: z.unknown(), type: z.string().optional() }));
  publishBroadcast(body.topic, body.event, { event: body.event, payload: body.payload, type: body.type ?? 'broadcast' });
  return json({ status: 'ok' });
}

export async function presence(request: Request): Promise<Response> {
  const user = await authenticate(request);
  const body = await readJson(request, z.object({ topic: z.string().min(1).max(200), payload: z.unknown() }));
  updatePresence(body.topic, user.id, body.payload);
  return json({ status: 'ok' });
}


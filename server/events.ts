import type { SseChannel } from './http.js';

type EventEnvelope = {
  kind: 'broadcast' | 'presence' | 'presence_state' | 'postgres_changes';
  topic?: string;
  event?: string;
  table?: string;
  payload: unknown;
};

const clients = new Set<SseChannel>();
const presence = new Map<string, Map<string, unknown>>();

export function addEventClient(channel: SseChannel): () => void {
  clients.add(channel);
  return () => clients.delete(channel);
}

export function publishEvent(event: EventEnvelope): void {
  for (const client of clients) {
    if (client.closed) clients.delete(client);
    else client.send('message', event);
  }
}

export function publishDatabaseChange(table: string, event: 'INSERT' | 'UPDATE' | 'DELETE', rows: unknown): void {
  const list = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  if (list.length === 0) {
    publishEvent({ kind: 'postgres_changes', table, event, payload: { eventType: event, new: {}, old: {} } });
    return;
  }
  for (const row of list) {
    publishEvent({
      kind: 'postgres_changes', table, event,
      payload: { eventType: event, new: event === 'DELETE' ? {} : row, old: event === 'DELETE' ? row : {}, table, schema: 'public' },
    });
  }
}

export function publishBroadcast(topic: string, event: string, payload: unknown): void {
  publishEvent({ kind: 'broadcast', topic, event, payload });
}

export function updatePresence(topic: string, userId: string, payload: unknown): void {
  const state = presence.get(topic) ?? new Map<string, unknown>();
  const joined = !state.has(userId);
  state.set(userId, payload);
  presence.set(topic, state);
  publishEvent({ kind: 'presence', topic, event: joined ? 'join' : 'sync', payload });
  publishEvent({ kind: 'presence_state', topic, payload: Object.fromEntries([...state].map(([id, value]) => [id, [value]])) });
}


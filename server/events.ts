import type { SseChannel } from './http.js';

type EventEnvelope = {
  kind: 'broadcast' | 'presence' | 'presence_state' | 'postgres_changes';
  topic?: string;
  event?: string;
  table?: string;
  payload: unknown;
};

interface EventClient { channel: SseChannel; userId: string; workspaceIds: Set<string> }
const clients = new Set<EventClient>();
const presence = new Map<string, Map<string, unknown>>();

export function addEventClient(channel: SseChannel, userId: string, workspaceIds: Iterable<string>): () => void {
  const client = { channel, userId, workspaceIds: new Set(workspaceIds) };
  clients.add(client);
  return () => clients.delete(client);
}

export function publishEvent(event: EventEnvelope, audience?: { userIds?: Iterable<string>; workspaceIds?: Iterable<string> }): void {
  const users = audience?.userIds ? new Set(audience.userIds) : null;
  const workspaces = audience?.workspaceIds ? new Set(audience.workspaceIds) : null;
  for (const client of clients) {
    if (client.channel.closed) { clients.delete(client); continue; }
    if (users && !users.has(client.userId)) continue;
    if (workspaces && ![...workspaces].some((id) => client.workspaceIds.has(id))) continue;
    client.channel.send('message', event);
  }
}

export function publishDatabaseChange(
  table: string,
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  row: unknown,
  userIds: Iterable<string>,
): void {
  publishEvent({
    kind: 'postgres_changes', table, event,
    payload: { eventType: event, new: event === 'DELETE' ? {} : row, old: event === 'DELETE' ? row : {}, table, schema: 'public' },
  }, { userIds });
}

export function publishToUsers(userIds: Iterable<string>, event: EventEnvelope): void {
  publishEvent(event, { userIds });
}

export function publishBroadcast(topic: string, event: string, payload: unknown, userIds: Iterable<string>): void {
  publishEvent({ kind: 'broadcast', topic, event, payload }, { userIds });
}

export function updatePresence(topic: string, userId: string, payload: unknown, audience: Iterable<string>): void {
  const state = presence.get(topic) ?? new Map<string, unknown>();
  const joined = !state.has(userId);
  state.set(userId, payload);
  presence.set(topic, state);
  publishEvent({ kind: 'presence', topic, event: joined ? 'join' : 'sync', payload }, { userIds: audience });
  publishEvent({ kind: 'presence_state', topic, payload: Object.fromEntries([...state].map(([id, value]) => [id, [value]])) }, { userIds: audience });
}


import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerHandler = (event: unknown) => void;

function serviceWorkerHarness(options?: { clients?: unknown[] }) {
  const handlers = new Map<string, WorkerHandler>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(options?.clients ?? []);
  const worker = {
    location: { origin: 'https://darkspace.example' },
    registration: { showNotification },
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll,
      openWindow,
    },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, handler: WorkerHandler) => handlers.set(type, handler),
  };
  const source = readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');
  vm.runInNewContext(source, { self: worker, URL, Promise });
  return { handlers, matchAll, openWindow, showNotification };
}

describe('push service-worker navigation', () => {
  it('keeps valid same-origin routes in push notification data', async () => {
    const { handlers, showNotification } = serviceWorkerHarness();
    let work: Promise<unknown> | undefined;
    handlers.get('push')?.({
      data: { json: () => ({ title: 'Task', url: '/tasks/123?view=approvals' }) },
      waitUntil: (promise: Promise<unknown>) => { work = promise; },
    });
    await work;

    expect(showNotification).toHaveBeenCalledWith('Task', expect.objectContaining({
      data: { url: '/tasks/123?view=approvals' },
    }));
  });

  it.each(['//evil.example/phish', '/\\evil.example/phish'])(
    'rejects cross-origin-looking push target %s',
    async (unsafeUrl) => {
      const { handlers, showNotification } = serviceWorkerHarness();
      let work: Promise<unknown> | undefined;
      handlers.get('push')?.({
        data: { json: () => ({ title: 'Unsafe', url: unsafeUrl }) },
        waitUntil: (promise: Promise<unknown>) => { work = promise; },
      });
      await work;

      expect(showNotification).toHaveBeenCalledWith('Unsafe', expect.objectContaining({
        data: { url: '/notifications' },
      }));
    },
  );

  it('opens valid app routes and falls back for unsafe click data', async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const focus = vi.fn().mockResolvedValue(undefined);
    const client = { url: 'https://darkspace.example/dm', focus, navigate };
    const { handlers } = serviceWorkerHarness({ clients: [client] });

    for (const [url, expected] of [
      ['/drive/item/abc', 'https://darkspace.example/drive/item/abc'],
      ['//evil.example/phish', 'https://darkspace.example/notifications'],
    ]) {
      let work: Promise<unknown> | undefined;
      handlers.get('notificationclick')?.({
        notification: { data: { url }, close: vi.fn() },
        waitUntil: (promise: Promise<unknown>) => { work = promise; },
      });
      await work;
      expect(navigate).toHaveBeenLastCalledWith(expected);
    }
  });
});

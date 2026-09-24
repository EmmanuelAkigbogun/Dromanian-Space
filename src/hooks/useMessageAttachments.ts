import { useEffect, useState, useCallback } from 'react';
import { getAttachmentsByMessageIds } from '@/lib/message/attachment';
import { isTempId } from '@/lib/message';
import type { FileAttachment } from '@/types';

const MAX_CACHE_SIZE = 2000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FLUSH_DELAY_MS = 30;

interface CacheEntry {
  attachments: FileAttachment[];
  fetchedAt: number;
}

const attachmentsCache = new Map<string, CacheEntry>();

let pendingIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notifyAttachmentsChanged() {
  listeners.forEach((fn) => fn());
}

function flushPending() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const ids = [...pendingIds];
  pendingIds = new Set();
  if (ids.length === 0) return;

  getAttachmentsByMessageIds(ids)
    .then((grouped) => {
      const now = Date.now();
      grouped.forEach((rows, id) => {
        attachmentsCache.set(id, { attachments: rows, fetchedAt: now });
      });
      cleanupCache();
      notifyAttachmentsChanged();
    })
    .catch(() => {
      pendingIds = new Set([...pendingIds, ...ids]);
    });
}

function requestFetch(ids: string[]) {
  const now = Date.now();
  ids.forEach((id) => {
    const entry = attachmentsCache.get(id);
    if (!entry || now - entry.fetchedAt >= CACHE_TTL_MS) {
      pendingIds.add(id);
    }
  });
  if (pendingIds.size === 0) return;
  if (flushTimer) return;
  flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
}

function cleanupCache() {
  if (attachmentsCache.size <= MAX_CACHE_SIZE) return;
  const keys = Array.from(attachmentsCache.keys());
  const toDelete = keys.slice(0, keys.length - MAX_CACHE_SIZE);
  toDelete.forEach((key) => attachmentsCache.delete(key));
}

export function invalidateMessageAttachments(messageId: string) {
  pendingIds.add(messageId);
  if (flushTimer) return;
  flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
}

export function useMessageAttachments(messageId: string) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (isTempId(messageId)) return;
    requestFetch([messageId]);
  }, [messageId]);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const entry = attachmentsCache.get(messageId);
  return {
    attachments: entry?.attachments ?? [],
    isLoading: !isTempId(messageId) && !entry,
  };
}

export function usePrefetchAttachments(messageIds: string[]) {
  useEffect(() => {
    const ids = messageIds.filter((id) => !isTempId(id));
    if (ids.length === 0) return;
    requestFetch(ids);
  }, [messageIds]);
}

export function useInvalidateAttachments() {
  return useCallback((messageId: string) => {
    invalidateMessageAttachments(messageId);
  }, []);
}

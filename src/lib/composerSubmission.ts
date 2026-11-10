export interface IdentifiedItem {
  id: string;
}

export interface ComposerScopeToken {
  routeKey: string;
  generation: number;
}

export interface AttachmentAttempt<T> {
  item: T;
  succeeded: boolean;
}

/** Build an unambiguous identity for the composer route. */
export function composerRouteKey(
  channelId?: string | null,
  conversationId?: string | null,
  parentId?: string | null,
): string {
  return JSON.stringify([channelId ?? null, conversationId ?? null, parentId ?? null]);
}

/**
 * Advance the token only when the route changes. The generation makes an old
 * A-route request stale even after navigating A -> B -> A.
 */
export function nextComposerScopeToken(
  current: ComposerScopeToken | null,
  routeKey: string,
): ComposerScopeToken {
  if (current?.routeKey === routeKey) return current;
  return {
    routeKey,
    generation: (current?.generation ?? 0) + 1,
  };
}

export function composerScopeIsCurrent(
  expected: ComposerScopeToken,
  current: ComposerScopeToken,
): boolean {
  return expected.routeKey === current.routeKey && expected.generation === current.generation;
}

/** Keep only attachment work that must be retried; successful work is never replayed. */
export function failedAttachmentItems<T>(attempts: readonly AttachmentAttempt<T>[]): T[] {
  return attempts.filter((attempt) => !attempt.succeeded).map((attempt) => attempt.item);
}

/** Keep items added for a later draft while removing only the submitted batch. */
export function withoutSubmittedItems<T extends IdentifiedItem>(
  current: readonly T[],
  submitted: readonly IdentifiedItem[],
): T[] {
  if (submitted.length === 0) return [...current];
  const submittedIds = new Set(submitted.map((item) => item.id));
  return current.filter((item) => !submittedIds.has(item.id));
}

/** A failed submission may replace the composer only if the user has not edited it since sending. */
export function composerIsUnchanged(submissionRevision: number, currentRevision: number): boolean {
  return submissionRevision === currentRevision;
}

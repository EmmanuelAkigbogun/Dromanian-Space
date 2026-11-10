export function withReplyCount(
  previous: Map<string, number>,
  parentId: string,
  count: number,
): Map<string, number> {
  if (previous.get(parentId) === count) return previous;
  const next = new Map(previous);
  next.set(parentId, count);
  return next;
}

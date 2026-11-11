/** Build the exact text sent to a social network from the reviewed fields. */
export function composeSocialPostText(
  caption: string,
  cta: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
): string {
  const body = caption.trim();
  const parts = body ? [body] : [];
  const callToAction = cta?.trim() ?? '';
  if (callToAction && !body.toLocaleLowerCase().includes(callToAction.toLocaleLowerCase())) {
    parts.push(callToAction);
  }

  const existing = new Set(
    [...body.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1].toLocaleLowerCase()),
  );
  const normalized = [...new Set((hashtags ?? [])
    .map((tag) => tag.trim().replace(/^#+/, '').replace(/\s+/g, ''))
    .filter(Boolean))];
  const missing = normalized.filter((tag) => !existing.has(tag.toLocaleLowerCase()));
  if (missing.length) parts.push(missing.map((tag) => `#${tag}`).join(' '));
  return parts.join('\n\n');
}

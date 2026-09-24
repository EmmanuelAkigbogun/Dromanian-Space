export function getMessagePermalink(messageId: string): string {
  const { origin, pathname } = window.location;
  if (pathname.startsWith('/dm/')) {
    const conversationId = pathname.split('/')[2] ?? '';
    return `${origin}/dm/${conversationId}#message-${messageId}`;
  }
  const slug = pathname.startsWith('/channels/') ? pathname.split('/')[2] ?? '' : '';
  return `${origin}/channels/${slug}#message-${messageId}`;
}

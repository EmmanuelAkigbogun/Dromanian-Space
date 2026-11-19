// WhatsApp-style replies: choosing "Reply" on a message puts a quote of it
// above the composer; sending stores it as a "> ↩ Name: text" quote line, so
// every client (and search, and agents) reads it as plain text.
export const CHAT_REPLY = 'chat-reply';

export interface ChatReplyDetail {
  channelId: string;
  messageId: string;
  name: string;
  text: string;
}

const MARK = '↩ ';
const REPLY_LINE = /^> ↩ .*$/gm;

/** The message's text without the quotes of earlier replies, on one line. */
export function replySnippet(content: string, hasAttachments = false): string {
  const text = content.replace(REPLY_LINE, '').replace(/\s+/g, ' ').trim();
  if (!text) return hasAttachments ? '📎 Attachment' : '';
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export function replyQuote(reply: Pick<ChatReplyDetail, 'name' | 'text'>): string {
  return `> ${MARK}${reply.name.replace(/[:\n]/g, ' ')}: ${reply.text.replace(/\n/g, ' ')}\n\n`;
}

/** Reads a quote token written by replyQuote. */
export function parseReply(quote: string): { name: string; text: string } | null {
  if (!quote.startsWith(MARK)) return null;
  const body = quote.slice(MARK.length);
  const colon = body.indexOf(': ');
  if (colon < 1) return null;
  return { name: body.slice(0, colon), text: body.slice(colon + 2) };
}

export function requestReply(detail: ChatReplyDetail) {
  window.dispatchEvent(new CustomEvent<ChatReplyDetail>(CHAT_REPLY, { detail }));
}

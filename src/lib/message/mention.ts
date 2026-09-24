export interface ParsedMention {
  type: 'text' | 'mention';
  value: string;
  userId?: string;
  displayName?: string;
}

const MENTION_REGEX = /@(\w+)/g;

export function parseMentions(content: string): ParsedMention[] {
  const parts: ParsedMention[] = [];
  let lastIndex = 0;

  let match;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }
    parts.push({
      type: 'mention',
      value: match[0],
      displayName: match[1],
    });
    lastIndex = MENTION_REGEX.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
}

export function extractMentionUsernames(content: string): string[] {
  const usernames: string[] = [];
  let match;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    usernames.push(match[1]);
  }
  return usernames;
}

export function highlightMentions(
  content: string,
  userIdMap: Map<string, string>,
): ParsedMention[] {
  const parts: ParsedMention[] = [];
  let lastIndex = 0;

  let match;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }

    const username = match[1];
    const userId = Array.from(userIdMap.entries()).find(
      ([, name]) => name.toLowerCase() === username.toLowerCase(),
    )?.[0];

    parts.push({
      type: 'mention',
      value: match[0],
      userId,
      displayName: username,
    });
    lastIndex = MENTION_REGEX.lastIndex;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts;
}

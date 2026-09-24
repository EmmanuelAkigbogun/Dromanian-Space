export type ContentToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strikethrough'; value: string }
  | { type: 'inline_code'; value: string }
  | { type: 'code_block'; value: string; language?: string }
  | { type: 'quote'; value: string }
  | { type: 'unordered_list'; items: string[] }
  | { type: 'ordered_list'; items: string[] }
  | { type: 'link'; url: string; value: string }
  | { type: 'mention'; value: string; isSpecial?: boolean }
  | { type: 'line_break' };

const SPECIAL_MENTIONS = new Set(['channel', 'everyone', 'here']);

export function parseMessageContent(content: string): ContentToken[] {
  const lines = content.split('\n');
  const tokens: ContentToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks: ```lang\n...\n```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      tokens.push({ type: 'code_block', value: codeLines.join('\n'), language: lang || undefined });
      continue;
    }

    // Unordered list: - item
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      tokens.push({ type: 'unordered_list', items });
      continue;
    }

    // Ordered list: 1. item
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      tokens.push({ type: 'ordered_list', items });
      continue;
    }

    // Quote: > text
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      tokens.push({ type: 'quote', value: quoteLines.join('\n') });
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      tokens.push({ type: 'line_break' });
      i++;
      continue;
    }

    // Regular line — parse inline formatting
    tokens.push(...parseInlineFormatting(line));
    i++;
    if (i < lines.length) {
      tokens.push({ type: 'line_break' });
    }
  }

  return tokens;
}

function parseInlineFormatting(text: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  // Process text character by character to handle nested formatting
  let pos = 0;

  while (pos < text.length) {
    // Inline code: `code`
    if (text[pos] === '`') {
      const end = text.indexOf('`', pos + 1);
      if (end !== -1) {
        tokens.push({ type: 'inline_code', value: text.slice(pos + 1, end) });
        pos = end + 1;
        continue;
      }
    }

    // Bold: **text** or __text__
    if ((text[pos] === '*' && text[pos + 1] === '*') || (text[pos] === '_' && text[pos + 1] === '_')) {
      const delim = text[pos];
      const end = text.indexOf(`${delim}${delim}`, pos + 2);
      if (end !== -1) {
        tokens.push({ type: 'bold', value: text.slice(pos + 2, end) });
        pos = end + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text[pos] === '~' && text[pos + 1] === '~') {
      const end = text.indexOf('~~', pos + 2);
      if (end !== -1) {
        tokens.push({ type: 'strikethrough', value: text.slice(pos + 2, end) });
        pos = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_ (single)
    if (text[pos] === '*' && text[pos + 1] !== '*' && text[pos - 1] !== '*') {
      const end = text.indexOf('*', pos + 1);
      if (end !== -1 && end !== pos + 1) {
        tokens.push({ type: 'italic', value: text.slice(pos + 1, end) });
        pos = end + 1;
        continue;
      }
    }
    if (text[pos] === '_' && text[pos + 1] !== '_' && text[pos - 1] !== '_') {
      const end = text.indexOf('_', pos + 1);
      if (end !== -1 && end !== pos + 1) {
        tokens.push({ type: 'italic', value: text.slice(pos + 1, end) });
        pos = end + 1;
        continue;
      }
    }

    // Mention: @username or @channel/@everyone/@here
    if (text[pos] === '@') {
      const match = text.slice(pos).match(/^@(\w+)/);
      if (match) {
        const username = match[1];
        tokens.push({
          type: 'mention',
          value: match[0],
          isSpecial: SPECIAL_MENTIONS.has(username.toLowerCase()),
        });
        pos += match[0].length;
        continue;
      }
    }

    // Link detection
    const remaining = text.slice(pos);
    const urlMatch = remaining.match(/^https?:\/\/[^\s<>)\]]+/);
    if (urlMatch) {
      tokens.push({ type: 'link', url: urlMatch[0], value: urlMatch[0] });
      pos += urlMatch[0].length;
      continue;
    }

    // Plain text — collect until next special character
    let end = pos + 1;
    while (end < text.length && !isSpecialChar(text[end])) {
      end++;
    }
    tokens.push({ type: 'text', value: text.slice(pos, end) });
    pos = end;
  }

  return tokens;
}

function isSpecialChar(char: string): boolean {
  return char === '`' || char === '*' || char === '_' || char === '~' || char === '@' || char === '<';
}

export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const regex = /https?:\/\/[^\s<>)\]]+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export function removeUrlsFromText(text: string, urls: string[]): string {
  if (urls.length === 0) return text;
  let result = text;
  for (const url of urls) {
    result = result.split(url).join('');
  }
  return result;
}

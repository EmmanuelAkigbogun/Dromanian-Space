import { memo, useMemo, type ReactNode } from 'react';
import { parseMessageContent, type ContentToken } from '@/lib/message/richText';
import styles from './MessageContent.module.css';

interface MessageContentProps {
  content: string;
}

function renderTokens(tokens: ContentToken[]): ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'text':
        return <span key={i}>{token.value}</span>;
      case 'bold':
        return <strong key={i}>{token.value}</strong>;
      case 'italic':
        return <em key={i}>{token.value}</em>;
      case 'strikethrough':
        return <del key={i}>{token.value}</del>;
      case 'inline_code':
        return <code key={i} className={styles.inlineCode}>{token.value}</code>;
      case 'code_block':
        return (
          <div key={i} className={styles.codeBlock}>
            {token.language && <div className={styles.codeBlockLang}>{token.language}</div>}
            <pre className={styles.codeBlockPre}>
              <code>{token.value}</code>
            </pre>
            <button
              type="button"
              className={styles.codeBlockCopy}
              onClick={() => navigator.clipboard.writeText(token.value)}
              title="Copy code"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
          </div>
        );
      case 'quote':
        return <blockquote key={i} className={styles.quote}>{token.value}</blockquote>;
      case 'unordered_list':
        return (
          <ul key={i} className={styles.list}>
            {token.items.map((item, j) => <li key={j}>{item}</li>)}
          </ul>
        );
      case 'ordered_list':
        return (
          <ol key={i} className={styles.list}>
            {token.items.map((item, j) => <li key={j}>{item}</li>)}
          </ol>
        );
      case 'link':
        return (
          <a
            key={i}
            href={token.url}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {token.value}
          </a>
        );
      case 'mention':
        return (
          <span key={i} className={`${styles.mention} ${token.isSpecial ? styles.mentionSpecial : ''}`}>
            {token.value}
          </span>
        );
      case 'line_break':
        return <br key={i} />;
      default:
        return <span key={i}>{(token as { value: string }).value}</span>;
    }
  });
}

export const MessageContent = memo(function MessageContent({ content }: MessageContentProps) {
  const tokens = useMemo(() => parseMessageContent(content), [content]);
  return <span className={styles.content}>{renderTokens(tokens)}</span>;
});

import { memo } from 'react';
import { parseMentions } from '@/lib/message';
import styles from './MentionHighlight.module.css';

interface MentionHighlightProps {
  content: string;
}

export const MentionHighlight = memo(function MentionHighlight({ content }: MentionHighlightProps) {
  const parts = parseMentions(content);

  return (
    <span>
      {parts.map((part, i) => {
        if (part.type === 'mention') {
          return (
            <span key={i} className={styles.mention}>
              {part.value}
            </span>
          );
        }
        return <span key={i}>{part.value}</span>;
      })}
    </span>
  );
});

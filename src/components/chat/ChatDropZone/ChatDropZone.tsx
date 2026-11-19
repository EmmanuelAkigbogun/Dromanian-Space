// Drag files anywhere over a conversation: an overlay invites the drop and
// hands the files to that conversation's composer.
import { useRef, useState, type ReactNode } from 'react';
import styles from './ChatDropZone.module.css';

export const CHAT_FILES_DROPPED = 'chat-files-dropped';
export interface ChatFilesDroppedDetail { channelId: string; files: File[] }

const DOTS = Array.from({ length: 36 }, (_, i) => i);

export function ChatDropZone({ channelId, label, children, className }: { channelId: string; label: string; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    <div
      className={`${styles.zone} ${className ?? ''}`}
      onDragEnter={(e) => { if (!hasFiles(e)) return; depth.current += 1; setOver(true); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={(e) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => {
        depth.current = 0;
        setOver(false);
        // The composer handles drops on itself.
        if (e.defaultPrevented || !hasFiles(e)) return;
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if (files.length) window.dispatchEvent(new CustomEvent<ChatFilesDroppedDetail>(CHAT_FILES_DROPPED, { detail: { channelId, files } }));
      }}
    >
      {children}
      {over && (
        <div className={styles.overlay} role="status">
          <div className={styles.burst} aria-hidden="true">
            {DOTS.map((i) => <i key={i} style={{ '--a': `${i * 10}deg`, '--d': `${(i % 6) * 0.08}s` } as React.CSSProperties} />)}
            <span className={styles.core}>
              <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14" /></svg>
            </span>
          </div>
          <strong>Upload your file</strong>
          <span>to <b>{label}</b></span>
        </div>
      )}
    </div>
  );
}

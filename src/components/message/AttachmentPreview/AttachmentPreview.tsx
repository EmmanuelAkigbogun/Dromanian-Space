import { memo, useCallback, useState, useEffect } from 'react';
import { formatFileSize, isImageFile, isVideoFile, isTextFile, isSvgFile, isAudioFile, getFileIcon, getSignedUrl, isLocalUrl } from '@/lib/message';
import { MediaViewer } from '@/components/ui/MediaViewer';
import { Portal } from '@/lib/overlay/Portal';
import type { FileAttachment } from '@/types';
import styles from './AttachmentPreview.module.css';

interface AttachmentPreviewProps {
  attachment: FileAttachment;
  onRemove?: (id: string) => void;
  removable?: boolean;
}

const ICONS: Record<string, React.ReactElement> = {
  image: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  video: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ),
  audio: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  pdf: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  file: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

export const AttachmentPreview = memo(function AttachmentPreview({
  attachment,
  onRemove,
  removable = false,
}: AttachmentPreviewProps) {
  const iconType = getFileIcon(attachment.file_type);
  const isSvg = isSvgFile(attachment.file_name);
  const isImage = isImageFile(attachment.file_type) || isSvg;
  const isVideo = isVideoFile(attachment.file_type);
  const isAudio = isAudioFile(attachment.file_type);
  const isText = isTextFile(attachment.file_type);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    if (isLocalUrl(attachment.file_url)) {
      setSignedUrl(attachment.file_url);
      return;
    }
    getSignedUrl(attachment.file_url).then(setSignedUrl);
  }, [attachment.file_url]);

  useEffect(() => {
    if (!isText || !signedUrl) return;
    let cancelled = false;
    fetch(signedUrl)
      .then((r) => r.text())
      .then((text) => { if (!cancelled) setTextContent(text); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isText, signedUrl]);

  const handleRemove = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    onRemove?.(attachment.id);
  }, [attachment.id, onRemove]);

  const [viewerOpen, setViewerOpen] = useState(false);
  const handleOpenViewer = useCallback(() => { if (signedUrl) setViewerOpen(true); }, [signedUrl]);

  const handleDownload = useCallback(() => {
    if (!signedUrl) return;
    const a = document.createElement('a');
    a.href = signedUrl;
    a.download = attachment.file_name;
    a.click();
  }, [signedUrl, attachment.file_name]);

  if (isImage) {
    return (
      <>
        <div className={styles.imagePreview} onClick={handleOpenViewer} style={{ cursor: 'pointer' }}>
          {!imageLoaded && (
            <div className={styles.imagePlaceholder}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
          )}
          {signedUrl && (
            <img
              src={signedUrl}
              alt={attachment.file_name}
              className={`${styles.image} ${imageLoaded ? styles.imageLoaded : ''} ${isSvg ? styles.svgImage : ''}`}
              loading="lazy"
              onLoad={() => setImageLoaded(true)}
            />
          )}
          <div className={styles.imageOverlay}>
            <span className={styles.imageName}>{attachment.file_name}</span>
            <span className={styles.imageSize}>{formatFileSize(attachment.file_size)}</span>
          </div>
          {removable && onRemove && (
            <button
              type="button"
              className={styles.removeButton}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onRemove(attachment.id); }}
              title="Remove"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        <Portal>
          <MediaViewer
            src={signedUrl}
            alt={attachment.file_name}
            type="image"
            open={viewerOpen}
            onClose={() => setViewerOpen(false)}
            size={attachment.file_size}
          />
        </Portal>
      </>
    );
  }

  if (isVideo && signedUrl) {
    return (
      <>
        <div className={styles.videoPreview} onClick={handleOpenViewer} style={{ cursor: 'pointer' }}>
          <video
            src={signedUrl}
            className={styles.video}
            controls
            preload="metadata"
            onClick={(e) => e.stopPropagation()}
          />
          <div className={styles.imageOverlay}>
            <span className={styles.imageName}>{attachment.file_name}</span>
            <span className={styles.imageSize}>{formatFileSize(attachment.file_size)}</span>
          </div>
          {removable && onRemove && (
            <button
              type="button"
              className={styles.removeButton}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onRemove(attachment.id); }}
              title="Remove"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        <Portal>
          <MediaViewer
            src={signedUrl}
            alt={attachment.file_name}
            type="video"
            open={viewerOpen}
            onClose={() => setViewerOpen(false)}
            size={attachment.file_size}
          />
        </Portal>
      </>
    );
  }

  if (isAudio && signedUrl) {
    return (
      <div className={styles.audioPreview}>
        <div className={styles.audioHeader}>
          <div className={styles.fileIcon}>
            {ICONS.audio ?? ICONS.file}
          </div>
          <div className={styles.fileInfo}>
            <span className={styles.fileName}>{attachment.file_name}</span>
            <span className={styles.fileSize}>{formatFileSize(attachment.file_size)}</span>
          </div>
          {removable && onRemove && (
            <button type="button" className={styles.removeButton} onClick={handleRemove} title="Remove">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        <audio src={signedUrl} controls className={styles.audioElement} preload="metadata" />
      </div>
    );
  }

  if (isText && signedUrl) {
    const lines = textContent?.split('\n') ?? [];
    const previewLines = lines.slice(0, 20);
    const truncated = lines.length > 20;
    return (
      <div className={styles.textPreview}>
        <div className={styles.textHeader}>
          <div className={styles.fileIcon}>
            {ICONS[iconType] ?? ICONS.file}
          </div>
          <div className={styles.fileInfo}>
            <button type="button" className={styles.fileName} onClick={handleDownload}>
              {attachment.file_name}
            </button>
            <span className={styles.fileSize}>{formatFileSize(attachment.file_size)}</span>
          </div>
          {removable && onRemove && (
            <button type="button" className={styles.removeButton} onClick={handleRemove} title="Remove">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {textContent !== null ? (
          <pre className={styles.textContent}>
            <code>{previewLines.join('\n')}{truncated ? '\n...' : ''}</code>
          </pre>
        ) : (
          <div className={styles.textLoading}>Loading preview...</div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.filePreview}>
      <div className={styles.fileIcon}>
        {ICONS[iconType] ?? ICONS.file}
      </div>
      <div className={styles.fileInfo}>
        <button
          type="button"
          className={styles.fileName}
          onClick={handleDownload}
        >
          {attachment.file_name}
        </button>
        <span className={styles.fileSize}>{formatFileSize(attachment.file_size)}</span>
      </div>
      {removable && onRemove && (
        <button
          type="button"
          className={styles.removeButton}
          onClick={handleRemove}
          title="Remove"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
});

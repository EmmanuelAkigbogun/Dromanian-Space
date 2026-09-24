import { useState, useEffect, useCallback, useRef } from 'react';
import styles from './MediaViewer.module.css';

interface MediaViewerItem {
  id: string;
  src: string | null;
  alt: string;
  type: 'image' | 'video' | 'embed' | 'text' | 'link';
  openUrl?: string;
  size?: number;
}

interface MediaViewerProps {
  src?: string | null;
  alt?: string;
  type: 'image' | 'video' | 'embed' | 'text' | 'link';
  open?: boolean;
  openUrl?: string;
  onClose: () => void;
  items?: MediaViewerItem[];
  currentIndex?: number;
  onNavigate?: (index: number) => void;
  size?: number;
}

export function MediaViewer({ src, alt, type, open, openUrl, onClose, items, currentIndex, onNavigate, size }: MediaViewerProps) {
  const [hasError, setHasError] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [loop, setLoop] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const currentItem = items && currentIndex !== undefined ? items[currentIndex] : null;
  const displaySrc = currentItem?.src ?? src;
  const displayAlt = currentItem?.alt ?? alt;
  const displayType = currentItem?.type ?? type;
  const displayOpenUrl = currentItem?.openUrl ?? openUrl;
  const displaySize = currentItem?.size ?? size;
  const canPrev = items && currentIndex !== undefined && currentIndex > 0;
  const canNext = items && currentIndex !== undefined && currentIndex < items.length - 1;
  const hasNav = items && items.length > 1;

  const navRef = useRef({ canPrev: false, canNext: false, onNavigate: undefined as ((i: number) => void) | undefined, currentIndex: 0 });
  navRef.current = { canPrev: !!canPrev, canNext: !!canNext, onNavigate, currentIndex: currentIndex ?? 0 };

  useEffect(() => {
    if (!open) return;
    setHasError(false);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && navRef.current.canPrev) {
        navRef.current.onNavigate?.(navRef.current.currentIndex - 1);
      }
      if (e.key === 'ArrowRight' && navRef.current.canNext) {
        navRef.current.onNavigate?.(navRef.current.currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  useEffect(() => {
    setHasError(false);
    setTextContent(null);
  }, [displaySrc, displayType]);

  useEffect(() => {
    if (displayType !== 'text' || !displaySrc || !open) return;
    let cancelled = false;
    setTextContent(null);
    fetch(displaySrc)
      .then((r) => r.text())
      .then((text) => { if (!cancelled) setTextContent(text); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [displayType, displaySrc, open]);

  const handleError = useCallback(() => { setHasError(true); }, []);

  const formatSize = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return null;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  const handleDownload = useCallback(async () => {
    if (!displaySrc) return;
    setMenuOpen(false);
    try {
      const res = await fetch(displaySrc);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = displayAlt || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      console.error('Download failed:', err);
      const a = document.createElement('a');
      a.href = displaySrc;
      a.download = displayAlt || 'download';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, [displaySrc, displayAlt]);

  useEffect(() => {
    if (!menuOpen && !infoOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen, infoOpen]);

  const handlePrev = useCallback(() => {
    if (navRef.current.canPrev) {
      navRef.current.onNavigate?.(navRef.current.currentIndex - 1);
    }
  }, []);

  const handleNext = useCallback(() => {
    if (navRef.current.canNext) {
      navRef.current.onNavigate?.(navRef.current.currentIndex + 1);
    }
  }, []);

  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-label="Media preview">
      <div className={styles.content} onClick={(e) => e.stopPropagation()}>
        {hasError || !displaySrc ? (
          <div className={styles.error}>
            <span>{displaySrc ? 'Failed to load media' : 'Preview not available'}</span>
          </div>
        ) : displayType === 'embed' ? (
          <iframe
            src={displaySrc}
            className={styles.embed}
            title={displayAlt || 'Document preview'}
          />
        ) : displayType === 'link' ? (
          <div className={styles.linkWrap}>
            <iframe
              src={displaySrc}
              className={styles.linkFrame}
              title={displayAlt || 'Link preview'}
              allowFullScreen
            />
            <div className={styles.linkFooter}>
              <a
                href={displayOpenUrl || displaySrc}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.openButton}
              >
                Open
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
          </div>
        ) : displayType === 'text' ? (
          <pre className={styles.textContent}>
            <code>{textContent ?? 'Loading...'}</code>
          </pre>
        ) : displayType === 'video' ? (
          <video
            ref={videoRef}
            src={displaySrc}
            className={styles.video}
            controls
            autoPlay
            loop={loop}
            onError={handleError}
          />
        ) : (
          <img
            src={displaySrc}
            alt={displayAlt || 'Image preview'}
            className={styles.image}
            onError={handleError}
          />
        )}
        {hasNav && (
          <button
            type="button"
            className={`${styles.navButton} ${styles.navPrev}`}
            onClick={handlePrev}
            disabled={!canPrev}
            aria-label="Previous file"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        {hasNav && (
          <button
            type="button"
            className={`${styles.navButton} ${styles.navNext}`}
            onClick={handleNext}
            disabled={!canNext}
            aria-label="Next file"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
        <div className={styles.topBar}>
          {displayType !== 'link' && (
            <div className={styles.menuWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.topButton}
                onClick={() => { setMenuOpen((o) => !o); setInfoOpen(false); }}
                aria-label="File options"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="5" r="1" />
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="12" cy="19" r="1" />
                </svg>
              </button>
              {menuOpen && (
                <div className={styles.menuDropdown}>
                  {displayType === 'video' && (
                    <button type="button" className={styles.menuItem} onClick={() => setLoop((l) => !l)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="17 1 21 5 17 9" />
                        <path d="M3 11V9a4 4 0 014-4h14" />
                        <polyline points="7 23 3 19 7 15" />
                        <path d="M21 13v2a4 4 0 01-4 4H3" />
                      </svg>
                      Loop {loop ? 'on' : 'off'}
                    </button>
                  )}
                  {displaySrc && (
                    <button type="button" className={styles.menuItem} onClick={handleDownload}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Download
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {displayType !== 'link' && (
            <div className={styles.menuWrap} ref={infoRef}>
              <button
                type="button"
                className={styles.topButton}
                onClick={() => { setInfoOpen((o) => !o); setMenuOpen(false); }}
                aria-label="File info"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
              {infoOpen && (
                <div className={styles.menuDropdown}>
                  <div className={styles.menuInfo}>
                    <span className={styles.menuInfoName}>{displayAlt || 'Unknown file'}</span>
                    <span className={styles.menuInfoType}>{displayType}</span>
                    {displaySize !== undefined && (
                      <span className={styles.menuInfoSize}>{formatSize(displaySize)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <button type="button" className={styles.topButton} onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

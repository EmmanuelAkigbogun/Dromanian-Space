import { memo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { getVideoEmbedInfo, getEmbeddableUrl, hostnameOf } from '@/lib/message';
import { MediaViewer } from '@/components/ui/MediaViewer';
import styles from './LinkPreview.module.css';

const DESKTOP_SCREEN_WIDTH = 1400;
const MOBILE_SCREEN_WIDTH = 400;

interface LinkPreviewCardProps {
  url: string;
  onDelete?: (url: string) => void;
}

interface EmbedCardProps {
  url: string;
  iframeSrc: string;
  iframeTitle: string;
  siteName: string;
  title: string;
  urlLine?: string;
  onDelete?: (url: string) => void;
  unlockByDefault?: boolean;
}

function EmbedCard({ url, iframeSrc, iframeTitle, siteName, title, urlLine, onDelete, unlockByDefault }: EmbedCardProps) {
  const [scrollEnabled, setScrollEnabled] = useState(unlockByDefault ?? false);
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [previewOpen, setPreviewOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const screenWidth = viewMode === 'desktop' ? DESKTOP_SCREEN_WIDTH : MOBILE_SCREEN_WIDTH;
  const screenHeight = Math.round(screenWidth * (viewMode === 'desktop' ? 9 / 16 : 16 / 9));

  const computeScale = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    setScale(w / screenWidth);
  }, [screenWidth]);

  useLayoutEffect(() => {
    computeScale();
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(computeScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeScale]);

  return (
    <div className={`${styles.card} ${viewMode === 'mobile' ? styles.cardMobile : ''}`} onClick={(e) => e.stopPropagation()}>
      <div
        ref={wrapperRef}
        className={`${styles.embedWrapper} ${viewMode === 'mobile' ? styles.embedWrapperMobile : ''}`}
        style={{ pointerEvents: scrollEnabled ? 'auto' : 'none' }}
      >
        <div
          className={styles.embedScaler}
          style={{ width: screenWidth, height: screenHeight, transform: `scale(${scale})` }}
        >
          <iframe
            className={styles.embedFrame}
            src={iframeSrc}
            title={iframeTitle}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            loading="lazy"
          />
        </div>
      </div>
      <div className={styles.body}>
        <span className={styles.siteName}>{siteName}</span>
        <span className={styles.title}>{title}</span>
        {urlLine && <span className={styles.url}>{urlLine}</span>}
      </div>
      <div className={styles.actionsRow}>
        <CopyLinkButton url={url} />
        <OpenLinkButton url={url} />
        <PreviewButton onClick={() => setPreviewOpen(true)} />
        <ViewModeButton
          viewMode={viewMode}
          onToggle={() => setViewMode((m) => (m === 'desktop' ? 'mobile' : 'desktop'))}
        />
        <LockButton locked={!scrollEnabled} onToggle={() => setScrollEnabled((s) => !s)} />
        {onDelete && <DeleteLinkButton url={url} onDelete={onDelete} />}
      </div>
      <MediaViewer
        src={iframeSrc}
        alt={iframeTitle}
        type="link"
        open={previewOpen}
        openUrl={url}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return locked ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [url]);
  return (
    <button
      type="button"
      className={styles.actionButton}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copy();
      }}
      aria-label={copied ? 'Copied' : 'Copy link'}
      title={copied ? 'Copied' : 'Copy link'}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function OpenLinkButton({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.actionButton}
      onClick={(e) => e.stopPropagation()}
      aria-label="Open link"
      title="Open link"
    >
      <OpenIcon />
    </a>
  );
}

function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className={styles.actionButton}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      aria-label="Preview"
      title="Preview"
    >
      <PreviewIcon />
    </button>
  );
}

function DeleteLinkButton({ url, onDelete }: { url: string; onDelete: (url: string) => void }) {
  return (
    <button
      type="button"
      className={`${styles.actionButton} ${styles.actionButtonDanger}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDelete(url);
      }}
      aria-label="Remove embed"
      title="Remove embed"
    >
      <DeleteIcon />
    </button>
  );
}

function ViewModeButton({ viewMode, onToggle }: { viewMode: 'desktop' | 'mobile'; onToggle: () => void }) {
  const isDesktop = viewMode === 'desktop';
  return (
    <button
      type="button"
      className={styles.actionButton}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-label={isDesktop ? 'Switch to mobile view' : 'Switch to desktop view'}
      title={isDesktop ? 'Switch to mobile view' : 'Switch to desktop view'}
    >
      {isDesktop ? <MonitorIcon /> : <PhoneIcon />}
    </button>
  );
}

function LockButton({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.actionButton} ${locked ? '' : styles.actionButtonActive}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-label={locked ? 'Unlock embed' : 'Lock embed'}
      title={locked ? 'Unlock embed (allow scrolling)' : 'Lock embed (block scrolling)'}
    >
      <LockIcon locked={locked} />
    </button>
  );
}

const VIDEO_SITE_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  dailymotion: 'Dailymotion',
  twitch: 'Twitch',
};

export const LinkPreviewCard = memo(function LinkPreviewCard({ url, onDelete }: LinkPreviewCardProps) {
  const videoInfo = getVideoEmbedInfo(url);
  const iframeSrc = videoInfo ? videoInfo.embedUrl : getEmbeddableUrl(url);

  if (videoInfo?.kind === 'youtube') {
    return (
      <EmbedCard
        url={url}
        iframeSrc={iframeSrc}
        iframeTitle="YouTube video player"
        siteName="YouTube"
        title="Watch on YouTube"
        urlLine={hostnameOf(url)}
        onDelete={onDelete}
        unlockByDefault
      />
    );
  }

  if (videoInfo) {
    const siteName = VIDEO_SITE_NAMES[videoInfo.kind] ?? 'Video';
    return (
      <EmbedCard
        url={url}
        iframeSrc={iframeSrc}
        iframeTitle={`${siteName} video player`}
        siteName={siteName}
        title={`Watch on ${siteName}`}
        onDelete={onDelete}
        unlockByDefault
      />
    );
  }

  return (
    <EmbedCard
      url={url}
      iframeSrc={iframeSrc}
      iframeTitle="Link preview"
      siteName={hostnameOf(url)}
      title="Open link"
      onDelete={onDelete}
    />
  );
});

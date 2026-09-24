import { memo, useCallback, useMemo, useState, useLayoutEffect, useRef } from 'react';
import { isVideoFile, isImageFile, isSvgFile, isTextFile, isPdfFile, getFileIcon, formatFileSize } from '@/lib/message';
import { useSignedUrls } from '@/hooks/useSignedUrls';
import { MediaViewer } from '@/components/ui/MediaViewer';
import { Dialog } from '@/components/ui/Dialog';
import { Portal } from '@/lib/overlay/Portal';
import type { FileAttachment } from '@/types';
import styles from './FilesGrid.module.css';

type Layout = 'grid' | 'masonry' | 'featured';

interface FilesGridProps {
  attachments: FileAttachment[];
}

const GRID_PAGE_SIZE = 25;
const FEATURED_THUMB_PAGE_SIZE = 8;
const MASONRY_PAGE_SIZE = 15;

function getPageRange(page: number, totalItems: number, pageSize: number): { start: number; end: number } {
  if (totalItems <= pageSize) return { start: 0, end: totalItems };
  const totalPages = Math.ceil(totalItems / pageSize);
  if (page < totalPages - 1) {
    return { start: page * pageSize, end: (page + 1) * pageSize };
  }
  return { start: Math.max(0, totalItems - pageSize), end: totalItems };
}

function getTotalPages(totalItems: number, pageSize: number): number {
  if (totalItems <= pageSize) return 1;
  return Math.ceil(totalItems / pageSize);
}

function Pagination({ page, totalPages, onPageChange }: {
  page: number;
  totalPages: number;
  onPageChange: (fn: (p: number) => number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className={styles.pagination}>
      <button type="button" className={styles.pageArrow} disabled={page === 0}
        onClick={(e) => { e.stopPropagation(); onPageChange(p => Math.max(0, p - 1)); }}>‹</button>
      <span className={styles.pageCounter}>{page + 1} / {totalPages}</span>
      <button type="button" className={styles.pageArrow} disabled={page >= totalPages - 1}
        onClick={(e) => { e.stopPropagation(); onPageChange(p => Math.min(totalPages - 1, p + 1)); }}>›</button>
    </div>
  );
}

const FILE_ICONS: Record<string, React.ReactElement> = {
  image: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  video: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ),
  audio: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  pdf: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  file: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

function getMediaType(attachment: FileAttachment): 'image' | 'video' | 'embed' | 'text' {
  if (isVideoFile(attachment.file_type)) return 'video';
  if (isPdfFile(attachment.file_type)) return 'embed';
  if (isTextFile(attachment.file_type)) return 'text';
  return 'image';
}

export const FilesGrid = memo(function FilesGrid({ attachments }: FilesGridProps) {
  const { urls, loaded, failed } = useSignedUrls(attachments);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [layout, setLayout] = useState<Layout>('grid');
  const [gridPage, setGridPage] = useState(0);
  const [masonryPage, setMasonryPage] = useState(0);
  const [featuredPage, setFeaturedPage] = useState(0);
  const [infoItem, setInfoItem] = useState<FileAttachment | null>(null);

  const count = attachments.length;

  const viewerItems = useMemo(() =>
    attachments.map((a) => ({
      id: a.id,
      src: urls.get(a.id) ?? null,
      alt: a.file_name,
      type: getMediaType(a),
    })),
  [attachments, urls]);

  const handleClick = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const switchLayout = useCallback((newLayout: Layout) => {
    setLayout(newLayout);
    setGridPage(0);
    setMasonryPage(0);
    setFeaturedPage(0);
  }, []);

  const handleCellKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>, onActivate: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  }, []);

  const gridRange = getPageRange(gridPage, count, GRID_PAGE_SIZE);
  const gridVisible = attachments.slice(gridRange.start, gridRange.end);
  const gridOverflow = Math.max(0, count - gridRange.end);
  const gridTotalPages = getTotalPages(count, GRID_PAGE_SIZE);

  const totalThumbs = Math.max(0, count - 1);
  const featuredThumbRange = getPageRange(featuredPage, totalThumbs, FEATURED_THUMB_PAGE_SIZE);
  const featuredThumbs = attachments.slice(1 + featuredThumbRange.start, 1 + featuredThumbRange.end);
  const featuredOverflow = Math.max(0, totalThumbs - featuredThumbRange.end);
  const featuredTotalPages = getTotalPages(totalThumbs, FEATURED_THUMB_PAGE_SIZE);

  const masonryRange = getPageRange(masonryPage, count, MASONRY_PAGE_SIZE);
  const masonryVisible = attachments.slice(masonryRange.start, masonryRange.end);
  const masonryOverflow = Math.max(0, count - masonryRange.end);
  const masonryTotalPages = getTotalPages(count, MASONRY_PAGE_SIZE);

  function renderFileCard(item: FileAttachment) {
    const iconType = getFileIcon(item.file_type);
    return (
      <div className={styles.fileTypeCard}>
        <div className={styles.fileTypeIcon}>{FILE_ICONS[iconType] ?? FILE_ICONS.file}</div>
        <span className={styles.fileTypeName}>{item.file_name}</span>
      </div>
    );
  }

  function renderMedia(item: FileAttachment, imageClassName: string) {
    const url = urls.get(item.id) ?? '';
    const isLoaded = loaded.has(item.id);
    if (isVideoFile(item.file_type)) {
      if (isLoaded && url) return <video src={url} className={imageClassName} preload="metadata" muted />;
      if (failed.has(item.id)) return renderFileCard(item);
      return <div className={styles.placeholder} />;
    }
    if (isImageFile(item.file_type) || isSvgFile(item.file_name)) {
      if (isLoaded && url) return <img src={url} alt={item.file_name} className={imageClassName} loading="lazy" />;
      if (failed.has(item.id)) return renderFileCard(item);
      return <div className={styles.placeholder} />;
    }
    if (isPdfFile(item.file_type)) {
      if (isLoaded && url) return <iframe src={url} className={styles.embedPreview} title={item.file_name} loading="lazy" />;
      if (failed.has(item.id)) return renderFileCard(item);
      return <div className={styles.placeholder} />;
    }
    return renderFileCard(item);
  }

  return (
    <div className={styles.wrapper}>
      {count > 1 && (
        <div className={styles.layoutBar}>
          <button type="button" aria-label="Grid layout" className={`${styles.layoutBtn} ${layout === 'grid' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('grid')} title="Grid">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Masonry layout" className={`${styles.layoutBtn} ${layout === 'masonry' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('masonry')} title="Masonry">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="5" height="10" rx="1" /><rect x="7" y="1" width="5" height="6" rx="1" /><rect x="7" y="8" width="5" height="7" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Featured layout" className={`${styles.layoutBtn} ${layout === 'featured' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('featured')} title="Featured">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="14" height="8" rx="1" /><rect x="1" y="10" width="4" height="5" rx="1" opacity="0.5" /><rect x="6" y="10" width="4" height="5" rx="1" opacity="0.5" /><rect x="11" y="10" width="4" height="5" rx="1" opacity="0.5" /></svg>
          </button>
        </div>
      )}

      {layout === 'grid' && (
        <>
          <div className={`${styles.layoutGrid} ${gridVisible.length <= 2 ? styles.grid2 : gridVisible.length <= 4 ? styles.grid2x2 : styles.grid3x3}`}>
            {gridVisible.map((item, i) => {
              const onActivate = () => {
                if (i === gridVisible.length - 1 && gridOverflow > 0) {
                  setGridPage(p => p + 1);
                } else {
                  handleClick(gridRange.start + i);
                }
              };
              return (
                <div key={`${item.id}-${i}`} role="button" tabIndex={0} className={styles.cell}
                  onClick={onActivate} onKeyDown={(e) => handleCellKeyDown(e, onActivate)}>
                  {renderMedia(item, styles.image)}
                  {i === gridVisible.length - 1 && gridOverflow > 0 && (
                    <div className={styles.overflow}>+{gridOverflow}</div>
                  )}
                  <div className={styles.cellOverlay}>
                    <span className={styles.cellLabel}>{item.file_name}</span>
                    <button type="button" className={styles.cellInfoBtn} onClick={(e) => { e.stopPropagation(); setInfoItem(item); }} title="File info">ℹ</button>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={gridPage} totalPages={gridTotalPages} onPageChange={setGridPage} />
        </>
      )}

      {layout === 'masonry' && (
        <>
          <div className={styles.layoutMasonry}>
            {masonryVisible.map((item, i) => {
              const onActivate = () => {
                if (i === masonryVisible.length - 1 && masonryOverflow > 0) {
                  setMasonryPage(p => p + 1);
                } else {
                  handleClick(masonryRange.start + i);
                }
              };
              return (
                <div key={`${item.id}-${i}`} role="button" tabIndex={0} className={styles.cellMasonry}
                  onClick={onActivate} onKeyDown={(e) => handleCellKeyDown(e, onActivate)}>
                  {renderMedia(item, styles.imageMasonry)}
                  {i === masonryVisible.length - 1 && masonryOverflow > 0 && (
                    <div className={styles.overflow}>+{masonryOverflow}</div>
                  )}
                  <div className={styles.cellOverlay}>
                    <span className={styles.cellLabel}>{item.file_name}</span>
                    <button type="button" className={styles.cellInfoBtn} onClick={(e) => { e.stopPropagation(); setInfoItem(item); }} title="File info">ℹ</button>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={masonryPage} totalPages={masonryTotalPages} onPageChange={setMasonryPage} />
        </>
      )}

      {layout === 'featured' && (
        <>
          <div className={styles.layoutFeatured}>
            {attachments[0] && (
              <div role="button" tabIndex={0} className={styles.cellFeaturedMain}
                onClick={() => handleClick(0)} onKeyDown={(e) => handleCellKeyDown(e, () => handleClick(0))}>
                {renderMedia(attachments[0], styles.image)}
                <div className={styles.cellOverlay}>
                  <span className={styles.cellLabel}>{attachments[0].file_name}</span>
                  <button type="button" className={styles.cellInfoBtn} onClick={(e) => { e.stopPropagation(); setInfoItem(attachments[0]); }} title="File info">ℹ</button>
                </div>
              </div>
            )}
            {attachments.length > 1 && (
              <div className={styles.featuredRow}>
                {featuredThumbs.map((item, i) => {
                  const actualIndex = 1 + featuredThumbRange.start + i;
                  const isLast = i === featuredThumbs.length - 1;
                  const onActivate = () => {
                    if (isLast && featuredOverflow > 0) {
                      setFeaturedPage(p => p + 1);
                    } else {
                      handleClick(actualIndex);
                    }
                  };
                  return (
                    <div key={`${item.id}-${i}`} role="button" tabIndex={0} className={styles.cellFeaturedThumb}
                      onClick={onActivate} onKeyDown={(e) => handleCellKeyDown(e, onActivate)}>
                      {renderMedia(item, styles.image)}
                      {isLast && featuredOverflow > 0 && (
                        <div className={styles.overflow}>+{featuredOverflow}</div>
                      )}
                      <div className={styles.cellOverlay}>
                        <span className={styles.cellLabel}>{item.file_name}</span>
                        <button type="button" className={styles.cellInfoBtn} onClick={(e) => { e.stopPropagation(); setInfoItem(item); }} title="File info">ℹ</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <Pagination page={featuredPage} totalPages={featuredTotalPages} onPageChange={setFeaturedPage} />
        </>
      )}

      <Portal>
        <MediaViewer
          src={activeIndex !== null ? (urls.get(attachments[activeIndex]?.id) ?? null) : null}
          alt={activeIndex !== null ? attachments[activeIndex]?.file_name : ''}
          type={activeIndex !== null ? getMediaType(attachments[activeIndex]) : 'image'}
          open={activeIndex !== null}
          onClose={() => setActiveIndex(null)}
          items={viewerItems}
          currentIndex={activeIndex ?? 0}
          onNavigate={setActiveIndex}
        />
      </Portal>

      <Dialog open={!!infoItem} onClose={() => setInfoItem(null)} title="File Info" size="sm">
        {infoItem && (
          <div className={styles.infoDialog}>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Name</span>
              <span className={styles.infoValue}>{infoItem.file_name}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Size</span>
              <span className={styles.infoValue}>{formatFileSize(infoItem.file_size)}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Type</span>
              <span className={styles.infoValue}>{infoItem.file_type}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoLabel}>Date</span>
              <span className={styles.infoValue}>{new Date(infoItem.created_at).toLocaleString()}</span>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
});

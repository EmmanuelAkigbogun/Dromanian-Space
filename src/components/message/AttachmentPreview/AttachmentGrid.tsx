import { memo, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { isVideoFile, isImageFile, isSvgFile, isTextFile, isPdfFile, isAudioFile, isLinkFile, getFileIcon, formatFileSize, normalizeFileType, getEmbeddableUrl, getYouTubeThumbnail } from '@/lib/message';
import { isTempId } from '@/lib/message';
import { supabase } from '@/lib/supabase';
import { useSignedUrls } from '@/hooks/useSignedUrls';
import { uploadFile, createFileAttachment, deleteFileAttachment, reorderAttachments, removeStoragePath } from '@/lib/message/attachment';
import { MediaViewer } from '@/components/ui/MediaViewer';
import { Portal } from '@/lib/overlay/Portal';
import type { FileAttachment } from '@/types';
import styles from './AttachmentGrid.module.css';

type Layout = 'grid' | 'masonry' | 'featured' | 'gallery' | 'carousel' | 'stack' | 'bento';

type PendingUploadStatus = 'uploading' | 'done' | 'error';

interface PendingUpload {
  key: string;
  file: File;
  progress: number;
  status: PendingUploadStatus;
  path?: string;
}

const VALID_LAYOUTS: readonly Layout[] = ['grid', 'masonry', 'featured', 'gallery', 'carousel', 'stack', 'bento'];

function normalizeLayout(value: string | null | undefined): Layout {
  return VALID_LAYOUTS.includes(value as Layout) ? (value as Layout) : 'stack';
}

const GRID_SCREEN_WIDTH = 1200;
const GRID_SCREEN_HEIGHT = 1600;

function ScaledLinkCell({ url, title, className }: { url: string; title: string; className: string }) {
  const cellRef = useRef<HTMLDivElement>(null);
  const [locked, setLocked] = useState(true);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setScale(Math.min(r.width / GRID_SCREEN_WIDTH, r.height / GRID_SCREEN_HEIGHT));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={cellRef} className={`${styles.linkCell} ${className}`}>
      <div className={styles.linkCellCenter}>
        <div
          className={styles.linkCellScaler}
          style={{
            width: GRID_SCREEN_WIDTH,
            height: GRID_SCREEN_HEIGHT,
            transform: `scale(${scale})`,
            pointerEvents: locked ? 'none' : 'auto',
          }}
        >
          <iframe
            src={getEmbeddableUrl(url)}
            className={styles.linkCellFrame}
            title={title}
            loading="lazy"
          />
        </div>
      </div>
      <span
        role="button"
        tabIndex={0}
        className={styles.linkCellLock}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setLocked((l) => !l);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            setLocked((l) => !l);
          }
        }}
        aria-label={locked ? 'Unlock embed' : 'Lock embed'}
        title={locked ? 'Unlock embed' : 'Lock embed'}
      >
        {locked ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
          </svg>
        )}
      </span>
    </div>
  );
}

interface AttachmentGridProps {
  attachments: FileAttachment[];
  messageId?: string;
  creatorId?: string;
  defaultLayout?: string | null;
  viewerId?: string | null;
  onAttachmentsChanged?: () => void;
  compact?: boolean;
}

const GRID_PAGE_SIZE = 9;
const FEATURED_THUMB_PAGE_SIZE = 8;
const MASONRY_PAGE_SIZE = 15;
const GALLERY_PAGE_SIZE = 5;
const STACK_PAGE_SIZE = 15;
const BENTO_PAGE_SIZE = 15;

const BENTO_PATTERN: ReadonlyArray<'large' | 'wide' | 'normal'> = ['large', 'normal', 'normal', 'normal', 'wide', 'normal'];

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
      <button type="button" className={styles.carouselArrow} disabled={page === 0}
        onClick={(e) => { e.stopPropagation(); onPageChange(p => Math.max(0, p - 1)); }}>‹</button>
      <span className={styles.carouselCounter}>{page + 1} / {totalPages}</span>
      <button type="button" className={styles.carouselArrow} disabled={page >= totalPages - 1}
        onClick={(e) => { e.stopPropagation(); onPageChange(p => Math.min(totalPages - 1, p + 1)); }}>›</button>
    </div>
  );
}

const FILE_ICONS: Record<string, React.ReactElement> = {
  image: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  video: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ),
  audio: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  pdf: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  file: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

function getMediaType(attachment: FileAttachment): 'image' | 'video' | 'embed' | 'text' | 'link' {
  if (isVideoFile(attachment.file_type)) return 'video';
  if (isPdfFile(attachment.file_type)) return 'embed';
  if (isTextFile(attachment.file_type)) return 'text';
  if (isLinkFile(attachment.file_type)) return 'link';
  return 'image';
}

export const AttachmentGrid = memo(function AttachmentGrid({ attachments, messageId, creatorId, defaultLayout, viewerId, onAttachmentsChanged, compact }: AttachmentGridProps) {
  const media = attachments;
  const { urls, loaded, failed } = useSignedUrls(media);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [layout, setLayout] = useState<Layout>(() => normalizeLayout(defaultLayout));
  const [isEditing, setIsEditing] = useState(false);
  const [editItems, setEditItems] = useState<FileAttachment[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragZoneOver, setDragZoneOver] = useState<'prev' | 'next' | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const cancelledRef = useRef(false);
  const aspectRatiosRef = useRef<Map<string, string>>(new Map());
  const [, setRatioVersion] = useState(0);
  const waitingForRefreshRef = useRef(false);
  const touchDragRef = useRef<{ index: number; pointerId: number; startX: number; startY: number; lastTarget: number | null } | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [touchDragActive, setTouchDragActive] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [stackIndex, setStackIndex] = useState(0);
  const [stackPage, setStackPage] = useState(0);
  const [gridPage, setGridPage] = useState(0);
  const [galleryPage, setGalleryPage] = useState(0);
  const [masonryPage, setMasonryPage] = useState(0);
  const [featuredPage, setFeaturedPage] = useState(0);
  const [bentoPage, setBentoPage] = useState(0);
  const stackRef = useRef<HTMLDivElement>(null);

  const activeMedia = editItems ?? media;
  const count = activeMedia.length;

  const isEditable = !!(
    messageId &&
    creatorId &&
    viewerId &&
    creatorId === viewerId &&
    !isTempId(messageId) &&
    onAttachmentsChanged
  );

  const startEdit = useCallback(() => {
    setEditItems(media);
    setSelected(new Set());
    setIsEditing(true);
  }, [media]);

  const releasePendingObjects = useCallback((uploads: PendingUpload[]) => {
    uploads.forEach((u) => {
      const url = objectUrlsRef.current.get(u.key);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(u.key);
      }
    });
  }, []);

  const cancelEdit = useCallback(() => {
    cancelledRef.current = true;
    setIsEditing(false);
    setEditItems(null);
    setSelected(new Set());
    releasePendingObjects(pendingUploads);
    pendingUploads.forEach((u) => {
      if (u.status === 'done' && u.path) removeStoragePath(u.path).catch(() => {});
    });
    setPendingUploads([]);
  }, [pendingUploads, releasePendingObjects]);

  const handleDone = useCallback(async () => {
    const toCommit = pendingUploads.filter((u) => u.status === 'done' && u.path);
    if (toCommit.length > 0) {
      setIsBusy(true);
      try {
        for (const u of toCommit) {
          if (!messageId || !viewerId) break;
          await createFileAttachment(messageId, viewerId, u.file, u.path!);
        }
      } catch (err) {
        console.error('Failed to commit attachments:', err);
      } finally {
        setIsBusy(false);
      }
    }
    if (editItems && editItems.length > 0) {
      await reorderAttachments(editItems.map((a) => a.id));
    }
    releasePendingObjects(pendingUploads);
    setPendingUploads([]);
    waitingForRefreshRef.current = true;
    setIsEditing(false);
    setSelected(new Set());
    onAttachmentsChanged?.();
  }, [editItems, pendingUploads, messageId, viewerId, onAttachmentsChanged, releasePendingObjects]);

  useEffect(() => {
    if (waitingForRefreshRef.current) {
      waitingForRefreshRef.current = false;
      setEditItems(null);
    }
  }, [media]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragZoneOver(null);
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index);
    }
  }, [dragIndex]);

  const handleDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    setDragZoneOver(null);
    if (dragIndex === null) return;
    if (dragIndex === index) {
      setDragIndex(null);
      return;
    }
    setEditItems((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
    setDragIndex(null);
  }, [dragIndex]);

  const handleMovePage = useCallback((sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    setEditItems((prev) => {
      if (!prev) return prev;
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex >= prev.length || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const a = next[sourceIndex];
      next[sourceIndex] = next[targetIndex];
      next[targetIndex] = a;
      return next;
    });
    setDragIndex(null);
    setDragOverIndex(null);
    setDragZoneOver(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    setDragZoneOver(null);
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Mirror dragIndex into a ref so the native touchmove blocker below can
  // read it synchronously without stale closures.
  useEffect(() => {
    dragIndexRef.current = dragIndex;
  }, [dragIndex]);

  // Once a reorder drag is engaged, block page scrolling with a native
  // non-passive touchmove listener (React's pointermove preventDefault can't
  // stop iOS scrolling). The grid also gets touch-action: none in edit mode.
  const preventScrollDuringDrag = useCallback((e: TouchEvent) => {
    if (touchDragRef.current && dragIndexRef.current !== null) {
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    if (!isEditing) return;
    document.addEventListener('touchmove', preventScrollDuringDrag, { passive: false });
    return () => document.removeEventListener('touchmove', preventScrollDuringDrag);
  }, [isEditing, preventScrollDuringDrag]);

  const findCellIndexAt = useCallback((x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y);
    let node = el as HTMLElement | null;
    while (node) {
      const idx = node.getAttribute('data-edit-cell-index');
      if (idx !== null && idx !== '') return Number(idx);
      node = node.parentElement;
    }
    return null;
  }, []);

  // HTML5 drag events don't fire on touch devices, so reordering the gallery
  // falls back to a long-press pointer drag (non-mouse pointers only).
  const handleTouchPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, index: number) => {
      if (e.pointerType === 'mouse' || e.button !== 0) return;
      clearLongPressTimer();
      // Disable the element's native HTML5 drag while a touch is active: on
      // touch a long-press would start the browser's own drag-and-drop and
      // fire pointercancel, aborting our pointer-based reorder. We drive
      // `draggable` from state so React can't flip it back on re-render.
      setTouchDragActive(true);
      touchDragRef.current = { index, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastTarget: null };
      e.currentTarget.setPointerCapture(e.pointerId);
      longPressTimerRef.current = window.setTimeout(() => {
        setDragIndex(index);
      }, 350);
    },
    [clearLongPressTimer],
  );

  const handleTouchPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = touchDragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (dragIndex === null) {
        // Not yet dragging: cancel the long-press if the finger moved too far
        // (i.e. the user is scrolling, not holding to reorder).
        if (Math.abs(e.clientX - drag.startX) > 10 || Math.abs(e.clientY - drag.startY) > 10) {
          clearLongPressTimer();
        }
        return;
      }
      e.preventDefault();
      const targetIndex = findCellIndexAt(e.clientX, e.clientY);
      touchDragRef.current = { ...drag, lastTarget: targetIndex };
      setDragOverIndex(targetIndex !== null && targetIndex !== dragIndex ? targetIndex : null);
    },
    [dragIndex, findCellIndexAt, clearLongPressTimer],
  );

  const handleTouchPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = touchDragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      clearLongPressTimer();
      touchDragRef.current = null;
      setTouchDragActive(false);
      if (dragIndex !== null) {
        const targetIndex = drag.lastTarget ?? findCellIndexAt(e.clientX, e.clientY);
        if (targetIndex !== null && targetIndex !== dragIndex) {
          suppressClickRef.current = true;
          setEditItems((prev) => {
            if (!prev) return prev;
            const next = [...prev];
            const [moved] = next.splice(dragIndex, 1);
            next.splice(targetIndex, 0, moved);
            return next;
          });
        }
      }
      setDragIndex(null);
      setDragOverIndex(null);
    },
    [dragIndex, findCellIndexAt, clearLongPressTimer],
  );

  const handleTouchPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = touchDragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      clearLongPressTimer();
      touchDragRef.current = null;
      setTouchDragActive(false);
      setDragIndex(null);
      setDragOverIndex(null);
    },
    [clearLongPressTimer],
  );

  const handleAddFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0 || !messageId || !viewerId) return;
    cancelledRef.current = false;
    for (const file of files) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const normalized = normalizeFileType(file);
      if (isImageFile(normalized.type)) {
        objectUrlsRef.current.set(key, URL.createObjectURL(normalized));
      }
      setPendingUploads((prev) => [...prev, { key, file: normalized, progress: 0, status: 'uploading' }]);
      const path = await uploadFile(normalized, messageId, (p) => {
        setPendingUploads((prev) => prev.map((u) => (u.key === key ? { ...u, progress: p } : u)));
      });
      if (cancelledRef.current) {
        if (path) removeStoragePath(path).catch(() => {});
        return;
      }
      if (path) {
        setPendingUploads((prev) => prev.map((u) => (u.key === key ? { ...u, progress: 100, status: 'done', path } : u)));
      } else {
        setPendingUploads((prev) => prev.map((u) => (u.key === key ? { ...u, status: 'error' } : u)));
      }
    }
  }, [messageId, viewerId]);

  const handleDeleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    setIsBusy(true);
    try {
      for (const id of ids) {
        await deleteFileAttachment(id);
      }
      setSelected(new Set());
      onAttachmentsChanged?.();
    } catch (err) {
      console.error('Failed to delete attachments:', err);
    } finally {
      setIsBusy(false);
    }
  }, [selected, onAttachmentsChanged]);

  const viewerItems = useMemo(() =>
    media.map((a) => {
      const type = getMediaType(a);
      return {
        id: a.id,
        src: type === 'link' ? getEmbeddableUrl(a.file_url) : (urls.get(a.id) ?? null),
        alt: a.file_name,
        type,
        openUrl: type === 'link' ? a.file_url : undefined,
        size: a.file_size,
      };
    }),
  [media, urls]);

  const stackTotalPages = getTotalPages(count, STACK_PAGE_SIZE);
  const stackStart = stackPage * STACK_PAGE_SIZE;
  const stackEnd = Math.min(stackStart + STACK_PAGE_SIZE, count);
  const stackVisible = activeMedia.slice(stackStart, stackEnd);
  const stackVisibleCount = stackVisible.length;

  useLayoutEffect(() => {
    if (layout !== 'stack' || !stackRef.current) return;
    const container = stackRef.current;
    const DEG2RAD = Math.PI / 180;
    const CARD_HEIGHT = 220;
    const HALF_H = CARD_HEIGHT / 2;
    const VERTICAL_STEP = 6;
    const ROTATION_STEP = 2.5;

    function recalc() {
      const N = stackVisibleCount;
      if (N === 0) return;

      const W = container.getBoundingClientRect().width;
      const halfW = (W * 0.75) / 2;

      let maxTopExtent = 0;
      let maxBottomExtent = 0;

      for (let i = 0; i < N; i++) {
        const theta = (i - N / 2) * ROTATION_STEP * DEG2RAD;
        const extY = halfW * Math.abs(Math.sin(theta)) + HALF_H * Math.abs(Math.cos(theta));
        const topExtent = VERTICAL_STEP * i + extY;
        if (topExtent > maxTopExtent) maxTopExtent = topExtent;
        if (extY > maxBottomExtent) maxBottomExtent = extY;
      }

      const baseTop = maxTopExtent - HALF_H;
      const neededHeight = baseTop + HALF_H + maxBottomExtent;

      container.style.minHeight = `${neededHeight}px`;

      const cells = container.querySelectorAll<HTMLElement>('button');
      for (const cell of cells) {
        cell.style.top = `${baseTop}px`;
      }
    }

    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(container);
    return () => { ro.disconnect(); };
  }, [layout, stackVisibleCount, urls, isEditing]);

  const handleClick = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const switchLayout = useCallback((newLayout: Layout) => {
    setLayout(newLayout);
    setGridPage(0);
    setGalleryPage(0);
    setMasonryPage(0);
    setFeaturedPage(0);
    setBentoPage(0);
    setCarouselIndex(0);
    setStackIndex(0);
    setStackPage(0);

    if (
      messageId &&
      creatorId &&
      viewerId &&
      creatorId === viewerId &&
      !isTempId(messageId)
    ) {
      supabase
        .from('messages')
        .update({ attachments_layout: newLayout })
        .eq('id', messageId)
        .then(({ error }) => {
          if (error) console.error('Failed to persist attachment layout:', error);
        });
    }
  }, [messageId, creatorId, viewerId]);

  const gridRange = getPageRange(gridPage, count, GRID_PAGE_SIZE);
  const gridVisible = activeMedia.slice(gridRange.start, gridRange.end);
  const gridOverflow = Math.max(0, count - gridRange.end);
  const gridTotalPages = getTotalPages(count, GRID_PAGE_SIZE);

  const totalThumbs = Math.max(0, count - 1);
  const featuredThumbRange = getPageRange(featuredPage, totalThumbs, FEATURED_THUMB_PAGE_SIZE);
  const featuredThumbs = activeMedia.slice(1 + featuredThumbRange.start, 1 + featuredThumbRange.end);
  const featuredOverflow = Math.max(0, totalThumbs - featuredThumbRange.end);
  const featuredTotalPages = getTotalPages(totalThumbs, FEATURED_THUMB_PAGE_SIZE);

  const masonryRange = getPageRange(masonryPage, count, MASONRY_PAGE_SIZE);
  const masonryVisible = activeMedia.slice(masonryRange.start, masonryRange.end);
  const masonryOverflow = Math.max(0, count - masonryRange.end);
  const masonryTotalPages = getTotalPages(count, MASONRY_PAGE_SIZE);

  const galleryRange = getPageRange(galleryPage, count, GALLERY_PAGE_SIZE);
  const galleryVisible = activeMedia.slice(galleryRange.start, galleryRange.end);
  const galleryOverflow = Math.max(0, count - galleryRange.end);
  const galleryTotalPages = getTotalPages(count, GALLERY_PAGE_SIZE);

  const bentoRange = getPageRange(bentoPage, count, BENTO_PAGE_SIZE);
  const bentoVisible = activeMedia.slice(bentoRange.start, bentoRange.end);
  const bentoOverflow = Math.max(0, count - bentoRange.end);
  const bentoTotalPages = getTotalPages(count, BENTO_PAGE_SIZE);

  function renderFileCard(item: FileAttachment, missing = false) {
    const iconType = getFileIcon(item.file_type);
    return (
      <div className={styles.fileTypeCard}>
        <div className={styles.fileTypeIcon}>{FILE_ICONS[iconType] ?? FILE_ICONS.file}</div>
        {missing ? (
          <span className={styles.fileDeletedLabel}>Deleted</span>
        ) : (
          <span className={styles.fileTypeName}>{item.file_name}</span>
        )}
      </div>
    );
  }

  function renderMedia(item: FileAttachment, imageClassName: string, loadedClassName?: string) {
    const url = urls.get(item.id) ?? '';
    const isLoaded = loaded.has(item.id);
    if (isVideoFile(item.file_type)) {
      if (isLoaded && url) {
        return <video src={url} className={`${imageClassName} ${loadedClassName ?? ''}`} preload="metadata" muted />;
      }
      if (failed.has(item.id)) return renderFileCard(item, true);
      return <div className={styles.placeholder} />;
    }
    if (isImageFile(item.file_type) || isSvgFile(item.file_name)) {
      if (isLoaded && url) {
        return (
          <img
            src={url}
            alt={item.file_name}
            className={`${imageClassName} ${loadedClassName ?? ''}`}
            loading="lazy"
            onLoad={(e) => {
              const w = e.currentTarget.naturalWidth;
              const h = e.currentTarget.naturalHeight;
              const ratio = `${w}/${h}`;
              if (w && h && aspectRatiosRef.current.get(item.id) !== ratio) {
                aspectRatiosRef.current.set(item.id, ratio);
                setRatioVersion((v) => v + 1);
              }
            }}
          />
        );
      }
      if (failed.has(item.id)) return renderFileCard(item, true);
      return <div className={styles.placeholder} />;
    }
    if (isPdfFile(item.file_type)) {
      if (isLoaded && url) {
        return <iframe src={url} className={styles.embedPreview} title={item.file_name} loading="lazy" />;
      }
      if (failed.has(item.id)) return renderFileCard(item, true);
      return <div className={styles.placeholder} />;
    }
    if (isAudioFile(item.file_type)) {
      if (isLoaded && url) {
        return (
          <div className={styles.audioPlayerWrap} onClick={(e) => e.stopPropagation()}>
            <audio src={url} controls className={styles.audioPlayer} preload="metadata" />
            <span className={styles.audioFileName}>{item.file_name}</span>
          </div>
        );
      }
      if (failed.has(item.id)) return renderFileCard(item, true);
      return <div className={styles.placeholder} />;
    }
    if (isLinkFile(item.file_type)) {
      const thumb = getYouTubeThumbnail(item.file_url);
      if (thumb) {
        return (
          <div className={`${styles.linkCell} ${imageClassName}`}>
            <img src={thumb} alt={item.file_name} className={styles.linkCellThumb} loading="lazy" />
            <span className={styles.linkCellPlay} aria-hidden="true" />
          </div>
        );
      }
      return (
        <ScaledLinkCell url={item.file_url} title={item.file_name} className={imageClassName} />
      );
    }
    return failed.has(item.id) ? renderFileCard(item, true) : renderFileCard(item);
  }

  function renderEditCell(item: FileAttachment, i: number, cellClass: string, imgClass: string, cellStyle?: React.CSSProperties) {
    return (
      <div
        key={item.id}
        style={touchDragActive ? { ...cellStyle, touchAction: 'none' } : cellStyle}
        className={`${styles.editCellWrap} ${cellClass} ${selected.has(item.id) ? styles.editCellSelected : ''} ${dragIndex === i ? styles.editCellDragging : ''} ${dragOverIndex === i ? styles.editCellDragOver : ''}`}
        draggable={!touchDragActive}
        data-edit-cell-index={i}
        onDragStart={(e) => handleDragStart(e, i)}
        onDragOver={(e) => handleDragOver(e, i)}
        onDragLeave={() => setDragOverIndex((prev) => (prev === i ? null : prev))}
        onDrop={(e) => handleDrop(e, i)}
        onDragEnd={handleDragEnd}
        onPointerDown={(e) => handleTouchPointerDown(e, i)}
        onPointerMove={handleTouchPointerMove}
        onPointerUp={handleTouchPointerUp}
        onPointerCancel={handleTouchPointerCancel}
        onContextMenu={(e) => {
          // Suppress the native mobile long-press menu (copy/edit/delete)
          // while touch-dragging to reorder grid images, and stop it from
          // bubbling up to the message's own context menu trigger.
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          toggleSelect(item.id);
        }}
      >
        {renderMedia(item, imgClass)}
        <button
          type="button"
          className={styles.editCellSelect}
          onClick={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
          aria-label={selected.has(item.id) ? 'Deselect' : 'Select'}
        >
          {selected.has(item.id) && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      </div>
    );
  }

  function renderPageZone(direction: 'prev' | 'next', page: number, pageSize: number, offset: number) {
    const targetIndex = offset + (direction === 'prev' ? page - 1 : page + 1) * pageSize;
    const active = dragZoneOver === direction;
    return (
      <div
        className={`${styles.pageDropZone} ${active ? styles.pageDropZoneActive : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragIndex !== null && dragZoneOver !== direction) setDragZoneOver(direction);
        }}
        onDragLeave={() => setDragZoneOver((p) => (p === direction ? null : p))}
        onDrop={(e) => {
          e.preventDefault();
          setDragZoneOver(null);
          if (dragIndex === null) return;
          handleMovePage(dragIndex, targetIndex);
        }}
      >
        {direction === 'prev' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        )}
        <span>{direction === 'prev' ? 'Move to previous page' : 'Move to next page'}</span>
      </div>
    );
  }

  function renderPageZones(page: number, totalPages: number, pageSize: number, offset = 0) {
    const hasPrev = totalPages > 1 && page > 0;
    const hasNext = totalPages > 1 && page < totalPages - 1;
    if (!hasPrev && !hasNext) return null;
    return (
      <div className={styles.pageZones}>
        {hasPrev && renderPageZone('prev', page, pageSize, offset)}
        {hasNext && renderPageZone('next', page, pageSize, offset)}
      </div>
    );
  }

  return (
    <div className={`${styles.wrapper} ${media.length === 1 && !isEditing ? styles.wrapperSingle : ''} ${compact ? styles.compact : ''}`}>
      {!isEditing && media.length > 0 && (
        <div className={styles.controlsRow}>
          {media.length > 1 && (
            <div className={styles.layoutBar}>
          <button type="button" aria-label="Stack layout" className={`${styles.layoutBtn} ${layout === 'stack' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('stack')} title="Stack">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="1" width="10" height="10" rx="1" opacity="0.3" /><rect x="2" y="3" width="10" height="10" rx="1" opacity="0.6" /><rect x="0" y="5" width="10" height="10" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Grid layout" className={`${styles.layoutBtn} ${layout === 'grid' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('grid')} title="Grid">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Masonry layout" className={`${styles.layoutBtn} ${layout === 'masonry' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('masonry')} title="Masonry">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="5" height="10" rx="1" /><rect x="7" y="1" width="5" height="6" rx="1" /><rect x="7" y="8" width="5" height="7" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Bento layout" className={`${styles.layoutBtn} ${layout === 'bento' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('bento')} title="Bento">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="9" height="9" rx="1" /><rect x="11" y="1" width="4" height="4" rx="1" /><rect x="11" y="6" width="4" height="4" rx="1" /><rect x="1" y="11" width="6" height="4" rx="1" /><rect x="8" y="11" width="7" height="4" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Featured layout" className={`${styles.layoutBtn} ${layout === 'featured' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('featured')} title="Featured">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="14" height="8" rx="1" /><rect x="1" y="10" width="4" height="5" rx="1" opacity="0.5" /><rect x="6" y="10" width="4" height="5" rx="1" opacity="0.5" /><rect x="11" y="10" width="4" height="5" rx="1" opacity="0.5" /></svg>
          </button>
          <button type="button" aria-label="Gallery layout" className={`${styles.layoutBtn} ${layout === 'gallery' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('gallery')} title="Gallery">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="14" height="4" rx="1" /><rect x="1" y="6" width="14" height="4" rx="1" /><rect x="1" y="11" width="14" height="4" rx="1" /></svg>
          </button>
          <button type="button" aria-label="Carousel layout" className={`${styles.layoutBtn} ${layout === 'carousel' ? styles.layoutBtnActive : ''}`} onClick={() => switchLayout('carousel')} title="Carousel">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="10" height="12" rx="1" /><rect x="1" y="5" width="2" height="6" rx="1" opacity="0.4" /><rect x="13" y="5" width="2" height="6" rx="1" opacity="0.4" /></svg>
          </button>
            </div>
          )}

          {isEditable && media.length > 0 && (
            <button type="button" className={styles.editBtn} onClick={startEdit} aria-label="Edit attachments" title="Edit attachments">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          )}
        </div>
      )}

      {isEditing && (
        <div className={styles.editToolbar}>
          <span className={styles.editCount}>{selected.size} selected</span>
          <button type="button" className={styles.editBtnPrimary} onClick={handleDone} disabled={isBusy || pendingUploads.some((u) => u.status === 'uploading')}>Done</button>
          <button
            type="button"
            className={styles.editBtnGhost}
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            aria-label="Add files"
            title="Add files"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.editBtnGhost}
            onClick={handleDeleteSelected}
            disabled={selected.size === 0 || isBusy}
            aria-label={`Delete ${selected.size} selected`}
            title={`Delete ${selected.size} selected`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.editBtnGhost}
            onClick={cancelEdit}
            disabled={isBusy}
            aria-label="Cancel"
            title="Cancel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,application/pdf,text/*"
        multiple
        className={styles.hiddenInput}
        onChange={handleAddFiles}
      />

      {media.length === 1 && !isEditing && (
        <button type="button" className={styles.singleCell} onClick={() => handleClick(0)}>
          {renderMedia(media[0], styles.singleImage)}
        </button>
      )}

      {!isEditing ? (
        <>
      {layout === 'grid' && (
        <>
          <div className={`${styles.grid} ${styles.layoutGrid} ${gridVisible.length <= 2 ? styles.grid2 : gridVisible.length <= 4 ? styles.grid2x2 : styles.grid3x3}`}>
            {gridVisible.map((item, i) => (
              <button key={`${item.id}-${i}`} type="button" className={styles.cell} onClick={() => {
                if (i === gridVisible.length - 1 && gridOverflow > 0) {
                  setGridPage(p => p + 1);
                } else {
                  handleClick(gridRange.start + i);
                }
              }}>
                {renderMedia(item, styles.image)}
                {i === gridVisible.length - 1 && gridOverflow > 0 && (
                  <div className={styles.overflow}>+{gridOverflow}</div>
                )}
              </button>
            ))}
          </div>
          <Pagination page={gridPage} totalPages={gridTotalPages} onPageChange={setGridPage} />
        </>
      )}

      {layout === 'masonry' && (
        <>
          <div className={`${styles.grid} ${styles.layoutMasonry}`}>
            {masonryVisible.map((item, i) => {
              const ratio = aspectRatiosRef.current.get(item.id);
              return (
                <button
                  key={`${item.id}-${i}`}
                  type="button"
                  className={styles.cellMasonry}
                  style={ratio ? { aspectRatio: ratio } : undefined}
                  onClick={() => {
                    if (i === masonryVisible.length - 1 && masonryOverflow > 0) {
                      setMasonryPage(p => p + 1);
                    } else {
                      handleClick(masonryRange.start + i);
                    }
                  }}
                >
                  {renderMedia(item, styles.imageMasonry)}
                  {i === masonryVisible.length - 1 && masonryOverflow > 0 && (
                    <div className={styles.overflow}>+{masonryOverflow}</div>
                  )}
                </button>
              );
            })}
          </div>
          <Pagination page={masonryPage} totalPages={masonryTotalPages} onPageChange={setMasonryPage} />
        </>
      )}

      {layout === 'featured' && (
        <>
          <div className={`${styles.grid} ${styles.layoutFeatured}`}>
            {media[0] && (
              <button type="button" className={styles.cellFeaturedMain} onClick={() => handleClick(0)}>
                {renderMedia(media[0], styles.image)}
              </button>
            )}
            {media.length > 1 && (
              <div className={styles.featuredRow}>
                {featuredThumbs.map((item, i) => {
                  const actualIndex = 1 + featuredThumbRange.start + i;
                  const isLast = i === featuredThumbs.length - 1;
                  return (
                    <button key={`${item.id}-${i}`} type="button" className={styles.cellFeaturedThumb} onClick={() => {
                      if (isLast && featuredOverflow > 0) {
                        setFeaturedPage(p => p + 1);
                      } else {
                        handleClick(actualIndex);
                      }
                    }}>
                      {renderMedia(item, styles.image)}
                      {isLast && featuredOverflow > 0 && (
                        <div className={styles.overflow}>+{featuredOverflow}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Pagination page={featuredPage} totalPages={featuredTotalPages} onPageChange={setFeaturedPage} />
        </>
      )}

      {layout === 'gallery' && (
        <>
          <div className={`${styles.grid} ${styles.layoutGallery}`}>
            {galleryVisible.map((item, i) => (
              <button key={`${item.id}-${i}`} type="button" className={styles.cellGallery} onClick={() => {
                if (i === galleryVisible.length - 1 && galleryOverflow > 0) {
                  setGalleryPage(p => p + 1);
                } else {
                  handleClick(galleryRange.start + i);
                }
              }}>
                {renderMedia(item, styles.imageGallery)}
                {i === galleryVisible.length - 1 && galleryOverflow > 0 && (
                  <div className={styles.overflow}>+{galleryOverflow}</div>
                )}
              </button>
            ))}
          </div>
          <Pagination page={galleryPage} totalPages={galleryTotalPages} onPageChange={setGalleryPage} />
        </>
      )}

      {layout === 'bento' && (
        <>
          <div className={`${styles.grid} ${styles.layoutBento}`}>
            {bentoVisible.map((item, i) => {
              const size = BENTO_PATTERN[i % BENTO_PATTERN.length];
              const sizeClass = size === 'large'
                ? styles.cellBentoLarge
                : size === 'wide'
                  ? styles.cellBentoWide
                  : styles.cellBentoNormal;
              const isLast = i === bentoVisible.length - 1;
              return (
                <button key={`${item.id}-${i}`} type="button" className={`${styles.cellBento} ${sizeClass}`} onClick={() => {
                  if (isLast && bentoOverflow > 0) {
                    setBentoPage(p => p + 1);
                  } else {
                    handleClick(bentoRange.start + i);
                  }
                }}>
                  {renderMedia(item, styles.image)}
                  {isLast && bentoOverflow > 0 && (
                    <div className={styles.overflow}>+{bentoOverflow}</div>
                  )}
                </button>
              );
            })}
          </div>
          <Pagination page={bentoPage} totalPages={bentoTotalPages} onPageChange={setBentoPage} />
        </>
      )}

      {layout === 'carousel' && (
        <div className={`${styles.grid} ${styles.layoutCarousel}`}>
          <button type="button" className={styles.carouselCell} onClick={() => handleClick(carouselIndex)}>
            {media[carouselIndex] && renderMedia(media[carouselIndex], styles.carouselImage)}
          </button>
          {count > 1 && (
            <div className={styles.carouselControls}>
              <button
                type="button"
                className={styles.carouselArrow}
                onClick={(e) => { e.stopPropagation(); setCarouselIndex((carouselIndex - 1 + count) % count); }}
              >
                ‹
              </button>
              <span className={styles.carouselCounter}>{carouselIndex + 1} / {count}</span>
              <button
                type="button"
                className={styles.carouselArrow}
                onClick={(e) => { e.stopPropagation(); setCarouselIndex((carouselIndex + 1) % count); }}
              >
                ›
              </button>
            </div>
          )}
          {count > 1 && (
            <div className={styles.carouselDots}>
              {media.map((item, i) => (
                <button
                  key={`${item.id}-${i}`}
                  type="button"
                  className={`${styles.carouselDot} ${i === carouselIndex ? styles.carouselDotActive : ''}`}
                  onClick={(e) => { e.stopPropagation(); setCarouselIndex(i); }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {layout === 'stack' && media.length > 1 && (
        <>
          <div className={styles.layoutStack} ref={stackRef}>
            {stackVisible.map((item, i) => {
              const isActive = i === stackIndex;
              return (
                <button
                  key={`${item.id}-${i}`}
                  type="button"
                  className={styles.stackCell}
                  style={{
                    '--stack-i': i,
                    '--stack-total': stackVisibleCount,
                    zIndex: isActive ? stackVisibleCount + 1 : stackVisibleCount - i,
                  } as React.CSSProperties}
                  onClick={() => handleClick(stackStart + i)}
                >
                  {renderMedia(item, styles.stackImage)}
                </button>
              );
            })}
          </div>
          {stackVisibleCount > 1 && (
            <div className={styles.stackControls}>
              {stackTotalPages > 1 && (
                <button
                  type="button"
                  className={styles.stackPageArrow}
                  disabled={stackPage === 0}
                  onClick={(e) => { e.stopPropagation(); setStackPage(p => Math.max(0, p - 1)); setStackIndex(0); }}
                >
                  ‹
                </button>
              )}
              <button
                type="button"
                className={styles.carouselArrow}
                onClick={(e) => { e.stopPropagation(); setStackIndex((stackIndex - 1 + stackVisibleCount) % stackVisibleCount); }}
              >
                ‹
              </button>
              <span className={styles.carouselCounter}>{stackIndex + 1} / {stackVisibleCount}</span>
              <button
                type="button"
                className={styles.carouselArrow}
                onClick={(e) => { e.stopPropagation(); setStackIndex((stackIndex + 1) % stackVisibleCount); }}
              >
                ›
              </button>
              {stackTotalPages > 1 && (
                <button
                  type="button"
                  className={styles.stackPageArrow}
                  disabled={stackPage >= stackTotalPages - 1}
                  onClick={(e) => { e.stopPropagation(); setStackPage(p => Math.min(stackTotalPages - 1, p + 1)); setStackIndex(0); }}
                >
                  ›
                </button>
              )}
              {stackTotalPages > 1 && count - stackEnd > 0 && (
                <span className={styles.stackRemaining}>+{count - stackEnd}</span>
              )}
            </div>
          )}
        </>
      )}
        </>
      ) : (
        (() => {
          if (layout === 'grid') {
            return (
              <>
                <div className={`${styles.grid} ${styles.layoutGrid} ${gridVisible.length <= 2 ? styles.grid2 : gridVisible.length <= 4 ? styles.grid2x2 : styles.grid3x3}`}>
                  {gridVisible.map((item, i) => renderEditCell(item, gridRange.start + i, styles.cell, styles.image))}
                </div>
                {renderPageZones(gridPage, gridTotalPages, GRID_PAGE_SIZE)}
                <Pagination page={gridPage} totalPages={gridTotalPages} onPageChange={setGridPage} />
              </>
            );
          }
          if (layout === 'masonry') {
            return (
              <>
                <div className={`${styles.grid} ${styles.layoutMasonry}`}>
                  {masonryVisible.map((item, i) => {
                    const ratio = aspectRatiosRef.current.get(item.id);
                    return renderEditCell(
                      item,
                      masonryRange.start + i,
                      styles.cellMasonry,
                      styles.imageMasonry,
                      ratio ? { aspectRatio: ratio } : undefined,
                    );
                  })}
                </div>
                {renderPageZones(masonryPage, masonryTotalPages, MASONRY_PAGE_SIZE)}
                <Pagination page={masonryPage} totalPages={masonryTotalPages} onPageChange={setMasonryPage} />
              </>
            );
          }
          if (layout === 'gallery') {
            return (
              <>
                <div className={`${styles.grid} ${styles.layoutGallery}`}>
                  {galleryVisible.map((item, i) => renderEditCell(item, galleryRange.start + i, styles.cellGallery, styles.imageGallery))}
                </div>
                {renderPageZones(galleryPage, galleryTotalPages, GALLERY_PAGE_SIZE)}
                <Pagination page={galleryPage} totalPages={galleryTotalPages} onPageChange={setGalleryPage} />
              </>
            );
          }
          if (layout === 'bento') {
            return (
              <>
                <div className={`${styles.grid} ${styles.layoutBento}`}>
                  {bentoVisible.map((item, i) => {
                    const size = BENTO_PATTERN[i % BENTO_PATTERN.length];
                    const sizeClass = size === 'large'
                      ? styles.cellBentoLarge
                      : size === 'wide'
                        ? styles.cellBentoWide
                        : styles.cellBentoNormal;
                    return renderEditCell(item, bentoRange.start + i, `${styles.cellBento} ${sizeClass}`, styles.image);
                  })}
                </div>
                {renderPageZones(bentoPage, bentoTotalPages, BENTO_PAGE_SIZE)}
                <Pagination page={bentoPage} totalPages={bentoTotalPages} onPageChange={setBentoPage} />
              </>
            );
          }
          if (layout === 'featured') {
            return (
              <>
                <div className={`${styles.grid} ${styles.layoutFeatured}`}>
                  {activeMedia[0] && renderEditCell(activeMedia[0], 0, styles.cellFeaturedMain, styles.image)}
                  {activeMedia.length > 1 && (
                    <div className={styles.featuredRow}>
                      {featuredThumbs.map((item, i) => {
                        const actualIndex = 1 + featuredThumbRange.start + i;
                        return renderEditCell(item, actualIndex, styles.cellFeaturedThumb, styles.image);
                      })}
                    </div>
                  )}
                </div>
                {renderPageZones(featuredPage, featuredTotalPages, FEATURED_THUMB_PAGE_SIZE, 1)}
                <Pagination page={featuredPage} totalPages={featuredTotalPages} onPageChange={setFeaturedPage} />
              </>
            );
          }
          return (
            <div className={styles.editGrid}>
              {(editItems ?? []).map((item, i) => renderEditCell(item, i, styles.editCell, styles.editCellImage))}
            </div>
          );
        })()
      )}

      {pendingUploads.length > 0 && (
        <div className={styles.pendingUploads}>
          {pendingUploads.map((u) => {
            const previewUrl = objectUrlsRef.current.get(u.key);
            return (
              <div key={u.key} className={`${styles.pendingUpload} ${u.status === 'error' ? styles.pendingUploadError : ''}`}>
                <div className={styles.pendingThumb}>
                  {previewUrl ? (
                    <img src={previewUrl} alt={u.file.name} />
                  ) : (
                    <div className={styles.pendingThumbIcon}>
                      {FILE_ICONS[getFileIcon(u.file.type)] ?? FILE_ICONS.file}
                    </div>
                  )}
                </div>
                <div className={styles.pendingInfo}>
                  <span className={styles.pendingName} title={u.file.name}>{u.file.name}</span>
                  <div className={styles.pendingBar}>
                    <div className={styles.pendingBarFill} style={{ width: `${u.status === 'error' ? 0 : u.progress}%` }} />
                  </div>
                  <span className={styles.pendingStatus}>
                    {u.status === 'error'
                      ? 'Upload failed'
                      : u.status === 'done'
                        ? 'Ready — press Done to add'
                        : `${u.progress}% · ${formatFileSize(u.file.size)}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Portal>
        <MediaViewer
          src={activeIndex !== null ? (urls.get(media[activeIndex]?.id) ?? null) : null}
          alt={activeIndex !== null ? media[activeIndex]?.file_name : ''}
          type={activeIndex !== null ? getMediaType(media[activeIndex]) : 'image'}
          openUrl={activeIndex !== null && getMediaType(media[activeIndex]) === 'link' ? media[activeIndex]?.file_url : undefined}
          open={activeIndex !== null}
          onClose={() => setActiveIndex(null)}
          items={viewerItems}
          currentIndex={activeIndex ?? 0}
          onNavigate={setActiveIndex}
        />
      </Portal>
    </div>
  );
});

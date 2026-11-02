import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { Portal } from './Portal';

export type FloatingPlacement =
  | 'bottom-start' | 'bottom' | 'bottom-end'
  | 'top-start' | 'top' | 'top-end'
  | 'right-start' | 'right' | 'right-end' | 'left-start' | 'left' | 'left-end';

interface FloatingProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  open: boolean;
  /** Element the layer is positioned against, usually its trigger. */
  anchor: RefObject<HTMLElement | null>;
  placement?: FloatingPlacement;
  /** Gap between the anchor and the layer, in pixels. */
  offset?: number;
  /** Make the layer at least as wide as the anchor (select-style menus). */
  matchWidth?: boolean;
  /** Pointer down outside the anchor and the layer, or Escape. */
  onDismiss?: () => void;
  style?: CSSProperties;
  children: ReactNode;
}

interface Position {
  top: number;
  left: number;
  maxHeight?: number;
  minWidth?: number;
}

const MARGIN = 8;

function place(anchor: DOMRect, width: number, height: number, placement: FloatingPlacement, offset: number): Position {
  const [side, align = 'center'] = placement.split('-') as [string, string?];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top: number;
  let left: number;
  let maxHeight: number | undefined;

  if (side === 'bottom' || side === 'top') {
    const below = vh - anchor.bottom - offset - MARGIN;
    const above = anchor.top - offset - MARGIN;
    // Flip only when the preferred side is too short and the other has more room.
    let actual = side;
    if (side === 'bottom' && height > below && above > below) actual = 'top';
    if (side === 'top' && height > above && below > above) actual = 'bottom';
    const room = Math.max(120, actual === 'bottom' ? below : above);
    if (height > room) maxHeight = room;
    const shown = Math.min(height, room);
    top = actual === 'bottom' ? anchor.bottom + offset : anchor.top - offset - shown;
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.right - width : anchor.left + (anchor.width - width) / 2;
  } else {
    const fitsRight = anchor.right + offset + width <= vw - MARGIN;
    const fitsLeft = anchor.left - offset - width >= MARGIN;
    const actual = side === 'right' ? (fitsRight || !fitsLeft ? 'right' : 'left') : (fitsLeft || !fitsRight ? 'left' : 'right');
    left = actual === 'right' ? anchor.right + offset : anchor.left - offset - width;
    top = align === 'end' ? anchor.bottom - height : anchor.top;
    if (height > vh - 2 * MARGIN) maxHeight = vh - 2 * MARGIN;
  }

  const shownHeight = Math.min(height, maxHeight ?? height);
  return {
    top: Math.max(MARGIN, Math.min(top, vh - shownHeight - MARGIN)),
    left: Math.max(MARGIN, Math.min(left, vw - width - MARGIN)),
    maxHeight,
  };
}

/**
 * A menu, list or popover that must sit above everything around its trigger.
 * It renders in a portal (so no scroll container or stacking context can clip
 * or cover it), is positioned against `anchor` before the first paint, flips
 * and shifts to stay on screen, and follows scrolling and resizing.
 *
 * The layer's DOM is outside the trigger's container: outside-click checks
 * must include it (use `onDismiss`, or test the forwarded ref).
 */
export const Floating = forwardRef<HTMLDivElement, FloatingProps>(function Floating(
  { open, anchor, placement = 'bottom-start', offset = 6, matchWidth = false, onDismiss, style, children, ...rest },
  forwardedRef,
) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismissible = Boolean(onDismiss);

  const setRefs = useCallback((node: HTMLDivElement | null) => {
    layerRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const update = useCallback(() => {
    const anchorEl = anchor.current;
    const layer = layerRef.current;
    if (!anchorEl || !layer) return;
    const rect = anchorEl.getBoundingClientRect();
    const minWidth = matchWidth ? rect.width : undefined;
    const width = Math.max(layer.offsetWidth, minWidth ?? 0);
    const next = { ...place(rect, width, layer.scrollHeight, placement, offset), minWidth };
    setPosition((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight && prev.minWidth === next.minWidth
        ? prev
        : next,
    );
  }, [anchor, placement, offset, matchWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    update();
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (layerRef.current) observer?.observe(layerRef.current);
    if (anchor.current) observer?.observe(anchor.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [open, update, anchor]);

  useEffect(() => {
    if (!open || !dismissible) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (layerRef.current?.contains(target) || anchor.current?.contains(target)) return;
      dismissRef.current?.();
    };
    // Capture phase: Escape closes this layer only, not a dialog behind it.
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismissRef.current?.();
    };
    document.addEventListener('pointerdown', handlePointer, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open, dismissible, anchor]);

  if (!open) return null;

  return (
    <Portal>
      <div
        ref={setRefs}
        data-floating-layer=""
        {...rest}
        style={{
          zIndex: 'var(--z-dropdown)',
          ...style,
          position: 'fixed',
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          right: 'auto',
          bottom: 'auto',
          margin: 0,
          transform: 'none',
          maxHeight: position?.maxHeight,
          overflowY: position?.maxHeight ? 'auto' : undefined,
          minWidth: position?.minWidth,
          // Until measured (normally never painted): invisible but still focusable,
          // so a layer that focuses itself on mount keeps working.
          opacity: position ? undefined : 0,
          pointerEvents: position ? undefined : 'none',
        }}
      >
        {children}
      </div>
    </Portal>
  );
});

/** True when `target` is inside any floating layer (for existing outside-click checks). */
export function isInFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-floating-layer]'));
}

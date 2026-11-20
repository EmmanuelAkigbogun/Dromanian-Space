import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent,
} from 'react';
import { Portal } from '@/lib/overlay/Portal';
import styles from './ContextMenu.module.css';

interface ContextMenuContextValue {
  open: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  onOpen: (x: number, y: number) => void;
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

function useContextMenuContext() {
  const context = useContext(ContextMenuContext);
  if (!context) throw new Error('ContextMenu components must be used within ContextMenuProvider');
  return context;
}

/** Opens the surrounding menu from a button (null outside a menu). */
export function useOpenContextMenu(): ((x: number, y: number) => void) | null {
  return useContext(ContextMenuContext)?.onOpen ?? null;
}

interface ContextMenuProviderProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

function Provider({ children, onOpenChange }: ContextMenuProviderProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const onOpen = useCallback((x: number, y: number) => {
    setPosition({ x, y });
    setOpenState(true);
  }, [setOpenState]);

  const onClose = useCallback(() => setOpenState(false), [setOpenState]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = () => onClose();
    const handleKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    // Listen from the next tick, so the click that opened the menu from a
    // button does not reach this listener and close it again.
    const listen = setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(listen);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const value = useMemo(
    () => ({ open, position, onOpen, onClose }),
    [open, position, onOpen, onClose],
  );

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
    </ContextMenuContext.Provider>
  );
}

interface TriggerProps {
  children: ReactNode;
  asChild?: boolean;
}

function Trigger({ children, asChild }: TriggerProps) {
  const { onOpen } = useContextMenuContext();

  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    onOpen(event.clientX, event.clientY);
  };

  // Long-press opens the menu on touch screens that never send a right-click (iOS).
  const touch = {
    onTouchStart: (event: React.TouchEvent) => {
      if (event.touches.length !== 1) return;
      const { clientX: x, clientY: y } = event.touches[0];
      const state = { x, y, fired: false, timer: setTimeout(() => { state.fired = true; onOpen(x, y); }, 500) };
      press.current = state;
    },
    onTouchMove: (event: React.TouchEvent) => {
      const state = press.current;
      if (!state) return;
      const t = event.touches[0];
      if (Math.abs(t.clientX - state.x) > 10 || Math.abs(t.clientY - state.y) > 10) {
        clearTimeout(state.timer);
        press.current = null;
      }
    },
    onTouchEnd: (event: React.TouchEvent) => {
      const state = press.current;
      press.current = null;
      if (!state) return;
      clearTimeout(state.timer);
      // Keep the tap that ends a long-press from closing the menu it opened.
      if (state.fired) event.preventDefault();
    },
  };

  if (asChild && typeof children === 'object' && children !== null && 'props' in children) {
    const child = children as React.ReactElement<Record<string, unknown>>;
    return (
      <span onContextMenu={handleContextMenu} {...touch} className={styles.trigger}>
        {child}
      </span>
    );
  }

  return (
    <div onContextMenu={handleContextMenu} {...touch} className={styles.trigger}>
      {children}
    </div>
  );
}

function Content({ children }: { children: ReactNode }) {
  const { open, position } = useContextMenuContext();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !contentRef.current) return;

    const content = contentRef.current;
    let { x, y } = position;

    // Keep within viewport
    const rect = content.getBoundingClientRect();
    x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));

    content.style.left = `${x}px`;
    content.style.top = `${y}px`;
  }, [open, position]);

  if (!open) return null;

  return (
    <Portal>
      <div ref={contentRef} className={styles.content} role="menu">
        {children}
      </div>
    </Portal>
  );
}

interface ItemProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

function Item({ children, onClick, disabled }: ItemProps) {
  const { onClose } = useContextMenuContext();

  const handleClick = () => {
    if (disabled) return;
    onClick?.();
    onClose();
  };

  return (
    <button
      type="button"
      className={styles.item}
      role="menuitem"
      onClick={handleClick}
      disabled={disabled}
      tabIndex={-1}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className={styles.separator} role="separator" />;
}

interface LabelProps {
  children: ReactNode;
}

function Label({ children }: LabelProps) {
  return <div className={styles.label}>{children}</div>;
}

export { Provider, Trigger, Content, Item, Separator, Label };

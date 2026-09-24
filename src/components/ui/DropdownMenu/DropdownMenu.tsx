import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent,
} from 'react';
import { Portal } from '@/lib/overlay/Portal';
import styles from './DropdownMenu.module.css';

interface DropdownContextValue {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

function useDropdownContext() {
  const context = useContext(DropdownContext);
  if (!context) throw new Error('Dropdown components must be used within DropdownMenu');
  return context;
}

interface DropdownMenuProps {
  children: ReactNode;
}

function DropdownMenu({ children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => setOpen(false), []);
  const onToggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent | globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  return (
    <DropdownContext.Provider value={{ open, triggerRef, onOpen, onClose, onToggle }}>
      <div className={styles.dropdown}>{children}</div>
    </DropdownContext.Provider>
  );
}

interface TriggerProps {
  children: ReactNode;
  asChild?: boolean;
}

function Trigger({ children, asChild }: TriggerProps) {
  const { triggerRef, onToggle } = useDropdownContext();

  if (asChild && typeof children === 'object' && children !== null && 'props' in children) {
    const child = children as React.ReactElement<Record<string, unknown>>;
    return (
      <span ref={triggerRef as React.RefObject<HTMLSpanElement>}>
        {child}
      </span>
    );
  }

  return (
    <button
      ref={triggerRef as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={onToggle}
      aria-haspopup="true"
    >
      {children}
    </button>
  );
}

interface ContentProps {
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

function Content({ children, side = 'bottom', align = 'start', sideOffset = 4 }: ContentProps) {
  const { open, triggerRef } = useDropdownContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !triggerRef.current || !contentRef.current) return;

    const trigger = triggerRef.current.getBoundingClientRect();
    const content = contentRef.current.getBoundingClientRect();

    let top = side === 'bottom' ? trigger.bottom + sideOffset : trigger.top - content.height - sideOffset;
    let left = align === 'start' ? trigger.left : align === 'end' ? trigger.right - content.width : trigger.left + (trigger.width - content.width) / 2;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - content.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - content.height - 8));

    setPosition({ top, left });
  }, [open, side, align, sideOffset, triggerRef]);

  if (!open) return null;

  return (
    <Portal>
      <div
        ref={contentRef}
        className={styles.content}
        role="menu"
        data-side={side}
        style={{ top: position.top, left: position.left }}
      >
        {children}
      </div>
    </Portal>
  );
}

interface ItemProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
}

function Item({ children, onClick, disabled, selected }: ItemProps) {
  const { onClose } = useDropdownContext();
  const highlightedRef = useRef(false);

  const handleClick = () => {
    if (disabled) return;
    onClick?.();
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  };

  const handleMouseEnter = () => {
    highlightedRef.current = true;
  };

  const handleMouseLeave = () => {
    highlightedRef.current = false;
  };

  return (
    <button
      type="button"
      className={styles.item}
      role="menuitem"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      disabled={disabled}
      data-selected={selected ? '' : undefined}
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

export { DropdownMenu, Trigger, Content, Item, Separator, Label };

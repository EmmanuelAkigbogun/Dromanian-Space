import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
  type ReactElement,
} from 'react';
import { Portal } from '@/lib/overlay/Portal';
import styles from './Popover.module.css';

type PopoverSide = 'top' | 'bottom' | 'left' | 'right';
type PopoverAlign = 'start' | 'center' | 'end';

interface PopoverContextValue {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onToggle: () => void;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext() {
  const context = useContext(PopoverContext);
  if (!context) throw new Error('Popover components must be used within Popover');
  return context;
}

interface PopoverProps {
  children: ReactNode;
  defaultOpen?: boolean;
}

function Popover({ children, defaultOpen = false }: PopoverProps) {
  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLElement>(null);

  const onOpen = useCallback(() => setOpen(true), []);
  const onClose = useCallback(() => setOpen(false), []);
  const onToggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current && !triggerRef.current.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  return (
    <PopoverContext.Provider value={{ open, triggerRef, onOpen, onClose, onToggle }}>
      {children}
    </PopoverContext.Provider>
  );
}

interface TriggerProps {
  children: ReactElement;
  asChild?: boolean;
}

function Trigger({ children, asChild }: TriggerProps) {
  const { triggerRef, onToggle } = usePopoverContext();

  const handleClick = () => onToggle();

  if (asChild) {
    return (
      <span ref={triggerRef as React.RefObject<HTMLSpanElement>}>
        {children}
      </span>
    );
  }

  return (
    <button
      ref={triggerRef as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={handleClick}
      aria-haspopup="dialog"
    >
      {children}
    </button>
  );
}

interface ContentProps {
  children: ReactNode;
  side?: PopoverSide;
  align?: PopoverAlign;
  sideOffset?: number;
  showArrow?: boolean;
}

function Content({
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 8,
  showArrow = false,
}: ContentProps) {
  const { open, triggerRef } = usePopoverContext();
  const contentRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !triggerRef.current || !contentRef.current) return;

    const trigger = triggerRef.current.getBoundingClientRect();
    const content = contentRef.current.getBoundingClientRect();

    let top = 0;
    let left = 0;

    switch (side) {
      case 'bottom':
        top = trigger.bottom + sideOffset;
        break;
      case 'top':
        top = trigger.top - content.height - sideOffset;
        break;
      case 'left':
        left = trigger.left - content.width - sideOffset;
        break;
      case 'right':
        left = trigger.right + sideOffset;
        break;
    }

    if (side === 'bottom' || side === 'top') {
      switch (align) {
        case 'start':
          left = trigger.left;
          break;
        case 'center':
          left = trigger.left + (trigger.width - content.width) / 2;
          break;
        case 'end':
          left = trigger.right - content.width;
          break;
      }
    } else {
      switch (align) {
        case 'start':
          top = trigger.top;
          break;
        case 'center':
          top = trigger.top + (trigger.height - content.height) / 2;
          break;
        case 'end':
          top = trigger.bottom - content.height;
          break;
      }
    }

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
        role="dialog"
        aria-modal="false"
        style={{ top: position.top, left: position.left }}
      >
        {showArrow && <div ref={arrowRef} className={styles.arrow} data-side={side} />}
        {children}
      </div>
    </Portal>
  );
}

function Close({ children, asChild }: { children: ReactElement; asChild?: boolean }) {
  const { onClose } = usePopoverContext();

  if (asChild) {
    return children;
  }

  return (
    <button type="button" onClick={onClose}>
      {children}
    </button>
  );
}

export { Popover, Trigger, Content, Close };

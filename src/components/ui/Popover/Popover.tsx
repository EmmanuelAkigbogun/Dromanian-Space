import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  type ReactNode,
  type ReactElement,
} from 'react';
import { Floating, type FloatingPlacement } from '@/lib/overlay/Floating';
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

  // Outside clicks and Escape are handled by the floating content, which
  // counts clicks inside the popover as inside (it is portaled out of this tree).

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
      <span ref={triggerRef as React.RefObject<HTMLSpanElement>} onClick={handleClick}>
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
  const { open, triggerRef, onClose } = usePopoverContext();
  const placement = (align === 'center' ? side : `${side}-${align}`) as FloatingPlacement;

  return (
    <Floating
      open={open}
      anchor={triggerRef}
      placement={placement}
      offset={sideOffset}
      onDismiss={onClose}
      className={styles.content}
      role="dialog"
      aria-modal="false"
      style={{ zIndex: 'var(--z-popover)' }}
    >
      {showArrow && <div className={styles.arrow} data-side={side} />}
      {children}
    </Floating>
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

import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { Floating, type FloatingPlacement } from '@/lib/overlay/Floating';
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
  // Outside clicks and Escape are handled by the floating content, which
  // counts clicks inside the menu as inside (it is portaled out of this tree).

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
      <span ref={triggerRef as React.RefObject<HTMLSpanElement>} onClick={onToggle}>
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
  const { open, triggerRef, onClose } = useDropdownContext();
  const placement = (align === 'center' ? side : `${side}-${align}`) as FloatingPlacement;

  return (
    <Floating
      open={open}
      anchor={triggerRef}
      placement={placement}
      offset={sideOffset}
      onDismiss={onClose}
      className={styles.content}
      role="menu"
      data-side={side}
    >
      {children}
    </Floating>
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

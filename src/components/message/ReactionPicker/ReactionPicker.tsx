import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import { MESSAGE_REACTIONS } from './reactions';
import styles from './ReactionPicker.module.css';

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  position?: { x: number; y: number };
}

const PICKER_WIDTH = 296;
const PICKER_HEIGHT = 58;
const VIEWPORT_MARGIN = 8;

export const ReactionPicker = memo(function ReactionPicker({
  onSelect,
  onClose,
  anchorRef,
  position,
}: ReactionPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    buttonRefs.current[0]?.focus();

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !pickerRef.current?.contains(target) &&
        !anchorRef?.current?.contains(target)
      ) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        anchorRef?.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, onClose]);

  const pickerStyle = useMemo(() => {
    const anchorRect = anchorRef?.current?.getBoundingClientRect();
    let x = position?.x ?? anchorRect?.left ?? VIEWPORT_MARGIN;
    let y = position?.y ?? (anchorRect ? anchorRect.bottom + VIEWPORT_MARGIN : VIEWPORT_MARGIN);

    if (x + PICKER_WIDTH + VIEWPORT_MARGIN > window.innerWidth) {
      x = window.innerWidth - PICKER_WIDTH - VIEWPORT_MARGIN;
    }
    if (y + PICKER_HEIGHT + VIEWPORT_MARGIN > window.innerHeight) {
      y = (anchorRect?.top ?? y) - PICKER_HEIGHT - VIEWPORT_MARGIN;
    }

    return {
      left: Math.max(VIEWPORT_MARGIN, x),
      top: Math.max(VIEWPORT_MARGIN, y),
    };
  }, [anchorRef, position]);

  const handleSelect = useCallback((emoji: string) => {
    onSelect(emoji);
    onClose();
    anchorRef?.current?.focus();
  }, [anchorRef, onClose, onSelect]);

  const handlePickerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = buttonRefs.current.findIndex((button) => button === document.activeElement);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % MESSAGE_REACTIONS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + MESSAGE_REACTIONS.length) % MESSAGE_REACTIONS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = MESSAGE_REACTIONS.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      buttonRefs.current[nextIndex]?.focus();
    }
  }, []);

  return (
    <Portal>
      <div
        ref={pickerRef}
        className={styles.picker}
        style={pickerStyle}
        role="dialog"
        aria-label="Choose a reaction"
        onKeyDown={handlePickerKeyDown}
      >
        {MESSAGE_REACTIONS.map(({ emoji, label }, index) => (
          <button
            key={emoji}
            ref={(node) => { buttonRefs.current[index] = node; }}
            type="button"
            className={styles.reaction}
            onClick={() => handleSelect(emoji)}
            title={label}
            aria-label={`React with ${label}`}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>
    </Portal>
  );
});

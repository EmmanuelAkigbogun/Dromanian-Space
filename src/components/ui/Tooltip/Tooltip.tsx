import { useState, useRef, type ReactNode } from 'react';
import styles from './Tooltip.module.css';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: string;
  position?: TooltipPosition;
  children: ReactNode;
}

export function Tooltip({ content, position = 'top', children }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    timeoutRef.current = setTimeout(() => setIsVisible(true), 300);
  };

  const hide = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  };

  return (
    <div
      className={styles.tooltipWrapper}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <div
        className={`${styles.tooltip} ${isVisible ? styles.visible : ''} ${styles[position]}`}
        role="tooltip"
      >
        {content}
      </div>
    </div>
  );
}

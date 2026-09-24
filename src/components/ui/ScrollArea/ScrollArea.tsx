import { forwardRef, type HTMLAttributes } from 'react';
import styles from './ScrollArea.module.css';

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  horizontal?: boolean;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ horizontal = false, className, children, ...props }, ref) => {
    const classes = [styles.scrollArea, horizontal && styles.horizontal, className].filter(Boolean).join(' ');

    return (
      <div ref={ref} className={classes} {...props}>
        <div className={styles.content}>{children}</div>
      </div>
    );
  },
);

ScrollArea.displayName = 'ScrollArea';

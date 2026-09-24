import { forwardRef, type ButtonHTMLAttributes } from 'react';
import styles from './IconButton.module.css';

type IconButtonSize = 'sm' | 'md' | 'lg';
type IconButtonVariant = 'default' | 'primary' | 'danger';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size = 'md', variant = 'default', label, className, children, ...props }, ref) => {
    const classes = [styles.iconButton, styles[size], variant !== 'default' && styles[variant], className]
      .filter(Boolean)
      .join(' ');

    return (
      <button ref={ref} className={classes} aria-label={label} type="button" {...props}>
        {children}
      </button>
    );
  },
);

IconButton.displayName = 'IconButton';

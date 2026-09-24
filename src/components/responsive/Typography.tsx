import type { ReactNode } from 'react';
import styles from './Typography.module.css';

type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4';
type TextSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';

interface ResponsiveTextProps {
  children: ReactNode;
  as?: 'p' | 'span' | 'div';
  size?: TextSize;
  className?: string;
}

export function ResponsiveText({ children, as: Component = 'p', size = 'base', className }: ResponsiveTextProps) {
  const sizeClass = {
    xs: styles.textXs,
    sm: styles.textSm,
    base: styles.textBase,
    lg: styles.textLg,
    xl: styles.textXl,
    '2xl': styles.text2xl,
    '3xl': styles.text3xl,
    '4xl': styles.text4xl,
  }[size];

  return (
    <Component className={`${styles.text} ${sizeClass} ${className || ''}`}>
      {children}
    </Component>
  );
}

interface ResponsiveHeadingProps {
  children: ReactNode;
  level?: HeadingLevel;
  className?: string;
}

export function ResponsiveHeading({ children, level = 'h1', className }: ResponsiveHeadingProps) {
  const levelClass = {
    h1: styles.heading1,
    h2: styles.heading2,
    h3: styles.heading3,
    h4: styles.heading4,
  }[level];

  const Component = level;

  return (
    <Component className={`${levelClass} ${className || ''}`}>
      {children}
    </Component>
  );
}

import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme';

import styles from './AuthLayout.module.css';

interface AuthLayoutProps {
  children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className={styles.authLayout}>
      <div className={styles.authThemeToggle}>
        <ThemeToggle />
      </div>
      <div className={styles.authCard}>
        {children}
      </div>
    </div>
  );
}

interface AuthHeaderProps {
  title: string;
  subtitle?: string;
}

export function AuthHeader({ title, subtitle }: AuthHeaderProps) {
  return (
    <div className={styles.authHeader}>
      <div className={styles.authLogo}>
        <span style={{ fontSize: '24px', lineHeight: 1 }}>❀</span>
      </div>
      <h1 className={styles.authTitle}>{title}</h1>
      {subtitle && <p className={styles.authSubtitle}>{subtitle}</p>}
    </div>
  );
}

interface AuthErrorProps {
  message: string;
}

export function AuthError({ message }: AuthErrorProps) {
  return (
    <div className={styles.authError} role="alert">
      {message}
    </div>
  );
}

interface AuthSuccessProps {
  message: string;
}

export function AuthSuccess({ message }: AuthSuccessProps) {
  return (
    <div className={styles.authSuccess} role="status">
      {message}
    </div>
  );
}

interface AuthFooterProps {
  text: string;
  linkText: string;
  linkTo: string;
}

export function AuthFooter({ text, linkText, linkTo }: AuthFooterProps) {
  return (
    <div className={styles.authFooter}>
      <p className={styles.authFooterText}>
        {text}{' '}
        <a href={linkTo} className={styles.authFooterLink}>
          {linkText}
        </a>
      </p>
    </div>
  );
}

interface AuthDividerProps {
  text?: string;
}

export function AuthDivider({ text = 'or' }: AuthDividerProps) {
  return (
    <div className={styles.authDivider}>
      <div className={styles.authDividerLine} />
      <span className={styles.authDividerText}>{text}</span>
      <div className={styles.authDividerLine} />
    </div>
  );
}

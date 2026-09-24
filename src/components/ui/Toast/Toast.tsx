import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { Portal } from '@/lib/overlay/Portal';
import styles from './Toast.module.css';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastData {
  id: string;
  title?: string;
  description: string;
  variant: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  toast: (props: Omit<ToastData, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

interface ToastProviderProps {
  children: ReactNode;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
}

export function ToastProvider({ children, position = 'bottom-right' }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const toast = useCallback((props: Omit<ToastData, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...props, id }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const positionStyles = {
    'top-right': { top: 'var(--space-4)', right: 'var(--space-4)' },
    'top-left': { top: 'var(--space-4)', left: 'var(--space-4)' },
    'bottom-right': { bottom: 'var(--space-4)', right: 'var(--space-4)' },
    'bottom-left': { bottom: 'var(--space-4)', left: 'var(--space-4)' },
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <Portal>
        <div className={styles.viewport} style={positionStyles[position]} role="region" aria-label="Notifications">
          {toasts.map((t) => (
            <Toast key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

interface ToastProps extends ToastData {
  onDismiss: () => void;
}

function Toast({ title, description, variant, duration = 5000, onDismiss }: ToastProps) {
  const [state, setState] = useState<'open' | 'closed'>('open');

  useEffect(() => {
    const timer = setTimeout(() => {
      setState('closed');
      setTimeout(onDismiss, 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const handleClose = () => {
    setState('closed');
    setTimeout(onDismiss, 300);
  };

  const iconPath = {
    success: 'M20 6L9 17l-5-5',
    error: 'M18 6L6 18M6 6l12 12',
    warning: 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
    info: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 14v-4m0-4h.01',
  };

  return (
    <div className={styles.toast} data-state={state} data-variant={variant} role="alert">
      <svg className={styles.toastIcon} data-variant={variant} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={iconPath[variant]} />
      </svg>
      <div className={styles.toastContent}>
        {title && <div className={styles.toastTitle}>{title}</div>}
        <div className={styles.toastDescription}>{description}</div>
      </div>
      <button type="button" className={styles.toastClose} onClick={handleClose} aria-label="Dismiss notification">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

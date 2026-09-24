import { useEffect, useRef, useCallback } from 'react';

let overlayCount = 0;

export function useOverlayStack(isActive: boolean) {
  const idRef = useRef<number>(++overlayCount);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      const customEvent = new CustomEvent('overlay:escape', {
        bubbles: true,
        detail: { id: idRef.current },
      });
      document.dispatchEvent(customEvent);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;

    // Add body scroll lock
    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + scrollY + 'px';
    document.body.style.width = '100%';

    // Add escape listener
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      // Remove scroll lock
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);

      // Remove escape listener
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isActive, handleKeyDown]);

  return idRef.current;
}

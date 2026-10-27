import { useEffect, useRef } from 'react';

let overlayCount = 0;
let activeScrollLocks = 0;
let lockedScrollY = 0;
let previousBodyStyles: Pick<CSSStyleDeclaration, 'overflow' | 'position' | 'top' | 'width'> | null = null;

export function useOverlayStack(isActive: boolean) {
  const idRef = useRef<number>(0);
  if (idRef.current === 0) idRef.current = ++overlayCount;

  useEffect(() => {
    if (!isActive) return;

    if (activeScrollLocks === 0) {
      lockedScrollY = window.scrollY;
      previousBodyStyles = {
        overflow: document.body.style.overflow,
        position: document.body.style.position,
        top: document.body.style.top,
        width: document.body.style.width,
      };
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.style.width = '100%';
    }
    activeScrollLocks += 1;

    return () => {
      activeScrollLocks = Math.max(0, activeScrollLocks - 1);
      if (activeScrollLocks !== 0 || !previousBodyStyles) return;

      document.body.style.overflow = previousBodyStyles.overflow;
      document.body.style.position = previousBodyStyles.position;
      document.body.style.top = previousBodyStyles.top;
      document.body.style.width = previousBodyStyles.width;
      previousBodyStyles = null;
      window.scrollTo(0, lockedScrollY);
    };
  }, [isActive]);

  return idRef.current;
}

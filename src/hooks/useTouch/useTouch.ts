import { useState, useEffect, useCallback } from 'react';

export function useTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const checkTouch = () => {
      setIsTouch(
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0
      );
    };

    checkTouch();

    window.addEventListener('resize', checkTouch);
    return () => window.removeEventListener('resize', checkTouch);
  }, []);

  return isTouch;
}

export function useSwipeGesture(
  elementRef: React.RefObject<HTMLElement | null>,
  options: {
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    onSwipeUp?: () => void;
    onSwipeDown?: () => void;
    threshold?: number;
  } = {}
) {
  const { onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, threshold = 50 } = options;

  const handleTouchStart = useCallback((event: TouchEvent) => {
    const touch = event.touches[0];
    const target = event.currentTarget as HTMLElement;
    target.dataset.touchStartX = touch.clientX.toString();
    target.dataset.touchStartY = touch.clientY.toString();
  }, []);

  const handleTouchEnd = useCallback(
    (event: TouchEvent) => {
      const target = event.currentTarget as HTMLElement;
      const startX = parseFloat(target.dataset.touchStartX || '0');
      const startY = parseFloat(target.dataset.touchStartY || '0');
      const endX = event.changedTouches[0].clientX;
      const endY = event.changedTouches[0].clientY;

      const deltaX = endX - startX;
      const deltaY = endY - startY;

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX > threshold && onSwipeRight) {
          onSwipeRight();
        } else if (deltaX < -threshold && onSwipeLeft) {
          onSwipeLeft();
        }
      } else {
        if (deltaY > threshold && onSwipeDown) {
          onSwipeDown();
        } else if (deltaY < -threshold && onSwipeUp) {
          onSwipeUp();
        }
      }
    },
    [onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, threshold]
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchend', handleTouchEnd);
    };
  }, [elementRef, handleTouchStart, handleTouchEnd]);
}

import { useEffect, useRef } from 'react';

interface UseDeepLinkScrollOptions {
  getItemIndex?: (messageId: string) => number | null;
  scrollToIndex?: (index: number) => void;
  onHighlight?: (messageId: string | null) => void;
}

export function useDeepLinkScroll(options?: UseDeepLinkScrollOptions) {
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#message-')) return;
    const messageId = hash.slice('#message-'.length);
    if (!messageId || handledRef.current === messageId) return;

    let cancelled = false;
    let attempts = 0;

    const highlight = () => {
      const el = document.getElementById(`message-${messageId}`);
      if (el) {
        el.classList.add('message-highlight');
        options?.onHighlight?.(messageId);
        setTimeout(() => {
          el.classList.remove('message-highlight');
          options?.onHighlight?.(null);
        }, 2000);
      }
    };

    const attempt = () => {
      if (cancelled) return;

      const index = options?.getItemIndex ? options.getItemIndex(messageId) : null;
      const el = document.getElementById(`message-${messageId}`);

      if (index != null && options?.scrollToIndex) {
        handledRef.current = messageId;
        options.scrollToIndex(index);
        requestAnimationFrame(highlight);
        return;
      }

      if (el) {
        handledRef.current = messageId;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlight();
        return;
      }

      attempts += 1;
      if (attempts < 10) {
        setTimeout(attempt, 300);
      }
    };

    const timer = setTimeout(attempt, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.getItemIndex, options?.scrollToIndex, options?.onHighlight]);
}

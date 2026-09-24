import { useCallback, useMemo } from 'react';

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
}

export type ShareResult = 'native' | 'fallback' | 'cancelled';

function isNativeShareAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// Uses the native Web Share API (mobile, secure contexts) when available and
// falls back to a caller-provided handler otherwise (e.g. the forward dialog).
export function useShareHandler() {
  const canShare = useMemo(() => isNativeShareAvailable(), []);

  const share = useCallback(
    async (payload: SharePayload, fallback?: () => void | Promise<void>): Promise<ShareResult> => {
      if (canShare) {
        try {
          await navigator.share({
            title: payload.title ?? '',
            text: payload.text ?? '',
            url: payload.url ?? '',
          });
          return 'native';
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return 'cancelled';
          // Other errors fall through to the fallback handler.
        }
      }
      if (fallback) {
        await fallback();
        return 'fallback';
      }
      return 'cancelled';
    },
    [canShare],
  );

  return { share, canShare };
}

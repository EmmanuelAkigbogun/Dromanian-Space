import { useMemo } from 'react';
import { useCommandPaletteContextSafe } from '@/app/providers/CommandPaletteProvider';

interface UseCommandPaletteReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const noop = () => {};

const defaultValue: UseCommandPaletteReturn = {
  isOpen: false,
  open: noop,
  close: noop,
  toggle: noop,
};

export function useCommandPalette(): UseCommandPaletteReturn {
  const ctx = useCommandPaletteContextSafe();

  return useMemo(() => {
    if (!ctx) return defaultValue;
    return {
      isOpen: ctx.isOpen,
      open: ctx.open,
      close: ctx.close,
      toggle: ctx.toggle,
    };
  }, [ctx]);
}

import { useEffect, useCallback, useRef } from 'react';
import { useCommandPaletteContextSafe } from '@/app/providers/CommandPaletteProvider';

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  action: () => void;
  description: string;
}

interface UseKeyboardShortcutsOptions {
  shortcuts?: KeyboardShortcut[];
  enabled?: boolean;
}

function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const { shortcuts = [], enabled = true } = options;
  const commandPalette = useCommandPaletteContextSafe();
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      // Ignore if user is typing in an input/textarea
      const target = event.target as HTMLElement;
      const tagName = target.tagName;
      if (
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      // Ctrl/Cmd + K → toggle command palette
      if (isModKey(event) && event.key === 'k') {
        event.preventDefault();
        commandPalette?.toggle();
        return;
      }

      // Escape → close command palette
      if (event.key === 'Escape') {
        if (commandPalette?.isOpen) {
          event.preventDefault();
          commandPalette.close();
          return;
        }
      }

      // Check custom shortcuts
      for (const shortcut of shortcutsRef.current) {
        const ctrlMatch = shortcut.ctrlKey ? isModKey(event) : !isModKey(event);
        const shiftMatch = shortcut.shiftKey ? event.shiftKey : !event.shiftKey;
        const altMatch = shortcut.altKey ? event.altKey : !event.altKey;
        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();

        if (ctrlMatch && shiftMatch && altMatch && keyMatch) {
          event.preventDefault();
          shortcut.action();
          return;
        }
      }
    },
    [enabled, commandPalette],
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleKeyDown]);
}

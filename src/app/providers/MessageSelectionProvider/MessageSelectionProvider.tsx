import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { Message } from '@/types';

interface MessageSelectionContextValue {
  selectedMessages: Message[];
  selectedCount: number;
  isSelected: (messageId: string) => boolean;
  toggleSelected: (message: Message) => void;
  removeSelected: (messageId: string) => void;
  clearSelection: () => void;
}

const MessageSelectionContext = createContext<MessageSelectionContextValue | null>(null);

export function MessageSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, Message>>(new Map());
  const location = useLocation();

  const clearSelection = useCallback(() => {
    setSelected(new Map());
  }, []);

  useEffect(() => {
    clearSelection();
  }, [location.pathname, clearSelection]);

  const toggleSelected = useCallback((message: Message) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(message.id)) next.delete(message.id);
      else next.set(message.id, message);
      return next;
    });
  }, []);

  const removeSelected = useCallback((messageId: string) => {
    setSelected((prev) => {
      if (!prev.has(messageId)) return prev;
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
  }, []);

  const isSelected = useCallback((messageId: string) => selected.has(messageId), [selected]);

  const value = useMemo<MessageSelectionContextValue>(
    () => ({
      selectedMessages: [...selected.values()],
      selectedCount: selected.size,
      isSelected,
      toggleSelected,
      removeSelected,
      clearSelection,
    }),
    [selected, isSelected, toggleSelected, removeSelected, clearSelection],
  );

  return (
    <MessageSelectionContext.Provider value={value}>
      {children}
    </MessageSelectionContext.Provider>
  );
}

export function useMessageSelection(): MessageSelectionContextValue {
  const context = useContext(MessageSelectionContext);
  if (!context) {
    throw new Error('useMessageSelection must be used within a MessageSelectionProvider');
  }
  return context;
}

export function useMessageSelectionSafe(): MessageSelectionContextValue | null {
  return useContext(MessageSelectionContext);
}

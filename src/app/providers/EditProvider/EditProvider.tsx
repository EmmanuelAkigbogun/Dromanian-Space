import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Message } from '@/types';

interface EditContextValue {
  editingMessage: Message | null;
  startEditing: (message: Message) => void;
  cancelEditing: () => void;
}

const EditContext = createContext<EditContextValue | null>(null);

export function EditProvider({ children }: { children: ReactNode }) {
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  const startEditing = useCallback((message: Message) => {
    setEditingMessage(message);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingMessage(null);
  }, []);

  return (
    <EditContext.Provider value={{ editingMessage, startEditing, cancelEditing }}>
      {children}
    </EditContext.Provider>
  );
}

export function useEdit(): EditContextValue {
  const ctx = useContext(EditContext);
  if (!ctx) throw new Error('useEdit must be used within EditProvider');
  return ctx;
}

export function useEditSafe(): EditContextValue | null {
  return useContext(EditContext);
}

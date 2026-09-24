import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Message } from '@/types';

const THREAD_STORAGE_KEY = 'dark-space-thread';

interface ThreadStateContextValue {
  activeThread: Message | null;
  openThread: (message: Message) => void;
  closeThread: () => void;
}

interface ThreadCountsContextValue {
  replyCounts: Map<string, number>;
  setReplyCount: (parentId: string, count: number) => void;
  incrementReplyCount: (parentId: string) => void;
  decrementReplyCount: (parentId: string) => void;
}

const ThreadStateContext = createContext<ThreadStateContextValue | null>(null);
const ThreadCountsContext = createContext<ThreadCountsContextValue | null>(null);

function getStoredThread(): Message | null {
  try {
    const raw = localStorage.getItem(THREAD_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Message;
  } catch {
    return null;
  }
}

function storeThread(message: Message | null): void {
  try {
    if (message) {
      localStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify(message));
    } else {
      localStorage.removeItem(THREAD_STORAGE_KEY);
    }
  } catch {
    // localStorage not available
  }
}

interface ThreadProviderProps {
  children: ReactNode;
}

export function ThreadProvider({ children }: ThreadProviderProps) {
  const [activeThread, setActiveThread] = useState<Message | null>(() => getStoredThread());
  const [replyCounts, setReplyCountsState] = useState<Map<string, number>>(new Map());

  const openThread = useCallback((message: Message) => {
    setActiveThread(message);
    storeThread(message);
  }, []);

  const closeThread = useCallback(() => {
    setActiveThread(null);
    storeThread(null);
  }, []);

  const setReplyCount = useCallback((parentId: string, count: number) => {
    setReplyCountsState((prev) => {
      const next = new Map(prev);
      next.set(parentId, count);
      return next;
    });
  }, []);

  const incrementReplyCount = useCallback((parentId: string) => {
    setReplyCountsState((prev) => {
      const next = new Map(prev);
      next.set(parentId, (next.get(parentId) ?? 0) + 1);
      return next;
    });
  }, []);

  const decrementReplyCount = useCallback((parentId: string) => {
    setReplyCountsState((prev) => {
      const next = new Map(prev);
      const current = next.get(parentId) ?? 0;
      next.set(parentId, Math.max(0, current - 1));
      return next;
    });
  }, []);

  const stateValue = useMemo<ThreadStateContextValue>(
    () => ({
      activeThread,
      openThread,
      closeThread,
    }),
    [activeThread, openThread, closeThread],
  );

  const countsValue = useMemo<ThreadCountsContextValue>(
    () => ({
      replyCounts,
      setReplyCount,
      incrementReplyCount,
      decrementReplyCount,
    }),
    [replyCounts, setReplyCount, incrementReplyCount, decrementReplyCount],
  );

  return (
    <ThreadStateContext.Provider value={stateValue}>
      <ThreadCountsContext.Provider value={countsValue}>
        {children}
      </ThreadCountsContext.Provider>
    </ThreadStateContext.Provider>
  );
}

export function useThread(): ThreadStateContextValue {
  const context = useContext(ThreadStateContext);
  if (!context) {
    throw new Error('useThread must be used within a ThreadProvider');
  }
  return context;
}

export function useThreadSafe(): ThreadStateContextValue | null {
  return useContext(ThreadStateContext);
}

export function useThreadCounts(): ThreadCountsContextValue {
  const context = useContext(ThreadCountsContext);
  if (!context) {
    throw new Error('useThreadCounts must be used within a ThreadProvider');
  }
  return context;
}

export function useThreadCountsSafe(): ThreadCountsContextValue | null {
  return useContext(ThreadCountsContext);
}

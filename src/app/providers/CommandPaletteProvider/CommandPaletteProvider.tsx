import { createContext, useContext, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  category: 'navigation' | 'command' | 'recent';
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  commands: PaletteCommand[];
  registerCommand: (command: PaletteCommand) => void;
  unregisterCommand: (id: string) => void;
  executeCommand: (id: string) => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPaletteContext(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPaletteContext must be used within CommandPaletteProvider');
  return ctx;
}

export function useCommandPaletteContextSafe(): CommandPaletteContextValue | null {
  return useContext(CommandPaletteContext);
}

const RECENT_COMMANDS_KEY = 'dark_space_recent_commands';
const MAX_RECENT = 5;

function loadRecentCommands(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveRecentCommands(commandIds: string[]): void {
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(commandIds.slice(0, MAX_RECENT)));
  } catch {
    // silently fail
  }
}

interface CommandPaletteProviderProps {
  children: ReactNode;
}

export function CommandPaletteProvider({ children }: CommandPaletteProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const commandsRef = useRef<Map<string, PaletteCommand>>(new Map());
  const [commandsVersion, setCommandsVersion] = useState(0);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const registerCommand = useCallback((command: PaletteCommand) => {
    commandsRef.current.set(command.id, command);
    setCommandsVersion((v) => v + 1);
  }, []);

  const unregisterCommand = useCallback((id: string) => {
    commandsRef.current.delete(id);
    setCommandsVersion((v) => v + 1);
  }, []);

  const executeCommand = useCallback(
    (id: string) => {
      const command = commandsRef.current.get(id);
      if (command) {
        command.action();
        // Update recent commands
        const recent = loadRecentCommands().filter((r) => r !== id);
        recent.unshift(id);
        saveRecentCommands(recent);
        setIsOpen(false);
      }
    },
    [],
  );

  const commands = useMemo(() => {
    return Array.from(commandsRef.current.values());
  }, [commandsVersion]);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({
      isOpen,
      open,
      close,
      toggle,
      commands,
      registerCommand,
      unregisterCommand,
      executeCommand,
    }),
    [isOpen, open, close, toggle, commands, registerCommand, unregisterCommand, executeCommand],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

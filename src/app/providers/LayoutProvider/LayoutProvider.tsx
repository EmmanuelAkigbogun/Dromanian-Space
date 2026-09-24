import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSidebar } from '@/hooks/useSidebar';

interface LayoutContextValue {
  isExpanded: boolean;
  isMobileOpen: boolean;
  toggleSidebar: () => void;
  expandSidebar: () => void;
  collapseSidebar: () => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

interface LayoutProviderProps {
  children: ReactNode;
  defaultSidebarExpanded?: boolean;
}

export function LayoutProvider({ children, defaultSidebarExpanded = true }: LayoutProviderProps) {
  const sidebar = useSidebar(defaultSidebarExpanded);

  const value = useMemo<LayoutContextValue>(
    () => ({
      isExpanded: sidebar.isExpanded,
      isMobileOpen: sidebar.isMobileOpen,
      toggleSidebar: sidebar.toggle,
      expandSidebar: sidebar.expand,
      collapseSidebar: sidebar.collapse,
      openMobileSidebar: sidebar.openMobile,
      closeMobileSidebar: sidebar.closeMobile,
    }),
    [sidebar],
  );

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
}

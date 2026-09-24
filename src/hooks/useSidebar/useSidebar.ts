import { useState, useCallback } from 'react';

interface UseSidebarReturn {
  isExpanded: boolean;
  isMobileOpen: boolean;
  toggle: () => void;
  expand: () => void;
  collapse: () => void;
  openMobile: () => void;
  closeMobile: () => void;
}

export function useSidebar(defaultExpanded = true): UseSidebarReturn {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const toggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const expand = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const collapse = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const openMobile = useCallback(() => {
    setIsMobileOpen(true);
  }, []);

  const closeMobile = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  return {
    isExpanded,
    isMobileOpen,
    toggle,
    expand,
    collapse,
    openMobile,
    closeMobile,
  };
}

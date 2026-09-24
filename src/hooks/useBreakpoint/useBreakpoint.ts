import { useMemo } from 'react';
import { useMediaQuery } from '../useMediaQuery';

type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

const BREAKPOINTS = {
  mobile: '(max-width: 639px)',
  tablet: '(min-width: 640px) and (max-width: 1023px)',
  desktop: '(min-width: 1024px) and (max-width: 1439px)',
  wide: '(min-width: 1440px)',
} as const;

export function useBreakpoint(): Breakpoint {
  const isMobile = useMediaQuery(BREAKPOINTS.mobile);
  const isTablet = useMediaQuery(BREAKPOINTS.tablet);
  const isDesktop = useMediaQuery(BREAKPOINTS.desktop);
  const isWide = useMediaQuery(BREAKPOINTS.wide);

  return useMemo(() => {
    if (isMobile) return 'mobile';
    if (isTablet) return 'tablet';
    if (isDesktop) return 'desktop';
    if (isWide) return 'wide';
    return 'desktop';
  }, [isMobile, isTablet, isDesktop, isWide]);
}

export function useIsMobile(): boolean {
  return useMediaQuery(BREAKPOINTS.mobile);
}

export function useIsTablet(): boolean {
  return useMediaQuery(BREAKPOINTS.tablet);
}

export function useIsDesktop(): boolean {
  return useMediaQuery(BREAKPOINTS.desktop);
}

export function useIsWide(): boolean {
  return useMediaQuery(BREAKPOINTS.wide);
}

export function useIsSmallScreen(): boolean {
  return useMediaQuery('(max-width: 1023px)');
}

import type { ReactNode } from 'react';
import { useIsMobile, useIsTablet, useIsDesktop, useIsWide, useIsSmallScreen } from '@/hooks/useBreakpoint';

interface ResponsiveProps {
  children: ReactNode;
  mobile?: ReactNode;
  tablet?: ReactNode;
  desktop?: ReactNode;
  wide?: ReactNode;
  small?: ReactNode;
  large?: ReactNode;
}

export function Responsive({
  children,
  mobile,
  tablet,
  desktop,
  wide,
  small,
  large,
}: ResponsiveProps) {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const isWide = useIsWide();
  const isSmall = useIsSmallScreen();
  const isLarge = !isSmall;

  if (isMobile && mobile) return <>{mobile}</>;
  if (isTablet && tablet) return <>{tablet}</>;
  if (isDesktop && desktop) return <>{desktop}</>;
  if (isWide && wide) return <>{wide}</>;
  if (isSmall && small) return <>{small}</>;
  if (isLarge && large) return <>{large}</>;

  return <>{children}</>;
}

interface ShowAtProps {
  children: ReactNode;
  mobile?: boolean;
  tablet?: boolean;
  desktop?: boolean;
  wide?: boolean;
  small?: boolean;
  large?: boolean;
}

export function ShowAt({ children, mobile, tablet, desktop, wide, small, large }: ShowAtProps) {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const isWide = useIsWide();
  const isSmall = useIsSmallScreen();
  const isLarge = !isSmall;

  const shouldShow =
    (mobile && isMobile) ||
    (tablet && isTablet) ||
    (desktop && isDesktop) ||
    (wide && isWide) ||
    (small && isSmall) ||
    (large && isLarge);

  return shouldShow ? <>{children}</> : null;
}

interface HideAtProps {
  children: ReactNode;
  mobile?: boolean;
  tablet?: boolean;
  desktop?: boolean;
  wide?: boolean;
  small?: boolean;
  large?: boolean;
}

export function HideAt({ children, mobile, tablet, desktop, wide, small, large }: HideAtProps) {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const isWide = useIsWide();
  const isSmall = useIsSmallScreen();
  const isLarge = !isSmall;

  const shouldHide =
    (mobile && isMobile) ||
    (tablet && isTablet) ||
    (desktop && isDesktop) ||
    (wide && isWide) ||
    (small && isSmall) ||
    (large && isLarge);

  return shouldHide ? null : <>{children}</>;
}

import type { TypographyPrefs } from '@/lib/workspace/settings';
import { applyPrefs, loadPrefs } from '@/components/workspace/TypographySettings';
import { applyColors, loadColorPrefs } from '@/components/workspace/ColorSettings';

export const WORKSPACE_SLUG_KEY = 'dark-space-workspace';
const APPLIED_CACHE_PREFIX = 'dark-space-applied-theme:';

export interface AppliedThemeCache {
  typography: TypographyPrefs;
  colors: string;
  typographyOverride: boolean;
  colorsOverride: boolean;
}

export function persistAppliedTheme(slug: string, data: AppliedThemeCache): void {
  try {
    localStorage.setItem(APPLIED_CACHE_PREFIX + slug, JSON.stringify(data));
  } catch {
    // localStorage not available
  }
}

export function readAppliedTheme(slug: string): AppliedThemeCache | null {
  try {
    const raw = localStorage.getItem(APPLIED_CACHE_PREFIX + slug);
    if (!raw) return null;
    return JSON.parse(raw) as AppliedThemeCache;
  } catch {
    return null;
  }
}

// Applies the last-known workspace theme synchronously (before first paint)
// so the personal palette never flashes when a workspace theme overrides it.
export function applyStartupTheme(): void {
  try {
    const slug = localStorage.getItem(WORKSPACE_SLUG_KEY);
    if (!slug) return;
    const cached = readAppliedTheme(slug);
    if (!cached) return;

    if (cached.typographyOverride) {
      applyPrefs(loadPrefs());
    } else {
      applyPrefs(cached.typography);
    }

    if (cached.colorsOverride) {
      applyColors(loadColorPrefs());
    } else {
      applyColors(cached.colors);
    }
  } catch {
    // fall back to personal defaults
  }
}
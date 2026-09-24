import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
import { getWorkspaceSettings, saveWorkspaceSettings, type TypographyPrefs } from '@/lib/workspace/settings';
import { persistAppliedTheme, readAppliedTheme } from '@/lib/workspace/themeCache';
import {
  applyPrefs as applyTypography,
  loadPrefs as loadPersonalTypography,
  DEFAULTS as TYPO_DEFAULTS,
} from '@/components/workspace/TypographySettings';
import {
  applyColors,
  loadColorPrefs as loadPersonalColors,
} from '@/components/workspace/ColorSettings';

const TYPO_OVERRIDE_PREFIX = 'dark-space-typography-override:';
const COLORS_OVERRIDE_PREFIX = 'dark-space-colors-override:';

interface WorkspaceThemeContextValue {
  workspaceTypography: TypographyPrefs | null;
  workspaceColors: string | null;
  typographyOverride: boolean;
  colorsOverride: boolean;
  effectiveTypography: TypographyPrefs;
  effectiveColors: string;
  setTypographyOverride: (value: boolean) => void;
  setColorsOverride: (value: boolean) => void;
  saveWorkspaceTypography: (prefs: TypographyPrefs | null) => Promise<boolean>;
  saveWorkspaceColors: (paletteId: string | null) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const WorkspaceThemeContext = createContext<WorkspaceThemeContextValue | null>(null);

interface WorkspaceThemeProviderProps {
  children: ReactNode;
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // localStorage not available
  }
}

function resolveTypography(workspacePrefs: TypographyPrefs | null): TypographyPrefs {
  if (workspacePrefs) return workspacePrefs;
  try {
    return loadPersonalTypography();
  } catch {
    return TYPO_DEFAULTS;
  }
}

export function WorkspaceThemeProvider({ children }: WorkspaceThemeProviderProps) {
  const { isAuthenticated } = useAuth();
  const { currentWorkspace, currentRole, isLoading } = useWorkspaceContext();
  const workspaceId = currentWorkspace?.id ?? null;
  const canManage = currentRole === 'owner' || currentRole === 'admin';

  const [workspaceTypography, setWorkspaceTypography] = useState<TypographyPrefs | null>(null);
  const [workspaceColors, setWorkspaceColors] = useState<string | null>(null);
  const [resolvedWorkspaceId, setResolvedWorkspaceId] = useState<string | null>(null);
  const [typographyOverride, setTypographyOverrideState] = useState<boolean>(() =>
    workspaceId ? readFlag(TYPO_OVERRIDE_PREFIX + workspaceId) : false,
  );
  const [colorsOverride, setColorsOverrideState] = useState<boolean>(() =>
    workspaceId ? readFlag(COLORS_OVERRIDE_PREFIX + workspaceId) : false,
  );

  const loadWorkspaceTheme = useCallback(async () => {
    if (!workspaceId || !isAuthenticated) return;
    const settings = await getWorkspaceSettings(workspaceId);
    if (!settings) return;
    setWorkspaceTypography(settings.typography ?? null);
    setWorkspaceColors(settings.colors ?? null);
  }, [workspaceId, isAuthenticated]);

  useLayoutEffect(() => {
    if (!workspaceId || !currentWorkspace) {
      setResolvedWorkspaceId(null);
      return;
    }
    const cached = readAppliedTheme(currentWorkspace.slug);
    const typoOverride = readFlag(TYPO_OVERRIDE_PREFIX + workspaceId);
    const colorOverride = readFlag(COLORS_OVERRIDE_PREFIX + workspaceId);
    setTypographyOverrideState(typoOverride);
    setColorsOverrideState(colorOverride);
    // Seed from the cached theme synchronously (before paint) so we never
    // fall back to the personal palette while the fresh copy is fetched.
    setWorkspaceTypography(typoOverride ? null : (cached?.typography ?? null));
    setWorkspaceColors(colorOverride ? null : (cached?.colors ?? null));
    setResolvedWorkspaceId(workspaceId);
    loadWorkspaceTheme();
  }, [workspaceId, currentWorkspace, loadWorkspaceTheme]);

  // Realtime: reflect owner theme changes for members (respects their override)
  useEffect(() => {
    if (!workspaceId || !isAuthenticated) return;
    const channel = supabase
      .channel(`workspace-theme-${workspaceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspace_settings', filter: `workspace_id=eq.${workspaceId}` },
        () => {
          loadWorkspaceTheme();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspaceId, isAuthenticated, loadWorkspaceTheme]);

  // Resolve effective values
  const effectiveTypography = useMemo(() => {
    if (typographyOverride) {
      try {
        return loadPersonalTypography();
      } catch {
        return TYPO_DEFAULTS;
      }
    }
    return resolveTypography(workspaceTypography);
  }, [typographyOverride, workspaceTypography]);

  const effectiveColors = useMemo(() => {
    if (colorsOverride) return loadPersonalColors();
    return workspaceColors ?? loadPersonalColors();
  }, [colorsOverride, workspaceColors]);

  // Apply effective theme to the DOM (before paint) and cache it for a
// flash-free startup. While the workspace is still loading or its theme
// hasn't been resolved for the current workspace yet, keep whatever was
// applied at startup instead of flashing the personal palette.
  useLayoutEffect(() => {
    if (!isAuthenticated) return;
    if (isLoading || (workspaceId && resolvedWorkspaceId !== workspaceId)) return;
    applyTypography(effectiveTypography);
    if (currentWorkspace) {
      persistAppliedTheme(currentWorkspace.slug, {
        typography: effectiveTypography,
        colors: effectiveColors,
        typographyOverride,
        colorsOverride,
      });
    }
  }, [isAuthenticated, isLoading, workspaceId, resolvedWorkspaceId, effectiveTypography, effectiveColors, typographyOverride, colorsOverride, currentWorkspace]);

  useLayoutEffect(() => {
    if (!isAuthenticated) return;
    if (isLoading || (workspaceId && resolvedWorkspaceId !== workspaceId)) return;
    applyColors(effectiveColors);
  }, [isAuthenticated, isLoading, workspaceId, resolvedWorkspaceId, effectiveColors]);

  const setTypographyOverride = useCallback(
    (value: boolean) => {
      setTypographyOverrideState(value);
      if (workspaceId) writeFlag(TYPO_OVERRIDE_PREFIX + workspaceId, value);
    },
    [workspaceId],
  );

  const setColorsOverride = useCallback(
    (value: boolean) => {
      setColorsOverrideState(value);
      if (workspaceId) writeFlag(COLORS_OVERRIDE_PREFIX + workspaceId, value);
    },
    [workspaceId],
  );

  const saveWorkspaceTypography = useCallback(
    async (prefs: TypographyPrefs | null): Promise<boolean> => {
      if (!workspaceId || !canManage) return false;
      const result = await saveWorkspaceSettings(workspaceId, {
        typography: prefs ?? undefined,
        clearTypography: prefs === null,
      });
      if (result.success) {
        setWorkspaceTypography(prefs);
      }
      return result.success;
    },
    [workspaceId, canManage],
  );

  const saveWorkspaceColors = useCallback(
    async (paletteId: string | null): Promise<boolean> => {
      if (!workspaceId || !canManage) return false;
      const result = await saveWorkspaceSettings(workspaceId, {
        colors: paletteId ?? undefined,
        clearColors: paletteId === null,
      });
      if (result.success) {
        setWorkspaceColors(paletteId);
      }
      return result.success;
    },
    [workspaceId, canManage],
  );

  const refresh = useCallback(async () => {
    await loadWorkspaceTheme();
  }, [loadWorkspaceTheme]);

  const value = useMemo<WorkspaceThemeContextValue>(
    () => ({
      workspaceTypography,
      workspaceColors,
      typographyOverride,
      colorsOverride,
      effectiveTypography,
      effectiveColors,
      setTypographyOverride,
      setColorsOverride,
      saveWorkspaceTypography,
      saveWorkspaceColors,
      refresh,
    }),
    [
      workspaceTypography,
      workspaceColors,
      typographyOverride,
      colorsOverride,
      effectiveTypography,
      effectiveColors,
      setTypographyOverride,
      setColorsOverride,
      saveWorkspaceTypography,
      saveWorkspaceColors,
      refresh,
    ],
  );

  return <WorkspaceThemeContext.Provider value={value}>{children}</WorkspaceThemeContext.Provider>;
}

export function useWorkspaceTheme(): WorkspaceThemeContextValue {
  const context = useContext(WorkspaceThemeContext);
  if (!context) {
    throw new Error('useWorkspaceTheme must be used within a WorkspaceThemeProvider');
  }
  return context;
}
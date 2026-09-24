import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceTheme } from '@/app/providers/WorkspaceThemeProvider';
import styles from './ColorSettings.module.css';

interface PaletteValues {
  primary: string;
  primaryHover: string;
  primaryActive: string;
  secondary: string;
  secondaryHover: string;
  secondaryActive: string;
  accent: string;
  accentHover: string;
  accentActive: string;
  background: string;
  surface: string;
  surfaceSecondary: string;
  surfaceTertiary: string;
}

interface ColorPalette {
  id: string;
  label: string;
  light: PaletteValues;
  dark: PaletteValues;
}

const COLOR_PALETTES: ColorPalette[] = [
  {
    id: 'sage',
    label: 'Sage (Default)',
    light: {
      primary: '#82A6B1', primaryHover: '#6B939E', primaryActive: '#5A8490',
      secondary: '#2D2A32', secondaryHover: '#3D3A42', secondaryActive: '#1D1A22',
      accent: '#EEEFA8', accentHover: '#E5E69A', accentActive: '#D8DA8C',
      background: '#FAFDF6', surface: '#FFFFFF', surfaceSecondary: '#F5F7F2', surfaceTertiary: '#EEF0EA',
    },
    dark: {
      primary: '#8FB8C3', primaryHover: '#A0C5CE', primaryActive: '#B0D1D9',
      secondary: '#2D2A32', secondaryHover: '#3D3A42', secondaryActive: '#1D1A22',
      accent: '#D4D58E', accentHover: '#C8C97F', accentActive: '#BABB70',
      background: '#1A1820', surface: '#2D2A32', surfaceSecondary: '#363340', surfaceTertiary: '#403D4A',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    light: {
      primary: '#3B82C4', primaryHover: '#2F6FAE', primaryActive: '#286099',
      secondary: '#1E3A5F', secondaryHover: '#2A4A75', secondaryActive: '#152C4B',
      accent: '#A5D8E4', accentHover: '#8FCCDC', accentActive: '#7BBFD3',
      background: '#F4F9FC', surface: '#FFFFFF', surfaceSecondary: '#EAF1F7', surfaceTertiary: '#DFE9F1',
    },
    dark: {
      primary: '#5AA7E8', primaryHover: '#74B8EE', primaryActive: '#8CC8F2',
      secondary: '#223C5C', secondaryHover: '#2C4A70', secondaryActive: '#1A3049',
      accent: '#9AD3E0', accentHover: '#85C7D8', accentActive: '#70BBCF',
      background: '#0F1B26', surface: '#1B2836', surfaceSecondary: '#223140', surfaceTertiary: '#293A4A',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    light: {
      primary: '#4C8C5A', primaryHover: '#3F7A4C', primaryActive: '#356941',
      secondary: '#1F3A28', secondaryHover: '#2A4C34', secondaryActive: '#162D1F',
      accent: '#C5E3A5', accentHover: '#B6D993', accentActive: '#A7CF82',
      background: '#F4F9F2', surface: '#FFFFFF', surfaceSecondary: '#EAF2E7', surfaceTertiary: '#DFEADB',
    },
    dark: {
      primary: '#6FB87E', primaryHover: '#84C690', primaryActive: '#98D3A2',
      secondary: '#24402C', secondaryHover: '#2F5238', secondaryActive: '#1B3322',
      accent: '#BEE0A0', accentHover: '#ADD88C', accentActive: '#9CD07A',
      background: '#101A14', surface: '#1C2A20', surfaceSecondary: '#23332B', surfaceTertiary: '#2B3D34',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    light: {
      primary: '#D97A3F', primaryHover: '#C66A31', primaryActive: '#B25C2A',
      secondary: '#4A2C1E', secondaryHover: '#5C3A28', secondaryActive: '#3A2218',
      accent: '#F2C47A', accentHover: '#EAB661', accentActive: '#E2A84D',
      background: '#FDF7F0', surface: '#FFFFFF', surfaceSecondary: '#FAF0E6', surfaceTertiary: '#F5E7DA',
    },
    dark: {
      primary: '#F0905A', primaryHover: '#F3A372', primaryActive: '#F6B489',
      secondary: '#4A2E1F', secondaryHover: '#5C3A28', secondaryActive: '#3A2418',
      accent: '#F0C47E', accentHover: '#E8B566', accentActive: '#E0A952',
      background: '#241711', surface: '#33231B', surfaceSecondary: '#3B2A20', surfaceTertiary: '#443227',
    },
  },
  {
    id: 'royal',
    label: 'Royal',
    light: {
      primary: '#7A5CC2', primaryHover: '#6A4EB2', primaryActive: '#5C42A0',
      secondary: '#2E2446', secondaryHover: '#3B2F58', secondaryActive: '#251C38',
      accent: '#C9B8F0', accentHover: '#BBA6EA', accentActive: '#AC95E3',
      background: '#F7F5FC', surface: '#FFFFFF', surfaceSecondary: '#F0EDF8', surfaceTertiary: '#E8E4F3',
    },
    dark: {
      primary: '#9A7EE0', primaryHover: '#AC93E6', primaryActive: '#BCA7EC',
      secondary: '#34294E', secondaryHover: '#413361', secondaryActive: '#292040',
      accent: '#C4B2EC', accentHover: '#B6A1E5', accentActive: '#A890DE',
      background: '#191526', surface: '#261F38', surfaceSecondary: '#2D2542', surfaceTertiary: '#352C4C',
    },
  },
  {
    id: 'rose',
    label: 'Rose',
    light: {
      primary: '#C65A7E', primaryHover: '#B44C6F', primaryActive: '#A24061',
      secondary: '#462430', secondaryHover: '#583040', secondaryActive: '#381D27',
      accent: '#F2B7C6', accentHover: '#EAA7B9', accentActive: '#E297AC',
      background: '#FDF5F7', surface: '#FFFFFF', surfaceSecondary: '#F9ECF0', surfaceTertiary: '#F4E1E7',
    },
    dark: {
      primary: '#E07A9E', primaryHover: '#E68FB0', primaryActive: '#ECA2C0',
      secondary: '#482631', secondaryHover: '#5A3040', secondaryActive: '#381E28',
      accent: '#EFB3C3', accentHover: '#E8A3B6', accentActive: '#E093A8',
      background: '#241520', surface: '#33202C', surfaceSecondary: '#3B2633', surfaceTertiary: '#442D3B',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    light: {
      primary: '#5A6472', primaryHover: '#4B5461', primaryActive: '#3E4752',
      secondary: '#23282F', secondaryHover: '#2F363F', secondaryActive: '#1A1E24',
      accent: '#A9B4C2', accentHover: '#97A4B5', accentActive: '#8694A8',
      background: '#F4F6F8', surface: '#FFFFFF', surfaceSecondary: '#EAEDF1', surfaceTertiary: '#DFE3E8',
    },
    dark: {
      primary: '#7E8B9C', primaryHover: '#8F9BAB', primaryActive: '#9FABBA',
      secondary: '#282D35', secondaryHover: '#333A44', secondaryActive: '#1F242B',
      accent: '#A6B2C1', accentHover: '#94A2B4', accentActive: '#8393A7',
      background: '#14161C', surface: '#20242C', surfaceSecondary: '#272C35', surfaceTertiary: '#2E343E',
    },
  },
];

const STORAGE_KEY = 'dark-space-colors';
const STYLE_ID = 'dark-space-color-theme';
const THEME_COLOR_META = "meta[name='theme-color']";

let currentPalette: ColorPalette | null = null;
let themeColorObserver: MutationObserver | null = null;

function applyThemeColor() {
  const meta = document.querySelector<HTMLMetaElement>(THEME_COLOR_META);
  if (!meta || !currentPalette) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  meta.setAttribute('content', isDark ? currentPalette.dark.primary : currentPalette.light.primary);
}

export { COLOR_PALETTES, STORAGE_KEY };
export type { ColorPalette, PaletteValues };

export function loadColorPrefs(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && COLOR_PALETTES.some((p) => p.id === raw)) return raw;
  } catch {}
  return COLOR_PALETTES[0].id;
}

function applyFavicon(primary: string) {
  const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) return;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" rx="20" fill="${primary}"/>` +
    `<text x="50" y="72" font-size="70" text-anchor="middle" fill="#FFFFFF" font-family="serif">\u2740</text>` +
    `</svg>`;
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function applyColors(paletteId: string) {
  const palette = COLOR_PALETTES.find((p) => p.id === paletteId);
  if (!palette) return;
  currentPalette = palette;
  applyFavicon(palette.light.primary);
  applyThemeColor();
  // Keep the browser status bar in sync when the light/dark theme changes.
  if (!themeColorObserver) {
    themeColorObserver = new MutationObserver(() => applyThemeColor());
    themeColorObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }
  const vars = (v: PaletteValues) => `
    --color-primary: ${v.primary};
    --color-primary-hover: ${v.primaryHover};
    --color-primary-active: ${v.primaryActive};
    --color-secondary: ${v.secondary};
    --color-secondary-hover: ${v.secondaryHover};
    --color-secondary-active: ${v.secondaryActive};
    --color-accent: ${v.accent};
    --color-accent-hover: ${v.accentHover};
    --color-accent-active: ${v.accentActive};
    --color-background: ${v.background};
    --color-surface: ${v.surface};
    --color-surface-secondary: ${v.surfaceSecondary};
    --color-surface-tertiary: ${v.surfaceTertiary};
  `;
  styleEl.textContent = `
    :root,
    [data-theme='light'] {
      ${vars(palette.light)}
    }
    [data-theme='dark'] {
      ${vars(palette.dark)}
    }
  `;
}

export function initColorPrefs() {
  applyColors(loadColorPrefs());
}

export function ColorSettings() {
  const { toast } = useToast();
  const { currentWorkspace, currentRole } = useWorkspace();
  const theme = useWorkspaceTheme();
  const isManager = currentRole === 'owner' || currentRole === 'admin';

  const [paletteId, setPaletteId] = useState<string>(() => {
    if (isManager) return theme.workspaceColors ?? loadColorPrefs();
    return theme.colorsOverride ? loadColorPrefs() : (theme.workspaceColors ?? loadColorPrefs());
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (hasChanges) return;
    if (isManager) {
      setPaletteId(theme.workspaceColors ?? loadColorPrefs());
    } else if (!theme.colorsOverride) {
      setPaletteId(theme.workspaceColors ?? loadColorPrefs());
    }
  }, [isManager, theme.workspaceColors, theme.colorsOverride, hasChanges]);

  const select = useCallback((id: string) => {
    setPaletteId(id);
    setHasChanges(true);
    applyColors(id);
  }, []);

  const handleSave = useCallback(async () => {
    if (isManager) {
      if (!currentWorkspace) return;
      setIsSaving(true);
      const ok = await theme.saveWorkspaceColors(paletteId);
      setIsSaving(false);
      if (!ok) {
        toast({ variant: 'error', description: 'Failed to save workspace colors.' });
        return;
      }
      setHasChanges(false);
      toast({ variant: 'success', title: 'Workspace colors saved', description: 'Applied to everyone in the workspace.' });
    } else if (theme.colorsOverride) {
      localStorage.setItem(STORAGE_KEY, paletteId);
      applyColors(paletteId);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Colors saved', description: 'Your color preference has been updated.' });
    }
  }, [isManager, currentWorkspace, theme, paletteId, toast]);

  const handleReset = useCallback(async () => {
    const defaultId = COLOR_PALETTES[0].id;
    if (isManager) {
      setIsSaving(true);
      const ok = await theme.saveWorkspaceColors(defaultId);
      setIsSaving(false);
      if (!ok) {
        toast({ variant: 'error', description: 'Failed to reset workspace colors.' });
        return;
      }
      setPaletteId(defaultId);
      applyColors(defaultId);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Workspace colors reset', description: 'Back to the default color theme.' });
    } else {
      setPaletteId(defaultId);
      localStorage.removeItem(STORAGE_KEY);
      applyColors(defaultId);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Colors reset', description: 'Back to the default color theme.' });
    }
  }, [isManager, theme, toast]);

  const readOnly = !isManager && !theme.colorsOverride;

  return (
    <div className={styles.container}>
      {!isManager && (
        <div className={styles.field}>
          <div className={styles.overrideRow}>
            <Switch
              label="Override owner's colors"
              checked={theme.colorsOverride}
              onChange={(e) => theme.setColorsOverride(e.target.checked)}
            />
          </div>
          <p className={styles.hint}>
            {theme.colorsOverride
              ? 'You are using your own color theme. Owner changes will not affect you.'
              : 'Following the workspace colors set by the owner. Toggle to use your own.'}
          </p>
        </div>
      )}

      {isManager && (
        <p className={styles.hint}>
          This color theme is applied to every member of {currentWorkspace?.name}. Members can override it for themselves.
        </p>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Color theme</label>
        <p className={styles.hint}>
          Choose the accent, secondary, and background colors used across the application.
        </p>
        <div className={styles.paletteGrid}>
          {COLOR_PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={readOnly}
              className={`${styles.palette} ${paletteId === p.id ? styles.paletteActive : ''}`}
              onClick={() => select(p.id)}
            >
              <span className={styles.swatches}>
                <span className={styles.swatch} style={{ backgroundColor: p.light.primary }} />
                <span className={styles.swatch} style={{ backgroundColor: p.light.secondary }} />
                <span className={styles.swatch} style={{ backgroundColor: p.light.accent }} />
                <span className={styles.swatch} style={{ backgroundColor: p.light.background }} />
              </span>
              <span className={styles.paletteLabel}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.preview}>
        <label className={styles.label}>Preview</label>
        <div className={styles.previewBox}>
          <span className={styles.previewBadge}>Primary</span>
          <span className={styles.previewBadgeSecondary}>Secondary</span>
          <span className={styles.previewBadgeAccent}>Accent</span>
          <span className={styles.previewBadgeBg}>Background</span>
          <p className={styles.previewBody}>
            This is a preview of how the selected accent and background colors will look across the application.
          </p>
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={handleReset} disabled={readOnly}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || readOnly} loading={isSaving}>
          {isManager ? 'Save for workspace' : 'Save colors'}
        </Button>
      </div>
    </div>
  );
}

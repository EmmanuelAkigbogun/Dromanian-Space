import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceTheme } from '@/app/providers/WorkspaceThemeProvider';
import styles from './TypographySettings.module.css';

const FONT_FAMILIES = [
  { value: 'Inter, system-ui, -apple-system, sans-serif', label: 'Inter (Default)' },
  { value: '"Nunito Sans", "Nunito", sans-serif', label: 'Nunito Sans' },
  { value: 'Roboto, system-ui, sans-serif', label: 'Roboto' },
  { value: '"Open Sans", system-ui, sans-serif', label: 'Open Sans' },
  { value: 'Lato, system-ui, sans-serif', label: 'Lato' },
  { value: 'Montserrat, system-ui, sans-serif', label: 'Montserrat' },
  { value: '"Gochi Hand", cursive', label: 'Gochi Hand' },
  { value: 'Caveat, cursive', label: 'Caveat' },
  { value: '"Dancing Script", cursive', label: 'Dancing Script' },
  { value: 'Pacifico, cursive', label: 'Pacifico' },
  { value: '"Permanent Marker", cursive', label: 'Permanent Marker' },
  { value: '"Plus Jakarta Sans", sans-serif', label: 'Plus Jakarta Sans' },
  { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
  { value: '"SF Pro", system-ui, -apple-system, sans-serif', label: 'SF Pro' },
  { value: '"JetBrains Mono", "Fira Code", "Fira Mono", monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", "Fira Mono", monospace', label: 'Fira Code' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },
  { value: 'Inconsolata, monospace', label: 'Inconsolata' },
  { value: '"Roboto Mono", monospace', label: 'Roboto Mono' },
  { value: '"Space Mono", monospace', label: 'Space Mono' },
  { value: '"SF Mono", "Fira Code", Menlo, monospace', label: 'SF Mono' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: 'Monaco, Menlo, monospace', label: 'Monaco' },
  { value: '"Courier New", Courier, monospace', label: 'Courier New' },
] as const;

const FONT_SIZES = [
  { value: '12', label: 'Small', description: '12px' },
  { value: '13', label: 'Compact', description: '13px' },
  { value: '14', label: 'Default', description: '14px' },
  { value: '15', label: 'Medium', description: '15px' },
  { value: '16', label: 'Large', description: '16px' },
  { value: '18', label: 'X-Large', description: '18px' },
  { value: '20', label: 'XX-Large', description: '20px' },
  { value: '24', label: 'XXX-Large', description: '24px' },
] as const;

const LINE_HEIGHTS = [
  { value: '1.4', label: 'Compact' },
  { value: '1.5', label: 'Default' },
  { value: '1.6', label: 'Relaxed' },
  { value: '1.8', label: 'Spacious' },
  { value: '2.0', label: 'Loose' },
] as const;

const FONT_WEIGHTS = [
  { value: '300', label: 'Light', description: '300' },
  { value: '400', label: 'Regular', description: '400' },
  { value: '500', label: 'Medium', description: '500' },
  { value: '600', label: 'Semibold', description: '600' },
  { value: '700', label: 'Bold', description: '700' },
] as const;

interface TypographyPrefs {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
}

const STORAGE_KEY = 'dark-space-typography';

const DEFAULTS: TypographyPrefs = { fontFamily: FONT_FAMILIES[0].value, fontSize: '16', fontWeight: '400', lineHeight: '1.5' };

export { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, FONT_WEIGHTS, STORAGE_KEY, DEFAULTS };
export type { TypographyPrefs };

export function loadPrefs(): TypographyPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULTS;
}

export function applyPrefs(prefs: TypographyPrefs) {
  const root = document.documentElement;
  root.style.setProperty('--font-family', prefs.fontFamily);
  root.style.fontSize = prefs.fontSize + 'px';
  root.style.setProperty('--font-weight-normal', prefs.fontWeight);
  root.style.setProperty('--line-height-normal', prefs.lineHeight);
}

export function initTypography() {
  applyPrefs(loadPrefs());
}

export function TypographySettings() {
  const { toast } = useToast();
  const { currentWorkspace, currentRole } = useWorkspace();
  const theme = useWorkspaceTheme();
  const isManager = currentRole === 'owner' || currentRole === 'admin';

  const [prefs, setPrefs] = useState<TypographyPrefs>(() => {
    if (isManager) return theme.workspaceTypography ?? loadPrefs();
    return theme.typographyOverride ? loadPrefs() : (theme.workspaceTypography ?? loadPrefs());
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (hasChanges) return;
    if (isManager) {
      setPrefs(theme.workspaceTypography ?? loadPrefs());
    } else if (!theme.typographyOverride) {
      setPrefs(theme.workspaceTypography ?? loadPrefs());
    }
  }, [isManager, theme.workspaceTypography, theme.typographyOverride, hasChanges]);

  const update = useCallback(<K extends keyof TypographyPrefs>(key: K, value: TypographyPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      setHasChanges(true);
      applyPrefs(next);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (isManager) {
      if (!currentWorkspace || !theme.saveWorkspaceTypography) return;
      setIsSaving(true);
      const ok = await theme.saveWorkspaceTypography(prefs);
      setIsSaving(false);
      if (!ok) {
        toast({ variant: 'error', description: 'Failed to save workspace typography.' });
        return;
      }
      setHasChanges(false);
      toast({ variant: 'success', title: 'Workspace typography saved', description: 'Applied to everyone in the workspace.' });
    } else if (theme.typographyOverride) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      applyPrefs(prefs);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Typography saved', description: 'Your personal typography has been updated.' });
    }
  }, [isManager, currentWorkspace, theme, prefs, toast]);

  const handleReset = useCallback(async () => {
    if (isManager) {
      setIsSaving(true);
      const ok = await theme.saveWorkspaceTypography(DEFAULTS);
      setIsSaving(false);
      if (!ok) {
        toast({ variant: 'error', description: 'Failed to reset workspace typography.' });
        return;
      }
      setPrefs(DEFAULTS);
      applyPrefs(DEFAULTS);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Workspace typography reset', description: 'Back to the default typography.' });
    } else {
      setPrefs(DEFAULTS);
      localStorage.removeItem(STORAGE_KEY);
      applyPrefs(DEFAULTS);
      setHasChanges(false);
      toast({ variant: 'success', title: 'Typography reset', description: 'Back to the default typography.' });
    }
  }, [isManager, theme, toast]);

  const readOnly = !isManager && !theme.typographyOverride;

  return (
    <div className={styles.container}>
      {!isManager && (
        <div className={styles.field}>
          <div className={styles.overrideRow}>
            <Switch
              label="Override owner's typography"
              checked={theme.typographyOverride}
              onChange={(e) => theme.setTypographyOverride(e.target.checked)}
            />
          </div>
          <p className={styles.hint}>
            {theme.typographyOverride
              ? 'You are using your own typography. Owner changes will not affect you.'
              : 'Following the workspace typography set by the owner. Toggle to use your own.'}
          </p>
        </div>
      )}

      {isManager && (
        <p className={styles.hint}>
          This typography is applied to every member of {currentWorkspace?.name}. Members can override it for themselves.
        </p>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Font family</label>
        <p className={styles.hint}>Choose the typeface used across the entire application.</p>
        <div className={styles.optionGrid}>
          {FONT_FAMILIES.map((f) => (
            <button
              key={f.value}
              type="button"
              disabled={readOnly}
              className={`${styles.option} ${prefs.fontFamily === f.value ? styles.optionActive : ''}`}
              style={{ fontFamily: f.value }}
              onClick={() => update('fontFamily', f.value)}
            >
              <span className={styles.optionLabel}>{f.label}</span>
              <span className={styles.optionPreview}>Aa Bb Cc 123</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Font size</label>
        <p className={styles.hint}>Adjust the base text size used across the application.</p>
        <div className={styles.sizeRow}>
          {FONT_SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              disabled={readOnly}
              className={`${styles.sizeOption} ${prefs.fontSize === s.value ? styles.sizeOptionActive : ''}`}
              onClick={() => update('fontSize', s.value)}
            >
              <span className={styles.sizeLabel}>{s.label}</span>
              <span className={styles.sizeDesc}>{s.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Line spacing</label>
        <p className={styles.hint}>Control the spacing between lines of text.</p>
        <div className={styles.lineHeightRow}>
          {LINE_HEIGHTS.map((lh) => (
            <button
              key={lh.value}
              type="button"
              disabled={readOnly}
              className={`${styles.lineHeightOption} ${prefs.lineHeight === lh.value ? styles.lineHeightActive : ''}`}
              onClick={() => update('lineHeight', lh.value)}
            >
              <span className={styles.lineHeightLabel}>{lh.label}</span>
              <span className={styles.lineHeightValue}>{lh.value}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Font weight</label>
        <p className={styles.hint}>Control the thickness of the text.</p>
        <div className={styles.weightRow}>
          {FONT_WEIGHTS.map((w) => (
            <button
              key={w.value}
              type="button"
              disabled={readOnly}
              className={`${styles.weightOption} ${prefs.fontWeight === w.value ? styles.weightOptionActive : ''}`}
              onClick={() => update('fontWeight', w.value)}
            >
              <span className={styles.weightLabel}>{w.label}</span>
              <span className={styles.weightDesc}>{w.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.preview}>
        <label className={styles.label}>Preview</label>
        <div
          className={styles.previewBox}
          style={{
            fontFamily: prefs.fontFamily,
            fontSize: prefs.fontSize + 'px',
            fontWeight: prefs.fontWeight,
            lineHeight: prefs.lineHeight,
          }}
        >
          <p className={styles.previewName}>Settings & Typography</p>
          <p className={styles.previewBody}>
            This is a preview of how your chosen font, size, and line spacing will look across the entire application.
            All text in the interface will update to match your selection.
          </p>
          <p className={styles.previewMuted}>Secondary text like timestamps and hints will also use your chosen typography.</p>
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={handleReset} disabled={readOnly}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || readOnly} loading={isSaving}>
          {isManager ? 'Save for workspace' : 'Save typography'}
        </Button>
      </div>
    </div>
  );
}
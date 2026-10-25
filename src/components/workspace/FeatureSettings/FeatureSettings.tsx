import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/features/platform/client';
import { useWorkspace } from '@/hooks/useWorkspace';
import { FEATURES, useFeatureAccess, useSaveFeatures, type Feature } from '@/lib/workspace/features';
import styles from './FeatureSettings.module.css';

type ProviderName = 'anthropic' | 'openai' | 'gemini';
const PROVIDERS: Array<{ name: ProviderName; label: string; hint: string }> = [
  { name: 'gemini', label: 'Google Gemini', hint: 'Key from aistudio.google.com' },
  { name: 'anthropic', label: 'Anthropic (Claude)', hint: 'Key from console.anthropic.com' },
  { name: 'openai', label: 'OpenAI', hint: 'Key from platform.openai.com' },
];

interface AiStatus {
  provider_key_management?: { allowed: boolean; providers: Array<{ name: ProviderName; source: 'saved' | 'environment' | 'none' }> };
}

/** Owners and admins: what the team sees, and the keys integrations use. */
export function FeatureSettings() {
  const { toast } = useToast();
  const { currentWorkspace } = useWorkspace();
  const { hidden, loading } = useFeatureAccess();
  const save = useSaveFeatures();
  const [visible, setVisible] = useState<Set<Feature>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading) setVisible(new Set(FEATURES.map((f) => f.key).filter((k) => !hidden.includes(k))));
  }, [loading, hidden]);

  const dirty = FEATURES.some((f) => visible.has(f.key) === hidden.includes(f.key));

  async function onSave() {
    setSaving(true);
    try {
      await save(FEATURES.map((f) => f.key).filter((k) => !visible.has(k)));
      toast({ variant: 'success', description: 'Saved. The team sees the change the next time a page loads.' });
    } catch (err) {
      toast({ variant: 'error', description: err instanceof Error ? err.message : 'Features could not be saved.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.card}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Features for the team</h2>
            <p className={styles.description}>
              Choose what members of {currentWorkspace?.name ?? 'this workspace'} can see. Owners and admins always see everything, so you can
              set things up before turning them on.
            </p>
          </div>
        </header>
        <ul className={styles.list}>
          {FEATURES.map((f) => {
            const on = visible.has(f.key);
            return (
              <li key={f.key}>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={on}
                    disabled={loading}
                    onChange={(e) =>
                      setVisible((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(f.key);
                        else next.delete(f.key);
                        return next;
                      })
                    }
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>
                      {f.label}
                      {!on && <span className={styles.badge}>Hidden from members</span>}
                    </span>
                    <span className={styles.rowHint}>{f.description}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className={styles.note}>
          Hiding AI also stops members from starting agents, @mentioning them and inviting Scribe; the server refuses it, not just the menu.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => void onSave()} loading={saving} disabled={!dirty || loading}>
            Save features
          </Button>
        </div>
      </section>

      <ApiKeys />
    </div>
  );
}

function ApiKeys() {
  const { toast } = useToast();
  const { currentWorkspace } = useWorkspace();
  const status = useQuery({
    queryKey: ['feature-settings', 'ai-status', currentWorkspace?.id],
    enabled: !!currentWorkspace,
    queryFn: async () => (await (await api(`ai/status?workspace_id=${currentWorkspace!.id}`)).json()) as AiStatus,
    retry: false,
  });
  const push = useQuery({
    queryKey: ['feature-settings', 'push'],
    queryFn: async () => (await (await api('push')).json()) as { enabled: boolean },
    retry: false,
  });
  const [drafts, setDrafts] = useState<Partial<Record<ProviderName, string>>>({});
  const [busy, setBusy] = useState<ProviderName | null>(null);
  const management = status.data?.provider_key_management;

  async function update(provider: ProviderName, remove = false) {
    setBusy(provider);
    try {
      await api('ai/provider-keys', { provider, api_key: remove ? null : (drafts[provider] ?? '').trim() });
      setDrafts((d) => ({ ...d, [provider]: '' }));
      await status.refetch();
      toast({ variant: 'success', description: remove ? 'Key removed.' : 'Key saved. It is encrypted on the server and never shown again.' });
    } catch (err) {
      toast({ variant: 'error', description: err instanceof Error ? err.message : 'The key could not be saved.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>API keys &amp; integrations</h2>
          <p className={styles.description}>
            Keys for the AI providers your agents use. They are stored encrypted on the server and never sent back to a browser.
          </p>
        </div>
      </header>
      {status.isPending ? (
        <p className={styles.description}>Checking…</p>
      ) : !management ? (
        <p className={styles.description}>Key status is unavailable right now.</p>
      ) : (
        <ul className={styles.keys}>
          {PROVIDERS.map((p) => {
            const source = management.providers.find((x) => x.name === p.name)?.source ?? 'none';
            return (
              <li key={p.name} className={styles.keyRow}>
                <div className={styles.keyInfo}>
                  <span className={styles.rowLabel}>{p.label}</span>
                  <span className={`${styles.keyStatus} ${source !== 'none' ? styles.keyOn : ''}`}>
                    {source === 'saved' ? 'Key saved' : source === 'environment' ? 'Set in server environment' : 'Not set'}
                  </span>
                </div>
                {management.allowed ? (
                  <div className={styles.keyForm}>
                    <input
                      type="password"
                      autoComplete="off"
                      className={styles.keyInput}
                      placeholder={source === 'none' ? `Paste key · ${p.hint}` : 'Paste a new key to replace it'}
                      value={drafts[p.name] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                    />
                    <Button size="sm" onClick={() => void update(p.name)} disabled={(drafts[p.name] ?? '').trim().length < 20} loading={busy === p.name}>
                      Save
                    </Button>
                    {source === 'saved' && (
                      <Button size="sm" variant="ghost" onClick={() => void update(p.name, true)} disabled={busy === p.name}>
                        Remove
                      </Button>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {management && !management.allowed && (
        <p className={styles.note}>Only the platform administrator can change provider keys.</p>
      )}
      <div className={styles.keyRow}>
        <div className={styles.keyInfo}>
          <span className={styles.rowLabel}>Push notifications</span>
          <span className={`${styles.keyStatus} ${push.data?.enabled ? styles.keyOn : ''}`}>
            {push.isPending ? 'Checking…' : push.data?.enabled ? 'Configured on the server' : 'Not configured (WEB_PUSH_* keys in the server environment)'}
          </span>
        </div>
      </div>
      <p className={styles.note}>Models, budgets, web research and automation keys are in Agents → AI settings.</p>
    </section>
  );
}

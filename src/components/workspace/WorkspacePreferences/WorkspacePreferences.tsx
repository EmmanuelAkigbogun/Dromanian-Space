import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useChannel } from '@/hooks/useChannel';
import { useDmDisplayNames } from '@/hooks/useDmDisplayNames';
import { useToast } from '@/components/ui/Toast';
import { getWorkspaceSettings, saveWorkspaceSettings } from '@/lib/workspace/settings';
import styles from './WorkspacePreferences.module.css';

export function WorkspacePreferences() {
  const { currentWorkspace } = useWorkspace();
  const { channels } = useChannel();
  const dmDisplayNames = useDmDisplayNames();
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [defaultChannelIds, setDefaultChannelIds] = useState<string[]>([]);
  const [retentionDays, setRetentionDays] = useState('0');
  const [quietHoursStart, setQuietHoursStart] = useState('');
  const [quietHoursEnd, setQuietHoursEnd] = useState('');

  const activeChannels = channels.filter((c) => !c.archived_at);

  useEffect(() => {
    if (!currentWorkspace) return;
    let cancelled = false;
    setIsLoading(true);
    getWorkspaceSettings(currentWorkspace.id).then((settings) => {
      if (cancelled) return;
      if (settings) {
        setDefaultChannelIds(settings.default_channel_ids ?? []);
        setRetentionDays(String(settings.retention_days ?? 0));
        setQuietHoursStart(settings.quiet_hours_start ?? '');
        setQuietHoursEnd(settings.quiet_hours_end ?? '');
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentWorkspace]);

  const toggleChannel = useCallback((channelId: string) => {
    setDefaultChannelIds((prev) =>
      prev.includes(channelId) ? prev.filter((id) => id !== channelId) : [...prev, channelId],
    );
  }, []);

  const handleSave = async () => {
    if (!currentWorkspace) return;
    const retention = Math.max(0, Math.min(365, Number(retentionDays) || 0));
    const quietStart = quietHoursStart.trim() || null;
    const quietEnd = quietHoursEnd.trim() || null;

    setIsSaving(true);
    const result = await saveWorkspaceSettings(currentWorkspace.id, {
      default_channel_ids: defaultChannelIds,
      retention_days: retention,
      quiet_hours_start: quietStart,
      quiet_hours_end: quietEnd,
    });
    setIsSaving(false);

    if (result.success) {
      setRetentionDays(String(retention));
      toast({ variant: 'success', title: 'Preferences saved', description: 'Workspace preferences have been updated.' });
    } else {
      toast({ variant: 'error', description: result.error ?? 'Failed to save preferences.' });
    }
  };

  if (!currentWorkspace) return null;

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.field}>
        <label className={styles.label}>Default channels for new members</label>
        <p className={styles.hint}>
          New members are automatically added to these channels when they accept an invitation.
        </p>
        {activeChannels.length === 0 ? (
          <p className={styles.empty}>No channels yet.</p>
        ) : (
          <div className={styles.channelGrid}>
            {activeChannels.map((channel) => {
              const selected = defaultChannelIds.includes(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  className={`${styles.channelOption} ${selected ? styles.channelOptionSelected : ''}`}
                  onClick={() => toggleChannel(channel.id)}
                  aria-pressed={selected}
                >
                  <span className={styles.hash}>#</span>
                  <span className={styles.channelName}>{dmDisplayNames[channel.id] ?? channel.name}</span>
                  {channel.is_private && <span className={styles.privateBadge}>Private</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.field}>
        <div className={styles.retentionRow}>
          <div className={styles.retentionInput}>
            <Input
              label="Message retention (days)"
              type="number"
              min={0}
              max={365}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              helperText="Messages older than this are hidden. 0 disables retention."
            />
          </div>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Quiet hours</label>
        <p className={styles.hint}>Suppress notifications during these hours (24h).</p>
        <div className={styles.quietHoursRow}>
          <Input
            label="Start"
            type="time"
            value={quietHoursStart}
            onChange={(e) => setQuietHoursStart(e.target.value)}
          />
          <Input
            label="End"
            type="time"
            value={quietHoursEnd}
            onChange={(e) => setQuietHoursEnd(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.actions}>
        <Button onClick={handleSave} loading={isSaving}>
          Save preferences
        </Button>
      </div>
    </div>
  );
}

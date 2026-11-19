// Managing a group chat (rename, add people, permanent AI, leave, delete) and
// the notice that tells everyone when the AI is a permanent member.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { platform } from '@/lib/platform';
import { workspacePeople } from '@/features/platform/client';
import { Dialog } from '@/components/ui/Dialog';
import { Avatar } from '@/components/ui/Avatar';
import styles from './GroupManage.module.css';

export interface Resident {
  channel_id: string;
  enabled_by: string;
  summary_time: string;
  timezone: string;
  last_summary_on: string | null;
}

/** The conversation's permanent AI, if it has one. */
export function useResident(channelId: string | undefined) {
  return useQuery({
    queryKey: ['chat-resident', channelId],
    enabled: !!channelId,
    staleTime: 30_000,
    queryFn: async (): Promise<Resident | null> => {
      // A list query: most conversations have no permanent AI, and an empty
      // single-row read would log a 406 in the console.
      const { data } = await platform.from('channel_ai_residents').select('*').eq('channel_id', channelId!).limit(1);
      return ((data as Resident[] | null) ?? [])[0] ?? null;
    },
  });
}

export const summaryTimeLabel = (time: string) => time.slice(0, 5);

async function call<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (platform as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: { message: string } | null }> }).rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export const groupActions = {
  rename: (conversationId: string, name: string) => call('dm_group_rename', { p_conversation_id: conversationId, p_name: name }),
  addMembers: (conversationId: string, userIds: string[]) => call<number>('dm_group_add_members', { p_conversation_id: conversationId, p_user_ids: userIds }),
  removeMember: (conversationId: string, userId: string) => call('dm_group_remove_member', { p_conversation_id: conversationId, p_user_id: userId }),
  leave: (conversationId: string) => call<'left' | 'deleted'>('dm_group_leave', { p_conversation_id: conversationId }),
  remove: (conversationId: string) => call('dm_group_delete', { p_conversation_id: conversationId }),
  setResident: (channelId: string, enabled: boolean, summaryTime = '18:00') =>
    call('ai_resident_set', { p_channel_id: channelId, p_enabled: enabled, p_summary_time: summaryTime, p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Bucharest' }),
};

/** "AI is on": shown at the top of a conversation with a permanent AI. */
export function ResidentNotice({ resident, agentName, busy }: { resident: Resident; agentName: string; busy?: string | null }) {
  return (
    <div className={styles.notice} role="status">
      <span className={styles.pulse} aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 10l-5 3.6L16.8 20 12 16.4 7.2 20 9 13.6 4 10l6.1-1.2z" /></svg>
      </span>
      <span className={styles.noticeText}>
        <strong>AI is on · {agentName}</strong>
        <span>
          {busy ?? <>Reads every message in this group and posts a daily summary at {summaryTimeLabel(resident.summary_time)}, with proposed tasks shown as cards for approval. @mention it to ask anything.</>}
        </span>
      </span>
    </div>
  );
}

export function RenameGroupDialog({ conversationId, current, onClose, onDone }: { conversationId: string; current: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(current);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Rename group" size="sm">
      <form className={styles.form} onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        groupActions.rename(conversationId, name).then(() => { onDone(); onClose(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
      }}>
        <input className={styles.input} autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>Cancel</button>
          <button className={styles.primary} disabled={busy || !name.trim() || name.trim() === current}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

export function AddPeopleDialog({ workspaceId, conversationId, memberIds, onClose, onDone }: {
  workspaceId: string; conversationId: string; memberIds: string[]; onClose: () => void; onDone: () => void;
}) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const people = useQuery({ queryKey: ['workspace-people', workspaceId], queryFn: () => workspacePeople(workspaceId) });
  const candidates = useMemo(() => (people.data ?? [])
    .filter((p) => !memberIds.includes(p.id))
    .filter((p) => !search.trim() || `${p.display_name ?? ''} ${p.username ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())), [people.data, memberIds, search]);
  return (
    <Dialog open onClose={onClose} title="Add people" size="sm">
      <div className={styles.form}>
        <input className={styles.input} autoFocus placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people" />
        <div className={styles.people}>
          {candidates.map((p) => {
            const name = p.display_name || p.username || 'Member';
            const on = picked.has(p.id);
            return (
              <label key={p.id} className={`${styles.person} ${on ? styles.personOn : ''}`}>
                <input type="checkbox" checked={on} onChange={() => { const next = new Set(picked); if (on) next.delete(p.id); else next.add(p.id); setPicked(next); }} />
                <Avatar name={name} size="sm" />
                <span>{name}</span>
              </label>
            );
          })}
          {people.data && !candidates.length && <p className={styles.muted}>Everyone in the workspace is already here.</p>}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose}>Cancel</button>
          <button type="button" className={styles.primary} disabled={busy || !picked.size} onClick={() => {
            setBusy(true);
            groupActions.addMembers(conversationId, [...picked]).then(() => { onDone(); onClose(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
          }}>Add {picked.size || ''}</button>
        </div>
      </div>
    </Dialog>
  );
}

/** Invalidate everything that shows a conversation's members or AI state. */
export function useRefreshGroup() {
  const cache = useQueryClient();
  return (channelId: string) => Promise.all([
    cache.invalidateQueries({ queryKey: ['chat-resident', channelId] }),
    cache.invalidateQueries({ queryKey: ['chat-info', channelId] }),
  ]);
}

// People removed and blocked from the workspace, with Unblock.
import { useEffect, useState } from 'react';
import { platform } from '@/lib/platform';
import { useToast } from '@/components/ui/Toast';
import styles from './BlockedMembers.module.css';

interface Blocked { user_id: string; display_name: string | null; email: string | null; blocked_at: string; blocked_by_name: string | null }

type Rpc = { rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> };
const rpc = (f: string, a: Record<string, unknown>) => (platform as unknown as Rpc).rpc(f, a);

export async function blockMember(workspaceId: string, userId: string): Promise<void> {
  const { data, error } = await rpc('remove_and_block_member', { p_workspace_id: workspaceId, p_target_user_id: userId });
  if (error) throw new Error(error.message);
  const result = data as { allowed: boolean; reason?: string } | null;
  if (!result?.allowed) throw new Error(result?.reason ?? 'They could not be blocked.');
}

export function BlockedMembers({ workspaceId, version }: { workspaceId: string; version: number }) {
  const { toast } = useToast();
  const [blocked, setBlocked] = useState<Blocked[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void rpc('list_blocked_workspace_users', { p_workspace_id: workspaceId }).then(({ data }) => {
      if (!cancelled) setBlocked((data as Blocked[] | null) ?? []);
    });
    return () => { cancelled = true; };
  }, [workspaceId, version, reload]);
  if (!blocked.length) return null;
  return (
    <section className={styles.wrap} aria-label="Blocked people">
      <h3 className={styles.heading}>Blocked ({blocked.length})</h3>
      <p className={styles.muted}>They can’t rejoin through invite links, invitations or join requests.</p>
      <ul className={styles.list}>
        {blocked.map((b) => (
          <li key={b.user_id} className={styles.row}>
            <span className={styles.who}>
              <strong>{b.display_name ?? b.email ?? 'Former member'}</strong>
              <span>{b.email ?? ''}{b.email ? ' · ' : ''}blocked {new Date(b.blocked_at).toLocaleDateString()}{b.blocked_by_name ? ` by ${b.blocked_by_name}` : ''}</span>
            </span>
            <button type="button" className={styles.unblock} onClick={() => {
              if (!window.confirm(`Unblock ${b.display_name ?? b.email ?? 'this person'}? They can be invited or ask to join again; access isn't restored automatically.`)) return;
              void rpc('unblock_workspace_user', { p_workspace_id: workspaceId, p_user_id: b.user_id }).then(({ error }) => {
                if (error) toast({ variant: 'error', description: error.message });
                else { toast({ variant: 'success', description: 'Unblocked.' }); setReload((r) => r + 1); }
              });
            }}>Unblock</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

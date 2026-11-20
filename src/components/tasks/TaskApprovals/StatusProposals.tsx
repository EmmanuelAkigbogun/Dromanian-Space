// Status changes the GitHub project agent suggests from a week's commits.
// Project managers approve or decline; assignees see what is pending.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { platform } from '@/lib/platform';
import styles from './StatusProposals.module.css';

interface Proposal {
  id: string;
  task_id: string;
  from_status: string | null;
  to_status: 'todo' | 'in_progress' | 'done';
  note: string;
  commits: Array<{ sha: string; url: string; message: string }>;
  created_at: string;
  task: { title: string } | null;
}

const LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', backlog: 'Backlog', in_review: 'In review' };

export function usePendingStatusProposals(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['status-proposals', workspaceId],
    enabled: !!workspaceId,
    refetchInterval: 60_000,
    queryFn: async (): Promise<Proposal[]> => {
      const { data } = await platform.from('task_status_proposals').select('*').eq('workspace_id', workspaceId!).eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
      const rows = (data ?? []) as Omit<Proposal, 'task'>[];
      if (!rows.length) return [];
      const { data: tasks } = await platform.from('tasks').select('id,title').in('id', rows.map((r) => r.task_id));
      const titles = new Map(((tasks ?? []) as { id: string; title: string }[]).map((t) => [t.id, t.title]));
      return rows.map((r) => ({ ...r, task: titles.has(r.task_id) ? { title: titles.get(r.task_id)! } : null }));
    },
  });
}

export function StatusProposals({ workspaceId, isApprover }: { workspaceId: string; isApprover: boolean }) {
  const proposals = usePendingStatusProposals(workspaceId);
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (!proposals.data?.length) return null;
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    setError('');
    const { error: err } = await (platform as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }> })
      .rpc('decide_task_status_proposal', { p_proposal_id: id, p_approve: approve });
    if (err) setError(err.message);
    await cache.invalidateQueries({ queryKey: ['status-proposals', workspaceId] });
    setBusy(null);
  };
  return (
    <section className={styles.wrap} aria-label="Status changes from the project agent">
      <h3 className={styles.heading}>Status changes from the project agent ({proposals.data.length})</h3>
      <p className={styles.muted}>Suggested from this week’s commits on GitHub. Nothing changes until a project manager approves.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <ul className={styles.list}>
        {proposals.data.map((p) => (
          <li key={p.id} className={styles.card} data-to={p.to_status}>
            <div className={styles.top}>
              <Link to={`/tasks/${p.task_id}`} className={styles.title}>{p.task?.title ?? 'Task'}</Link>
              <span className={styles.change}>
                <span>{LABEL[p.from_status ?? 'todo'] ?? p.from_status}</span>
                <span aria-hidden="true">→</span>
                <strong>{LABEL[p.to_status]}</strong>
              </span>
            </div>
            <p className={styles.note}>{p.note}</p>
            <div className={styles.bottom}>
              <span className={styles.commits}>
                {p.commits.slice(0, 6).map((c) => <a key={c.sha} href={c.url} target="_blank" rel="noopener noreferrer" title={c.message}>{c.sha}</a>)}
              </span>
              {isApprover && (
                <span className={styles.buttons}>
                  <button type="button" className={styles.decline} disabled={busy === p.id} onClick={() => void decide(p.id, false)}>Decline</button>
                  <button type="button" className={styles.approve} disabled={busy === p.id} onClick={() => void decide(p.id, true)}>{busy === p.id ? '…' : `Mark ${LABEL[p.to_status].toLowerCase()}`}</button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

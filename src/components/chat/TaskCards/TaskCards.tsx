// The tasks an AI proposed in a conversation, drawn as cards under its message
// (and listed in the conversation's details panel): owner avatars, due date,
// priority and status, with Approve / Decline for task approvers.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { platform } from '@/lib/platform';
import { useProfiles } from '@/hooks/useProfiles';
import { Avatar } from '@/components/ui/Avatar';
import { getDisplayName } from '@/lib/message';
import styles from './TaskCards.module.css';

export interface TaskCard {
  id: string;
  title: string;
  description: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date: string | null;
  assignee_ids: string[];
  status: 'pending' | 'approved' | 'rejected';
  task_id: string | null;
  agent_run_id: string | null;
  created_at: string;
  decided_at: string | null;
  can_decide: boolean;
}

export function useTaskCards(channelId: string | undefined) {
  return useQuery({
    queryKey: ['chat-task-cards', channelId],
    enabled: !!channelId,
    staleTime: 15_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<TaskCard[]> => {
      const { data, error } = await (platform as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: TaskCard[] | null; error: { message: string } | null }> })
        .rpc('chat_task_cards', { p_channel_id: channelId });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

const STATUS: Record<TaskCard['status'], string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Declined' };

function dueLabel(iso: string) {
  const d = new Date(iso);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5);
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days < 0) return `Overdue · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  return `Due ${d.toLocaleDateString(undefined, { weekday: days < 7 ? 'short' : undefined, day: 'numeric', month: 'short' })}`;
}

export function TaskCardList({ channelId, cards, compact }: { channelId: string; cards: TaskCard[]; compact?: boolean }) {
  const cache = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { profiles } = useProfiles([...new Set(cards.flatMap((c) => c.assignee_ids))]);
  const decide = async (card: TaskCard, approve: boolean) => {
    setBusy(card.id);
    setError('');
    const { error: err } = await (platform as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<{ error: { message: string } | null }> })
      .rpc('decide_task_request', { p_request_id: card.id, p_approve: approve });
    if (err) setError(err.message);
    await cache.invalidateQueries({ queryKey: ['chat-task-cards', channelId] });
    setBusy(null);
  };
  const done = cards.filter((c) => c.status === 'approved').length;
  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>
      {!compact && (
        <div className={styles.head}>
          <span>Proposed tasks · {cards.length}</span>
          <span className={styles.progress} aria-label={`${done} of ${cards.length} approved`}>
            <span style={{ width: `${cards.length ? (done / cards.length) * 100 : 0}%` }} />
          </span>
        </div>
      )}
      {cards.map((card) => (
        <article key={card.id} className={styles.card} data-status={card.status} data-priority={card.priority}>
          <span className={styles.stripe} aria-hidden="true" />
          <div className={styles.body}>
            <div className={styles.titleRow}>
              <strong>{card.title}</strong>
              <span className={styles.status}>{STATUS[card.status]}</span>
            </div>
            {card.description && <p className={styles.desc}>{card.description}</p>}
            <div className={styles.meta}>
              <span className={styles.owners}>
                {card.assignee_ids.length ? card.assignee_ids.slice(0, 4).map((id) => {
                  const p = profiles.get(id) ?? null;
                  return <span key={id} title={getDisplayName(p, id)}><Avatar src={p?.avatar_url || undefined} name={getDisplayName(p, id)} size="xs" /></span>;
                }) : <span className={styles.unassigned}>Unassigned</span>}
                {card.assignee_ids.length === 1 && <span className={styles.ownerName}>{getDisplayName(profiles.get(card.assignee_ids[0]) ?? null, card.assignee_ids[0])}</span>}
              </span>
              {card.due_date && <span className={`${styles.chip} ${new Date(card.due_date) < new Date() && card.status !== 'approved' ? styles.chipLate : ''}`}>{dueLabel(card.due_date)}</span>}
              <span className={styles.chip} data-priority={card.priority}>{card.priority}</span>
              <span className={styles.actions}>
                {card.can_decide && (
                  <>
                    <button type="button" className={styles.decline} disabled={busy === card.id} onClick={() => void decide(card, false)}>Decline</button>
                    <button type="button" className={styles.approve} disabled={busy === card.id} onClick={() => void decide(card, true)}>{busy === card.id ? '…' : 'Approve'}</button>
                  </>
                )}
                {card.status === 'approved' && card.task_id && <Link className={styles.open} to={`/tasks/${card.task_id}`}>Open task →</Link>}
                {card.status === 'pending' && !card.can_decide && <span className={styles.wait}>A project manager approves these</span>}
              </span>
            </div>
          </div>
        </article>
      ))}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

/** Cards for the tasks one AI run proposed, under that run's message. */
export function RunTaskCards({ channelId, runId }: { channelId: string; runId: string }) {
  const cards = useTaskCards(channelId);
  const mine = (cards.data ?? []).filter((c) => c.agent_run_id === runId);
  if (!mine.length) return null;
  return <TaskCardList channelId={channelId} cards={mine} />;
}

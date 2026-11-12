import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/features/platform/client';
import { platform } from '@/lib/platform';

type RunStatus = 'reserving' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;

export interface AiSession {
  id: string;
  channel_id: string;
  agent_id: string;
  started_by: string;
  started_at: string;
  status: 'active' | 'finished';
  message_count: number | null;
  review_run_id: string | null;
  review_requested_at: string | null;
  review_status: RunStatus;
  review_attempt: number;
  notes_run_id: string | null;
  notes_status: RunStatus;
  notes_attempt: number;
}

export interface ReviewResult {
  review: 'queued' | 'ready' | 'failed';
  error?: string;
}

export interface FinishResult {
  notes: 'queued' | 'ready' | 'none' | 'failed';
  error?: string;
}

export interface CancelResult {
  cancelled: true;
}

interface NoteTaker {
  id: string;
  name: string;
}

const POLL_INTERVAL_MS = 2_000;
const TRANSIENT_RUN_STATUSES = new Set<RunStatus>(['reserving', 'queued', 'running']);
const VISIBLE_FINISHED_NOTES_STATUSES = new Set<RunStatus>(['reserving', 'queued', 'running', 'failed', 'cancelled', 'interrupted']);
const RUN_STATUS_PROGRESS: Record<Exclude<RunStatus, null>, number> = {
  reserving: 1,
  queued: 2,
  running: 3,
  completed: 4,
  failed: 4,
  cancelled: 4,
  interrupted: 4,
};

function isVisibleSession(session: AiSession): boolean {
  return session.status === 'active'
    || (session.status === 'finished' && VISIBLE_FINISHED_NOTES_STATUSES.has(session.notes_status));
}

function statusProgress(status: RunStatus): number {
  return status ? RUN_STATUS_PROGRESS[status] : 0;
}

/** Avoid regressing the UI when a slower poll completes after a realtime event. */
function isAtLeastAsFresh(next: AiSession, current: AiSession): boolean {
  if (next.id !== current.id) return next.started_at >= current.started_at;
  if (next.status === 'active' && current.status === 'finished') return false;
  if (next.review_attempt < current.review_attempt || next.notes_attempt < current.notes_attempt) return false;
  if (next.review_attempt === current.review_attempt
    && statusProgress(next.review_status) < statusProgress(current.review_status)) return false;
  if (next.notes_attempt === current.notes_attempt
    && statusProgress(next.notes_status) < statusProgress(current.notes_status)) return false;
  return true;
}

async function fetchVisibleSession(channelId: string, signal: AbortSignal): Promise<AiSession | null | undefined> {
  const { data, error } = await platform
    .from<AiSession>('conversation_ai_sessions')
    .select('*')
    .eq('channel_id', channelId)
    .or('status.eq.active,and(status.eq.finished,notes_status.in.(reserving,queued,running,failed,cancelled,interrupted))')
    .order('started_at', { ascending: false })
    .limit(1)
    .abortSignal(signal)
    .maybeSingle();
  // A temporary request failure must not make an in-flight session disappear.
  return error ? undefined : data ?? null;
}

/**
 * The AI notes session for a supported conversation: whether the notes agent
 * is present and the shared review/finalization progress. Participants follow
 * changes live.
 */
export function useAiSession(workspaceId: string | undefined, channelId: string | undefined) {
  const [session, setSession] = useState<AiSession | null>(null);
  const [agentResult, setAgentResult] = useState<{ workspaceId: string; agent: NoteTaker | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const endingSessionIdsRef = useRef(new Set<string>());
  // Key the result by workspace so the previous workspace's agent disappears
  // during the render that switches workspaces, before effects run.
  const agent = workspaceId && agentResult?.workspaceId === workspaceId ? agentResult.agent : null;
  const sessionId = session?.id;
  const reviewStatus = session?.review_status;
  const notesStatus = session?.notes_status;

  useEffect(() => {
    setAgentResult(null);
    if (!workspaceId) return;
    let cancelled = false;
    platform.rpc<Array<{ id: string; name: string; template_key: string | null; status: string }>>('agent_directory', { p_workspace_id: workspaceId }).then(
      ({ data }) => {
        if (cancelled) return;
        const found = (data ?? []).find((a) => a.template_key === 'cerebras_writer' && a.status === 'active');
        setAgentResult({ workspaceId, agent: found ? { id: found.id, name: found.name } : null });
      },
      () => {
        if (!cancelled) setAgentResult({ workspaceId, agent: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    setSession(null);
    if (!channelId) return;
    let cancelled = false;
    const controller = new AbortController();
    fetchVisibleSession(channelId, controller.signal)
      .then((data) => {
        if (!cancelled && data !== undefined) setSession(data);
      })
      .catch(() => undefined);
    const channel = platform
      .channel(`ai-session:${channelId}:${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_ai_sessions', filter: `channel_id=eq.${channelId}` }, (payload) => {
        const row = payload.new as AiSession;
        if (!row?.id) return;
        setSession((current) => {
          if (!isVisibleSession(row)) return current?.id === row.id ? null : current;
          if (!current || isAtLeastAsFresh(row, current)) return row;
          return current;
        });
      })
      .subscribe();
    return () => {
      cancelled = true;
      controller.abort();
      platform.removeChannel(channel);
    };
  }, [channelId]);

  // Realtime can be interrupted by proxies, mobile sleep, or a brief network
  // change. Poll only while work is in flight, then stop automatically.
  useEffect(() => {
    if (!channelId || !sessionId
      || (!TRANSIENT_RUN_STATUSES.has(reviewStatus ?? null)
        && !TRANSIENT_RUN_STATUSES.has(notesStatus ?? null))) return;
    const expectedSessionId = sessionId;
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      try {
        const data = await fetchVisibleSession(channelId, controller.signal);
        if (cancelled || data === undefined) return;
        setSession((current) => {
          if (!data) return current?.id === expectedSessionId ? null : current;
          if (!current || isAtLeastAsFresh(data, current)) return data;
          return current;
        });
      } catch {
        // Keep the last known state and try again; realtime may recover first.
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [channelId, sessionId, reviewStatus, notesStatus]);

  const start = useCallback(async () => {
    if (!channelId || !agent) return;
    setBusy(true);
    try {
      const response = await api('agents/sessions', { action: 'start', channel_id: channelId, agent_id: agent.id });
      const body = (await response.json()) as { session: AiSession };
      setSession(body.session);
    } finally {
      setBusy(false);
    }
  }, [channelId, agent]);

  const review = useCallback(async (): Promise<ReviewResult | null> => {
    if (!session) return null;
    setBusy(true);
    try {
      const response = await api('agents/sessions', { action: 'review', session_id: session.id });
      const body = (await response.json()) as ReviewResult & { session: AiSession };
      if (!endingSessionIdsRef.current.has(session.id)) setSession(body.session);
      return body;
    } finally {
      setBusy(false);
    }
  }, [session]);

  const finish = useCallback(async (): Promise<FinishResult | null> => {
    if (!session) return null;
    setBusy(true);
    try {
      const response = await api('agents/sessions', { action: 'finish', session_id: session.id });
      const body = (await response.json()) as FinishResult & { session: AiSession };
      if (!endingSessionIdsRef.current.has(session.id)) {
        setSession(isVisibleSession(body.session) ? body.session : null);
      }
      return body;
    } finally {
      setBusy(false);
    }
  }, [session]);

  const cancel = useCallback(async (): Promise<CancelResult | null> => {
    if (!session) return null;
    const sessionIdToEnd = session.id;
    endingSessionIdsRef.current.add(sessionIdToEnd);
    setCancelling(true);
    try {
      const response = await api('agents/sessions', { action: 'cancel', session_id: sessionIdToEnd });
      const body = (await response.json()) as CancelResult;
      if (body.cancelled !== true) throw new Error('The notes session could not be ended.');
      setSession(null);
      return body;
    } catch (error) {
      endingSessionIdsRef.current.delete(sessionIdToEnd);
      throw error;
    } finally {
      setCancelling(false);
    }
  }, [session]);

  return { session, agent, busy, cancelling, start, review, finish, cancel };
}

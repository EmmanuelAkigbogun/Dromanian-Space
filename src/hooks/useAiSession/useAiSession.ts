import { useCallback, useEffect, useState } from 'react';
import { api } from '@/features/platform/client';
import { platform } from '@/lib/platform';

export interface AiSession {
  id: string;
  channel_id: string;
  agent_id: string;
  started_by: string;
  started_at: string;
  status: 'active' | 'finished';
  notes_run_id: string | null;
}

export interface FinishResult {
  notes: 'queued' | 'none' | 'failed';
  error?: string;
}

interface NoteTaker {
  id: string;
  name: string;
}

/**
 * The AI session of a direct conversation: whether Scribe is currently in it,
 * and starting or finishing one. Both participants follow changes live.
 */
export function useAiSession(workspaceId: string | undefined, channelId: string | undefined) {
  const [session, setSession] = useState<AiSession | null>(null);
  const [agent, setAgent] = useState<NoteTaker | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    platform.rpc<Array<{ id: string; name: string; template_key: string | null; status: string }>>('agent_directory', { p_workspace_id: workspaceId }).then(({ data }) => {
      if (cancelled) return;
      const found = (data ?? []).find((a) => a.template_key === 'note_taker' && a.status === 'active');
      setAgent(found ? { id: found.id, name: found.name } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    setSession(null);
    if (!channelId) return;
    let cancelled = false;
    platform
      .from<AiSession>('conversation_ai_sessions')
      .select('*')
      .eq('channel_id', channelId)
      .eq('status', 'active')
      .maybeSingle()
      .then(({ data }) => !cancelled && setSession(data ?? null));
    const channel = platform
      .channel(`ai-session:${channelId}:${Math.random().toString(36).slice(2, 9)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_ai_sessions', filter: `channel_id=eq.${channelId}` }, (payload) => {
        const row = payload.new as AiSession;
        if (!row?.id) return;
        setSession((current) => (row.status === 'active' ? row : current?.id === row.id ? null : current));
      })
      .subscribe();
    return () => {
      cancelled = true;
      platform.removeChannel(channel);
    };
  }, [channelId]);

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

  const finish = useCallback(async (): Promise<FinishResult | null> => {
    if (!session) return null;
    setBusy(true);
    try {
      const response = await api('agents/sessions', { action: 'finish', session_id: session.id });
      const body = (await response.json()) as FinishResult;
      setSession(null);
      return body;
    } finally {
      setBusy(false);
    }
  }, [session]);

  return { session, agent, busy, start, finish };
}

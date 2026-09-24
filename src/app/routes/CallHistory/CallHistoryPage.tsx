import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { getCallHistory, deleteCallHistory } from '@/lib/call/call';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import type { CallSession } from '@/types';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getStatusColor(status: string) {
  switch (status) {
    case 'ended': return 'var(--color-success, #22c55e)';
    case 'missed': return 'var(--color-error, #ef4444)';
    case 'declined': return 'var(--color-warning, #f59e0b)';
    case 'cancelled': return 'var(--color-text-muted)';
    default: return 'var(--color-text-muted)';
  }
}

function CallIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function CallHistoryPage() {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!userId || !currentWorkspace) return;
    setLoading(true);
    getCallHistory(userId, currentWorkspace.id, { limit: 50 })
      .then((data) => { setCalls(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [userId, currentWorkspace?.id]);

  async function handleConfirmDelete() {
    if (!userId || !deletingId) return;
    setIsDeleting(true);
    const ok = await deleteCallHistory(deletingId, userId);
    setIsDeleting(false);
    if (ok) {
      toast({ variant: 'success', description: 'Call deleted from history' });
      setCalls((prev) => prev.filter((c) => c.id !== deletingId));
    } else {
      toast({ variant: 'error', description: 'Failed to delete call' });
    }
    setDeletingId(null);
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
        Loading call history...
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 'var(--space-4)', opacity: 0.5 }}>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          <line x1="23" y1="1" x2="1" y2="23" />
        </svg>
        <p>No call history yet</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {calls.map((call) => (
          <div
            key={call.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              padding: 'var(--space-3) var(--space-4)',
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <span style={{ color: 'var(--color-text)', display: 'inline-flex', flexShrink: 0 }}>
              <CallIcon />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text)' }}>
                {call.call_type === 'group' ? 'Group Call' : call.call_type === 'channel' ? 'Channel Call' : 'Direct Call'}
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: getStatusColor(call.status), textTransform: 'capitalize' }}>
                {call.status}
                {call.duration ? ` · ${formatDuration(call.duration)}` : ''}
              </div>
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
              {new Date(call.created_at).toLocaleDateString()} {new Date(call.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            <button
              type="button"
              onClick={() => setDeletingId(call.id)}
              title="Delete permanently"
              aria-label="Delete call"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '32px',
                flexShrink: 0,
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-error)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-error)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)';
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={deletingId !== null}
        title="Delete call"
        message="Delete this call from your history permanently? This cannot be undone."
        confirmLabel="Delete"
        danger
        loading={isDeleting}
        onConfirm={handleConfirmDelete}
        onClose={() => {
          if (!isDeleting) setDeletingId(null);
        }}
      />
    </div>
  );
}

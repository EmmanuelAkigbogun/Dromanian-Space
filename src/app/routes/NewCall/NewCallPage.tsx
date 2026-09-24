import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useCallContextSafe } from '@/app/providers/CallProvider/CallProvider';
import { usePresenceContext } from '@/app/providers/PresenceProvider';
import { PresenceIndicator } from '@/components/presence/PresenceIndicator/PresenceIndicator';
import { getPresenceLabel } from '@/lib/presence';

interface UserProfile {
  id: string;
  display_name: string | null;
  email: string;
  avatar_url: string | null;
}

export function NewCallPage() {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { startCall, callScreen } = useCallContextSafe() ?? {};
  const { presenceMap } = usePresenceContext();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentWorkspace?.id) return;
    const fetchUsers = async () => {
      const { data: members } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', currentWorkspace.id);
      if (!members || members.length === 0) return;
      const memberIds = members.map((m: any) => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, email, avatar_url')
        .in('id', memberIds)
        .neq('id', userId ?? '');
      setUsers((profiles as UserProfile[]) ?? []);
    };
    fetchUsers();
  }, [currentWorkspace?.id, userId]);

  useEffect(() => {
    if (callScreen !== 'none') {
      navigate('/calls');
    }
  }, [callScreen, navigate]);

  const filtered = users.filter(
    (u) =>
      (u.display_name?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  const toggleUser = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCall = async (withVideo: boolean) => {
    if (selected.size === 0 || !startCall) return;
    setLoading(true);
    const participantIds = Array.from(selected);
    if (participantIds.length === 1) {
      await startCall(participantIds[0], 'direct', [], withVideo);
    } else {
      await startCall(participantIds[0], 'group', participantIds, withVideo);
    }
    setLoading(false);
  };

  if (callScreen !== 'none') return null;

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: '600px', margin: '0 auto' }}>
      <input
        type="text"
        placeholder="Search people..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: '100%',
          padding: 'var(--space-3)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          backgroundColor: 'var(--color-surface)',
          color: 'var(--color-text)',
          fontSize: 'var(--font-size-sm)',
          marginBottom: 'var(--space-4)',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', maxHeight: '400px', overflowY: 'auto', marginBottom: 'var(--space-6)' }}>
        {filtered.map((user) => (
          <button
            key={user.id}
            type="button"
            onClick={() => toggleUser(user.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              border: selected.has(user.id) ? '2px solid var(--color-primary)' : '2px solid transparent',
              borderRadius: 'var(--radius-lg)',
              backgroundColor: selected.has(user.id) ? 'rgba(var(--color-primary-rgb, 99, 102, 241), 0.08)' : 'var(--color-surface)',
              color: 'var(--color-text)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'all 0.15s ease',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: 'var(--color-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
              }}
            >
              {user.display_name?.[0]?.toUpperCase() ?? user.email[0].toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-sm)' }}>
                {user.display_name || user.email}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                <PresenceIndicator status={presenceMap.get(user.id)?.status ?? 'offline'} size="sm" />
                {getPresenceLabel(presenceMap.get(user.id)?.status)}
              </div>
            </div>
            {selected.has(user.id) && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--color-primary)" stroke="none">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            )}
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--space-8)' }}>
            {search ? 'No users found' : 'No workspace members'}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'center' }}>
          <button
            type="button"
            disabled={loading}
            onClick={() => handleCall(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-5)',
              borderRadius: 'var(--radius-lg)',
              border: 'none',
              backgroundColor: 'var(--color-primary)',
              color: 'white',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 'var(--font-weight-medium)',
              fontSize: 'var(--font-size-sm)',
              opacity: loading ? 0.6 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
            </svg>
            Voice Call ({selected.size})
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => handleCall(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-5)',
              borderRadius: 'var(--radius-lg)',
              border: 'none',
              backgroundColor: '#22c55e',
              color: 'white',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 'var(--font-weight-medium)',
              fontSize: 'var(--font-size-sm)',
              opacity: loading ? 0.6 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 7l-7 5 7 5V7z" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            Video Call ({selected.size})
          </button>
        </div>
      )}
    </div>
  );
}

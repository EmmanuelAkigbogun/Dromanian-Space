// The conversation's side panel, after WhatsApp's "contact info" and Teams'
// Files / Participants tabs: what was shared here, grouped by type, and who
// is in the conversation with their status.
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { platform } from '@/lib/platform';
import { useAuth } from '@/hooks/useAuth';
import { useProfiles } from '@/hooks/useProfiles';
import { usePresenceContext } from '@/app/providers/PresenceProvider';
import { Avatar } from '@/components/ui/Avatar';
import { getAttachmentsByMessageIds, getSignedUrl, formatFileSize, LINK_ATTACHMENT_TYPE } from '@/lib/message/attachment';
import { extractUrls } from '@/lib/message/richText';
import { getDisplayName } from '@/lib/message';
import { presenceToAvatarStatus, getPresenceLabel } from '@/lib/presence';
import type { FileAttachment } from '@/types';
import { TaskCardList, useTaskCards } from '@/components/chat/TaskCards/TaskCards';
import styles from './ChatInfoPanel.module.css';

type Group = 'documents' | 'photos' | 'videos' | 'audio' | 'other';
const GROUPS: { id: Group; label: string; icon: ReactNode }[] = [
  { id: 'documents', label: 'Documents', icon: <path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" /> },
  { id: 'photos', label: 'Photos', icon: <path d="M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 9.5h.01" /> },
  { id: 'videos', label: 'Videos', icon: <path d="M4 6h11v12H4zM15 10.5l5-3v9l-5-3" /> },
  { id: 'audio', label: 'Voice & audio', icon: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" /> },
  { id: 'other', label: 'Other', icon: <path d="M5 4h14v16H5zM9 8h6M9 12h6" /> },
];

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

const DOC = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|md|json)$/i;
function groupOf(a: FileAttachment): Group {
  if (a.file_type.startsWith('image/')) return 'photos';
  if (a.file_type.startsWith('video/')) return 'videos';
  if (a.file_type.startsWith('audio/')) return 'audio';
  if (DOC.test(a.file_name) || a.file_type.startsWith('text/') || a.file_type.includes('pdf') || a.file_type.includes('officedocument')) return 'documents';
  return 'other';
}

interface Props {
  channelId: string;
  title: string;
  subtitle?: string;
  avatar: ReactNode;
  onClose: () => void;
  /** Start on another tab. */
  initialTab?: Tab;
  /** Group owner or admin: may remove people (never the owner). */
  ownerId?: string | null;
  onRemoveMember?: (userId: string) => Promise<void>;
}

type Tab = 'files' | 'tasks' | 'people';

export function ChatInfoPanel({ channelId, title, subtitle, avatar, onClose, initialTab = 'files', ownerId, onRemoveMember }: Props) {
  const { userId } = useAuth();
  const [tab, setTab] = useState<Tab>(initialTab);
  const tasks = useTaskCards(channelId);
  const pendingTasks = (tasks.data ?? []).filter((t) => t.status === 'pending').length;
  const [open, setOpen] = useState<Group | 'links' | null>(null);

  const shared = useQuery({
    queryKey: ['chat-info', channelId, 'shared'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await platform.from('messages').select('id,content,created_at').eq('channel_id', channelId).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(2000);
      const messages = (data ?? []) as { id: string; content: string; created_at: string }[];
      const files: FileAttachment[] = [];
      for (let i = 0; i < messages.length; i += 200) {
        const batch = await getAttachmentsByMessageIds(messages.slice(i, i + 200).map((m) => m.id));
        batch.forEach((list) => files.push(...list));
      }
      const links = new Map<string, string>();
      for (const f of files) if (f.file_type === LINK_ATTACHMENT_TYPE) links.set(f.file_url, f.created_at);
      for (const m of messages) for (const url of extractUrls(m.content)) if (!links.has(url)) links.set(url, m.created_at);
      const real = files.filter((f) => f.file_type !== LINK_ATTACHMENT_TYPE).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { files: real, links: [...links.entries()].map(([url, at]) => ({ url, at })).sort((a, b) => b.at.localeCompare(a.at)) };
    },
  });

  const members = useQuery({
    queryKey: ['chat-info', channelId, 'members'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await platform.from('channel_members').select('user_id').eq('channel_id', channelId);
      return ((data ?? []) as { user_id: string }[]).map((m) => m.user_id);
    },
  });
  const { profiles } = useProfiles(members.data ?? []);
  const { presenceMap } = usePresenceContext();

  const groups = useMemo(() => {
    const out = new Map<Group, FileAttachment[]>(GROUPS.map((g) => [g.id, []]));
    for (const f of shared.data?.files ?? []) out.get(groupOf(f))!.push(f);
    return out;
  }, [shared.data]);

  const people = useMemo(() => {
    const rank = (id: string) => ({ online: 0, busy: 1, away: 2 } as Record<string, number>)[presenceMap.get(id)?.status ?? ''] ?? 3;
    return [...(members.data ?? [])].sort((a, b) => rank(a) - rank(b) || getDisplayName(profiles.get(a) ?? null, a).localeCompare(getDisplayName(profiles.get(b) ?? null, b)));
  }, [members.data, presenceMap, profiles]);

  const openFile = async (f: FileAttachment) => {
    const url = await getSignedUrl(f.file_url);
    if (url) window.open(url, '_blank', 'noopener');
  };

  const total = shared.data?.files.length ?? 0;
  const linkCount = shared.data?.links.length ?? 0;

  return (
    <aside className={styles.panel} aria-label="Conversation details">
      <header className={styles.head}>
        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? styles.tabOn : undefined} onClick={() => setTab('files')}>Files</button>
          <button type="button" role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? styles.tabOn : undefined} onClick={() => setTab('tasks')}>
            Tasks{pendingTasks ? <span className={styles.badge}>{pendingTasks}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? styles.tabOn : undefined} onClick={() => setTab('people')}>
            People{members.data ? ` (${members.data.length})` : ''}
          </button>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close details">×</button>
      </header>

      <div className={styles.body}>
        <div className={styles.identity}>
          <span className={styles.identityAvatar}>{avatar}</span>
          <h3>{title}</h3>
          {subtitle && <span>{subtitle}</span>}
        </div>

        {tab === 'tasks' ? (
          <section className={styles.section}>
            <h4>Tasks proposed in this conversation</h4>
            {tasks.data?.length ? <TaskCardList channelId={channelId} cards={tasks.data} compact /> : <p className={styles.muted}>{tasks.isPending ? 'Loading…' : 'No tasks yet. The AI proposes them in its summaries and notes.'}</p>}
          </section>
        ) : tab === 'files' ? (
          <>
            <div className={styles.tiles}>
              <button type="button" className={`${styles.tile} ${styles.tileFiles} ${open && open !== 'links' ? styles.tileOn : ''}`} onClick={() => setOpen(open && open !== 'links' ? null : 'documents')}>
                <span>All files</span>
                <strong>{shared.isPending ? '…' : total}</strong>
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>
              </button>
              <button type="button" className={`${styles.tile} ${open === 'links' ? styles.tileOn : ''}`} onClick={() => setOpen(open === 'links' ? null : 'links')}>
                <span>All links</span>
                <strong>{shared.isPending ? '…' : linkCount}</strong>
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
              </button>
            </div>

            {open === 'links' ? (
              <section className={styles.section}>
                <h4>Links</h4>
                {shared.data?.links.slice(0, 100).map((l) => (
                  <a key={l.url} className={styles.linkRow} href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                    <span className={styles.favicon} aria-hidden="true">{hostOf(l.url).slice(0, 1).toUpperCase()}</span>
                    <span className={styles.rowText}><strong>{hostOf(l.url)}</strong><span>{l.url.replace(/^https?:\/\/(www\.)?/, '')}</span></span>
                  </a>
                ))}
                {!linkCount && <p className={styles.muted}>No links shared yet.</p>}
              </section>
            ) : (
              <section className={styles.section}>
                <h4>File type</h4>
                {GROUPS.map((g) => {
                  const list = groups.get(g.id) ?? [];
                  const size = list.reduce((n, f) => n + (f.file_size || 0), 0);
                  const expanded = open === g.id;
                  return (
                    <div key={g.id}>
                      <button type="button" className={styles.typeRow} data-group={g.id} aria-expanded={expanded} disabled={!list.length} onClick={() => setOpen(expanded ? null : g.id)}>
                        <span className={styles.typeIcon} aria-hidden="true"><svg viewBox="0 0 24 24">{g.icon}</svg></span>
                        <span className={styles.rowText}><strong>{g.label}</strong><span>{list.length} {list.length === 1 ? 'file' : 'files'}{size ? `, ${formatFileSize(size)}` : ''}</span></span>
                        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden="true">›</span>
                      </button>
                      {expanded && (
                        <ul className={styles.fileList}>
                          {list.slice(0, 60).map((f) => (
                            <li key={f.id}>
                              <button type="button" onClick={() => void openFile(f)} title={`Open ${f.file_name}`}>
                                <span className={styles.fileName}>{f.file_name}</span>
                                <span className={styles.fileMeta}>{formatFileSize(f.file_size)} · {new Date(f.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
                              </button>
                            </li>
                          ))}
                          {list.length > 60 && <li className={styles.muted}>Showing the 60 newest.</li>}
                        </ul>
                      )}
                    </div>
                  );
                })}
                {shared.isError && <p className={styles.muted}>Couldn’t load shared files.</p>}
              </section>
            )}
          </>
        ) : (
          <section className={styles.section}>
            {people.map((id) => {
              const status = presenceMap.get(id)?.status;
              const profile = profiles.get(id) ?? null;
              const name = getDisplayName(profile, id);
              return (
                <div key={id} className={styles.person}>
                  <Avatar src={profile?.avatar_url || undefined} name={name} size="sm" status={presenceToAvatarStatus(status)} />
                  <span className={styles.rowText}>
                    <strong>{name}{id === userId && <em> (you)</em>}</strong>
                    <span>{id === ownerId ? 'Group owner · ' : ''}{getPresenceLabel(status)}</span>
                  </span>
                  {onRemoveMember && id !== ownerId && id !== userId && (
                    <button type="button" className={styles.removePerson} title={`Remove ${name}`} aria-label={`Remove ${name} from the group`}
                      onClick={() => { if (window.confirm(`Remove ${name} from this group?`)) void onRemoveMember(id).then(() => members.refetch()); }}>Remove</button>
                  )}
                </div>
              );
            })}
            {members.isPending && <p className={styles.muted}>Loading participants…</p>}
          </section>
        )}
      </div>
    </aside>
  );
}

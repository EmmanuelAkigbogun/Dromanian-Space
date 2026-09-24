import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { SearchInput } from '@/components/ui/SearchInput';
import { Avatar } from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useConversation } from '@/hooks/useConversation';
import { useToast } from '@/components/ui/Toast';
import { getWorkspaceChannels, getWorkspaceMembersWithProfiles } from '@/lib/channel';
import type { WorkspaceMemberWithProfile } from '@/lib/channel';
import { getDisplayName, sendMessage } from '@/lib/message';
import { copyAttachmentsForForward } from '@/lib/message/attachment';
import type { Channel, Message } from '@/types';
import styles from './ShareMessageDialog.module.css';

interface ShareMessageDialogProps {
  open: boolean;
  onClose: () => void;
  message?: Message;
  messages?: Message[];
  excludeChannelId?: string;
}

const CHANNEL_KEY = 'channel';
const MEMBER_KEY = 'member';

function targetKey(kind: 'channel' | 'member', id: string): string {
  return `${kind}:${id}`;
}

export function ShareMessageDialog({
  open,
  onClose,
  message,
  messages,
  excludeChannelId,
}: ShareMessageDialogProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { startDm } = useConversation();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<WorkspaceMemberWithProfile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [content, setContent] = useState(message?.content ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isSending, setIsSending] = useState(false);

  const messageList = useMemo<Message[]>(
    () => (messages && messages.length > 0 ? messages : message ? [message] : []),
    [messages, message],
  );
  const isBulk = messageList.length > 1;

  useEffect(() => {
    if (!open || !currentWorkspace) return;

    setQuery('');
    setContent(messageList.length === 1 ? messageList[0].content : '');
    setSelected(new Set());
    setIsSending(false);

    setIsLoading(true);
    Promise.all([
      getWorkspaceMembersWithProfiles(currentWorkspace.id),
      getWorkspaceChannels(currentWorkspace.id),
    ])
      .then(([memberRows, channelRows]) => {
        setMembers(memberRows.filter((m) => m.profile));
        setChannels(channelRows.filter((c) => c.id !== excludeChannelId));
      })
      .finally(() => setIsLoading(false));
  }, [open, currentWorkspace, excludeChannelId, messageList]);

  const filteredMembers = useMemo(() => {
    if (!query.trim()) return members;
    const q = query.toLowerCase();
    return members.filter((m) => {
      const p = m.profile;
      if (!p) return false;
      return (
        p.display_name?.toLowerCase().includes(q) ||
        p.username?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q)
      );
    });
  }, [members, query]);

  const filteredChannels = useMemo(() => {
    if (!query.trim()) return channels;
    const q = query.toLowerCase();
    return channels.filter((c) => c.name?.toLowerCase().includes(q));
  }, [channels, query]);

  const toggleTarget = useCallback((kind: 'channel' | 'member', id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = targetKey(kind, id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    setQuery('');
    setSelected(new Set());
    setIsSending(false);
    onClose();
  }, [onClose]);

  const handleForward = useCallback(async () => {
    if (!userId || isSending || selected.size === 0 || messageList.length === 0) return;

    setIsSending(true);
    const keys = [...selected];
    const results = await Promise.allSettled(
      keys.flatMap((key) =>
        messageList.map(async (msg) => {
          const [kind, id] = key.split(':') as [string, string];
          let channelId = id;
          if (kind === MEMBER_KEY) {
            const conv = await startDm(id);
            if (!conv) return false;
            channelId = conv.channel_id;
          }
          const body = isBulk ? msg.content : content;
          const sent = await sendMessage(channelId, userId, body, {
            forwardedFromMessageId: msg.id,
            attachmentsLayout: msg.attachments_layout,
          });
          if (!sent) return false;
          await copyAttachmentsForForward(msg.id, sent.id, userId).catch(() => {});
          return true;
        }),
      ),
    );

    const forwarded = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
    setIsSending(false);

    if (forwarded > 0) {
      toast({
        description: `Forwarded ${isBulk ? `${messageList.length} messages` : 'message'} to ${forwarded} ${forwarded > 1 ? 'targets' : 'target'}`,
        variant: 'success',
      });
      handleClose();
    } else {
      toast({ description: 'Failed to forward messages', variant: 'error' });
    }
  }, [userId, isSending, selected, startDm, content, messageList, isBulk, toast, handleClose]);

  const showChannels = filteredChannels.length > 0;
  const showMembers = filteredMembers.length > 0;

  const CheckIcon = ({ checked }: { checked: boolean }) => (
    <span className={`${styles.checkbox} ${checked ? styles.checkboxChecked : ''}`}>
      {checked && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );

  return (
    <Dialog open={open} onClose={handleClose} title={isBulk ? 'Forward messages' : 'Forward message'}>
      <div className={styles.content}>
        {isBulk ? (
          <div className={styles.preview}>
            <span className={styles.previewLabel}>{messageList.length} messages</span>
            <div className={styles.bulkPreview}>
              {messageList.map((msg) => (
                <div key={msg.id} className={styles.bulkPreviewItem}>
                  {msg.content || 'Attachment'}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.preview}>
            <span className={styles.previewLabel}>Message</span>
            <textarea
              className={styles.textarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder="Edit the message before forwarding..."
            />
          </div>
        )}

        <SearchInput
          placeholder="Search channels and members..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          className={styles.searchInput}
        />

        {isLoading ? (
          <div className={styles.loading}>
            <Spinner size="sm" />
          </div>
        ) : !showChannels && !showMembers ? (
          <div className={styles.empty}>
            {query ? 'No channels or members found' : 'No channels or members available'}
          </div>
        ) : (
          <div className={styles.list}>
            {showChannels && (
              <>
                <div className={styles.sectionTitle}>Channels</div>
                {filteredChannels.map((channel) => {
                  const key = targetKey(CHANNEL_KEY, channel.id);
                  const checked = selected.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.item} ${checked ? styles.itemSelected : ''}`}
                      onClick={() => toggleTarget(CHANNEL_KEY, channel.id)}
                      disabled={isSending}
                    >
                      <CheckIcon checked={checked} />
                      <span className={styles.channelIcon}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10 6v12M17 6v12M6 8l-4 8M22 8l-4 8M6.5 6h11M6.5 18h11" />
                        </svg>
                      </span>
                      <div className={styles.itemInfo}>
                        <span className={styles.itemName}>{channel.name}</span>
                        {channel.description ? (
                          <span className={styles.itemMeta}>{channel.description}</span>
                        ) : (
                          <span className={styles.itemMeta}>Channel</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            {showMembers && (
              <>
                <div className={styles.sectionTitle}>Direct messages</div>
                {filteredMembers.map((member) => {
                  const profile = member.profile!;
                  const name = getDisplayName(profile, member.user_id);
                  const key = targetKey(MEMBER_KEY, member.user_id);
                  const checked = selected.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.item} ${checked ? styles.itemSelected : ''}`}
                      onClick={() => toggleTarget(MEMBER_KEY, member.user_id)}
                      disabled={isSending}
                    >
                      <CheckIcon checked={checked} />
                      <Avatar src={profile.avatar_url ?? undefined} name={name} size="sm" />
                      <div className={styles.itemInfo}>
                        <span className={styles.itemName}>{name}</span>
                        <span className={styles.itemMeta}>{profile.email}</span>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            {selected.size > 0 ? `${selected.size} selected` : 'Select one or more targets'}
          </span>
          <div className={styles.footerActions}>
            <Button variant="ghost" size="sm" onClick={handleClose} disabled={isSending}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleForward}
              disabled={selected.size === 0 || isSending}
            >
              {isSending ? <Spinner size="sm" /> : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 'var(--space-1)' }}>
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              )}
              {isSending ? 'Forwarding...' : `Forward${selected.size > 0 ? ` (${selected.size})` : ''}`}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

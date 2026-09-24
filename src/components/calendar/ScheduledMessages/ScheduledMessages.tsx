import { useState, useEffect, useRef, useCallback } from 'react';
import { ScrollArea } from '@/components/ui/ScrollArea/ScrollArea';
import { Badge } from '@/components/ui/Badge/Badge';
import { UploadProgress } from '@/components/message/UploadProgress';
import { formatRelativeTime, truncate } from '@/utils';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { formatFileSize, isImageFile } from '@/lib/message';
import { getSignedUrlsBatch } from '@/lib/message/attachment';
import type { ScheduleAttachmentMeta } from '@/lib/message/schedule';
import type { ScheduledMessage, ScheduledMessageAttachment } from '@/types';
import styles from './ScheduledMessages.module.css';

const MAX_FILES = 5;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

interface ScheduleFormData {
  content: string;
  scheduled_at: string;
  channel_id?: string;
  conversation_id?: string;
  files?: File[];
  attachments?: ScheduleAttachmentMeta[];
}

interface UploadingFile {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
}

interface ScheduledMessagesProps {
  messages: ScheduledMessage[];
  onCancel?: (id: string) => void;
  onSchedule?: (data: ScheduleFormData, onProgress?: (file: File, percent: number) => void) => void;
  onResend?: (id: string) => void;
  onEditSave?: (id: string, updates: Partial<Pick<ScheduledMessage, 'content' | 'scheduled_at' | 'channel_id' | 'conversation_id'>>) => void;
}

interface ChannelOption {
  id: string;
  name: string;
  type: 'channel' | 'dm';
}

function toLocalDatetimeString(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function ScheduledAttachmentThumbs({ attachments }: { attachments: ScheduledMessageAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    getSignedUrlsBatch(attachments.map((a) => a.file_url)).then((urlMap) => {
      if (!alive) return;
      const next: Record<string, string> = {};
      urlMap.forEach((url, path) => { if (url) next[path] = url; });
      setUrls(next);
    });
    return () => { alive = false; };
  }, [attachments]);

  return (
    <div className={styles.messageAttachments}>
      {attachments.map((att) => {
        const url = urls[att.file_url];
        if (isImageFile(att.file_type) && url) {
          return <img key={att.id} src={url} alt={att.file_name} className={styles.messageAttachmentThumb} />;
        }
        return (
          <span key={att.id} className={styles.messageAttachmentIcon} title={att.file_name}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </span>
        );
      })}
    </div>
  );
}

export function ScheduledMessages({ messages, onCancel, onSchedule, onResend, onEditSave }: ScheduledMessagesProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [content, setContent] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [targetId, setTargetId] = useState('');
  const datetimeInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [targetType, setTargetType] = useState<'channel' | 'dm'>('channel');
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editScheduledAt, setEditScheduledAt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [targetNames, setTargetNames] = useState<Record<string, string>>({});
  const [existingAttachments, setExistingAttachments] = useState<ScheduledMessageAttachment[]>([]);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    setPendingFiles((prev) => {
      const next = [...prev, ...arr].slice(0, MAX_FILES);
      return next;
    });
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeExistingAttachment = useCallback((id: string) => {
    setExistingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  }, [addFiles]);

  useEffect(() => {
    if (!showForm || !currentWorkspace?.id) return;
    const fetchTargets = async () => {
      const { data: channelData } = await supabase
        .from('channels' as never)
        .select('id, name')
        .eq('workspace_id', currentWorkspace.id)
        .is('archived_at', null)
        .order('name');

      const { data: convData } = await supabase
        .from('direct_conversations' as never)
        .select('id, channel_id')
        .eq('workspace_id', currentWorkspace.id);

      // DM conversations are backed by a channels row named "Direct Message";
      // drop those so only real channels appear in the Channel dropdown.
      const dmChannelIds = new Set(
        ((convData || []) as { channel_id?: string | null }[])
          .map((c) => c.channel_id)
          .filter((id): id is string => Boolean(id)),
      );
      const channelList: ChannelOption[] = (channelData || [])
        .filter((c: { id: string }) => !dmChannelIds.has(c.id))
        .map((c: { id: string; name: string }) => ({
          id: c.id, name: `# ${c.name}`, type: 'channel' as const,
        }));

      const convList: ChannelOption[] = [];
      for (const conv of (convData || []) as { id: string; channel_id?: string | null }[]) {
        const { data: participants } = await supabase
          .from('direct_conversation_participants' as never)
          .select('user_id')
          .eq('conversation_id', conv.id);
        const userIds = (participants || []).map((p: { user_id: string }) => p.user_id);
        if (userIds.length === 0) continue;
        // Show only the other participants, not the current user.
        const otherUserIds = userIds.filter((id) => id !== userId);
        const targetUserIds = otherUserIds.length > 0 ? otherUserIds : userIds;
        const { data: profiles } = await supabase
          .from('profiles' as never)
          .select('id, display_name, username')
          .in('id', targetUserIds);
        const names = (profiles || [])
          .map((p: { display_name?: string; username?: string }) => p.display_name || p.username || 'Unknown')
          .join(', ');
        convList.push({ id: conv.id, name: names || `DM`, type: 'dm' });
      }

      setChannels([...channelList, ...convList]);
    };
    fetchTargets();
  }, [showForm, currentWorkspace?.id, userId]);

  useEffect(() => {
    if (!currentWorkspace?.id) return;
    let cancelled = false;
    const resolveNames = async () => {
      const channelIds = messages
        .map((m) => m.channel_id)
        .filter((id): id is string => Boolean(id));
      const conversationIds = messages
        .map((m) => m.conversation_id)
        .filter((id): id is string => Boolean(id));
      const map: Record<string, string> = {};

      if (channelIds.length > 0) {
        const { data: channelData } = await supabase
          .from('channels' as never)
          .select('id, name')
          .in('id', [...new Set(channelIds)]);
        for (const c of (channelData || []) as { id: string; name: string }[]) {
          map[c.id] = `# ${c.name}`;
        }
      }

      if (conversationIds.length > 0) {
        const { data: convData } = await supabase
          .from('direct_conversations' as never)
          .select('id')
          .in('id', [...new Set(conversationIds)]);
        for (const conv of (convData || []) as { id: string }[]) {
          const { data: participants } = await supabase
            .from('direct_conversation_participants' as never)
            .select('user_id')
            .eq('conversation_id', conv.id);
          const userIds = (participants || []).map((p: { user_id: string }) => p.user_id);
          if (userIds.length === 0) {
            map[conv.id] = 'Direct';
            continue;
          }
          // Show only the other participants, not the current user.
          const otherUserIds = userIds.filter((id) => id !== userId);
          const targetUserIds = otherUserIds.length > 0 ? otherUserIds : userIds;
          const { data: profiles } = await supabase
            .from('profiles' as never)
            .select('id, display_name, username')
            .in('id', targetUserIds);
          const names = (profiles || [])
            .map((p: { display_name?: string; username?: string }) => p.display_name || p.username || 'Unknown')
            .join(', ');
          map[conv.id] = names || 'Direct';
        }
      }

      if (!cancelled) setTargetNames(map);
    };
    resolveNames();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspace?.id, messages, userId]);

  const handleSubmit = async () => {
    if ((!content.trim() && pendingFiles.length === 0 && existingAttachments.length === 0) || !scheduledAt) return;
    const data: ScheduleFormData = {
      content: content.trim(),
      scheduled_at: new Date(scheduledAt).toISOString(),
    };
    if (existingAttachments.length > 0) {
      data.attachments = existingAttachments.map((a) => ({
        file_url: a.file_url,
        file_name: a.file_name,
        file_size: a.file_size,
        file_type: a.file_type,
      }));
    }
    if (targetId) {
      if (targetType === 'channel') data.channel_id = targetId;
      else data.conversation_id = targetId;
    }
    let submitted: Promise<unknown> | undefined;
    if (pendingFiles.length > 0) {
      data.files = pendingFiles;
      setUploadingFiles(pendingFiles.map((file, i) => ({
        id: `sm-upload-${Date.now()}-${i}`,
        file,
        progress: 0,
        status: 'uploading' as const,
      })));
      submitted = onSchedule?.(data, (file, percent) => {
        setUploadingFiles((prev) =>
          prev.map((f) => (f.file === file ? { ...f, progress: percent } : f)),
        );
      }) as unknown as Promise<unknown> | undefined;
    } else {
      submitted = onSchedule?.(data) as unknown as Promise<unknown> | undefined;
    }
    await submitted;
    setUploadingFiles([]);
    setContent('');
    setScheduledAt('');
    setTargetId('');
    setPendingFiles([]);
    setExistingAttachments([]);
    setAttachmentUrls({});
    setShowForm(false);
  };

  const handleEditSave = () => {
    if (!editingId || !editContent.trim() || !editScheduledAt) return;
    onEditSave?.(editingId, {
      content: editContent.trim(),
      scheduled_at: new Date(editScheduledAt).toISOString(),
    });
    setEditingId(null);
  };

  const startEdit = (msg: ScheduledMessage) => {
    setEditingId(msg.id);
    setEditContent(msg.content);
    setEditScheduledAt(toLocalDatetimeString(msg.scheduled_at));
  };

  const header = (
    <div className={styles.header}>
      <span className={styles.title}>Scheduled Messages</span>
      <div className={styles.headerActions}>
        {messages.filter((m) => !m.sent).length > 0 && (
          <Badge variant="primary" size="sm">{messages.filter((m) => !m.sent).length}</Badge>
        )}
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setShowForm(!showForm)}
          title="Schedule a message"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <div className={styles.container}>
      {header}

      {showForm && (
        <div className={styles.form}>
          <textarea
            className={styles.formTextarea}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type your message..."
            rows={3}
          />
          <div className={styles.attachRow}>
            <button
              type="button"
              className={styles.attachButton}
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.txt"
              onChange={handleFileInput}
              style={{ display: 'none' }}
            />
            {(pendingFiles.length + existingAttachments.length) > 0 && (
              <span className={styles.fileCount}>
                {pendingFiles.length + existingAttachments.length} file{pendingFiles.length + existingAttachments.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          {(pendingFiles.length + existingAttachments.length) > 0 && (
            <div className={styles.filePreviewGrid}>
              {existingAttachments.map((att) => {
                const url = attachmentUrls[att.file_url];
                return (
                  <div key={`att-${att.id}`} className={styles.filePreviewItem}>
                    {isImageFile(att.file_type) && url ? (
                      <img src={url} alt={att.file_name} className={styles.filePreviewImage} />
                    ) : (
                      <div className={styles.filePreviewIcon}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                    )}
                    <span className={styles.filePreviewName}>{truncate(att.file_name, 16)}</span>
                    <span className={styles.filePreviewSize}>{formatFileSize(att.file_size)}</span>
                    <button
                      type="button"
                      className={styles.filePreviewRemove}
                      onClick={() => removeExistingAttachment(att.id)}
                      title="Remove"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              {pendingFiles.map((file, i) => (
                <div key={`${file.name}-${i}`} className={styles.filePreviewItem}>
                  {isImageFile(file.type) ? (
                    <img src={URL.createObjectURL(file)} alt={file.name} className={styles.filePreviewImage} />
                  ) : (
                    <div className={styles.filePreviewIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </div>
                  )}
                  <span className={styles.filePreviewName}>{truncate(file.name, 16)}</span>
                  <span className={styles.filePreviewSize}>{formatFileSize(file.size)}</span>
                  <button
                    type="button"
                    className={styles.filePreviewRemove}
                    onClick={() => removeFile(i)}
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <UploadProgress
            files={uploadingFiles}
            onRemove={(id) => setUploadingFiles((prev) => prev.filter((f) => f.id !== id))}
          />
          <div className={styles.formField}>
            <label className={styles.formLabel}>Send to</label>
            <div className={styles.formRow}>
              <select
                className={styles.formSelect}
                value={targetType}
                onChange={(e) => { setTargetType(e.target.value as 'channel' | 'dm'); setTargetId(''); }}
              >
                <option value="channel">Channel</option>
                <option value="dm">Direct Message</option>
              </select>
              <select
                className={styles.formSelect}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Select {targetType === 'channel' ? 'a channel' : 'a conversation'}...</option>
                {channels
                  .filter((c) => c.type === targetType)
                  .map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
              </select>
            </div>
          </div>
          <div className={styles.formField}>
            <label className={styles.formLabel}>Send at</label>
            <div className={styles.inputWithIcon}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => datetimeInputRef.current?.showPicker()}
                tabIndex={-1}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </button>
              <input
                ref={datetimeInputRef}
                type="datetime-local"
                className={styles.formInput}
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
          </div>
          <div className={styles.formActions}>
            <button type="button" className={styles.formCancel} onClick={() => { setShowForm(false); setContent(''); setScheduledAt(''); setTargetId(''); setExistingAttachments([]); setAttachmentUrls({}); }}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.formSubmit}
              onClick={handleSubmit}
              disabled={(!content.trim() && pendingFiles.length === 0 && existingAttachments.length === 0) || !scheduledAt}
            >
              Schedule
            </button>
          </div>
        </div>
      )}

      {messages.length === 0 && !showForm ? (
        <div className={styles.empty}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.emptyIcon}>
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22L11 13L2 9L22 2Z" />
          </svg>
          <span className={styles.emptyText}>No scheduled messages</span>
          <span className={styles.emptyHint}>Click + to schedule a message</span>
        </div>
      ) : (
        <ScrollArea className={styles.messageList}>
          {messages.map((message) => (
            <div key={message.id} className={`${styles.messageItem} ${message.sent ? styles.messageSent : ''}`}>
              {editingId === message.id ? (
                <div className={styles.editForm}>
                  <textarea
                    className={styles.formTextarea}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={2}
                  />
                  <input
                    type="datetime-local"
                    className={styles.formInput}
                    value={editScheduledAt}
                    onChange={(e) => setEditScheduledAt(e.target.value)}
                  />
                  <div className={styles.formActions}>
                    <button type="button" className={styles.formCancel} onClick={() => setEditingId(null)}>Cancel</button>
                    <button type="button" className={styles.formSubmit} onClick={handleEditSave} disabled={!editContent.trim() || !editScheduledAt}>Save</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.messageContent}>
                    <div className={styles.messageTop}>
                      <span className={styles.messagePreview}>
                        {truncate(message.content, 80)}
                      </span>
                    </div>
                    {message.attachments && message.attachments.length > 0 && (
                      <ScheduledAttachmentThumbs attachments={message.attachments} />
                    )}
                    <div className={styles.messageMeta}>
                      {message.channel_id && (
                        <Badge variant="default" size="sm">
                          {targetNames[message.channel_id] ?? 'Channel'}
                        </Badge>
                      )}
                      {message.conversation_id && (
                        <Badge variant="info" size="sm">
                          {targetNames[message.conversation_id] ?? 'Direct'}
                        </Badge>
                      )}
                      {message.sent ? (
                        <Badge variant="success" size="sm">Sent</Badge>
                      ) : (
                        <Badge variant="primary" size="sm">Pending</Badge>
                      )}
                      <span className={styles.scheduledTime}>
                        {message.sent ? 'Sent' : 'Sends'} {formatRelativeTime(message.scheduled_at)}
                      </span>
                    </div>
                  </div>
                  <div className={styles.messageActions}>
                    {!message.sent && (
                      <button
                        type="button"
                        className={styles.actionButton}
                        onClick={() => startEdit(message)}
                        title="Edit"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}
                    {message.sent && onResend && (
                      <button
                        type="button"
                        className={styles.actionButton}
                        onClick={() => {
                          setContent(message.content);
                          setScheduledAt('');
                          setExistingAttachments(message.attachments ?? []);
                          setPendingFiles([]);
                          setAttachmentUrls({});
                          if (message.attachments && message.attachments.length > 0) {
                            getSignedUrlsBatch(message.attachments.map((a) => a.file_url)).then((urlMap) => {
                              const next: Record<string, string> = {};
                              urlMap.forEach((url, path) => { if (url) next[path] = url; });
                              setAttachmentUrls(next);
                            });
                          }
                          if (message.channel_id) {
                            setTargetType('channel');
                            setTargetId(message.channel_id);
                          } else if (message.conversation_id) {
                            setTargetType('dm');
                            setTargetId(message.conversation_id);
                          }
                          setShowForm(true);
                        }}
                        title="Reschedule"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="23 4 23 10 17 10" />
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                        </svg>
                      </button>
                    )}
                    {onCancel && (
                      <button
                        type="button"
                        className={`${styles.actionButton} ${styles.cancelAction}`}
                        onClick={() => onCancel(message.id)}
                        title={message.sent ? 'Delete' : 'Cancel'}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </ScrollArea>
      )}
    </div>
  );
}

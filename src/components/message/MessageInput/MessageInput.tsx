import { useState, useRef, useCallback, useEffect, type FormEvent, type KeyboardEvent, type DragEvent } from 'react';
import { useMessageContextSafe } from '@/app/providers/MessageProvider';
import { useChannelContextSafe } from '@/app/providers/ChannelProvider';
import { useEditSafe } from '@/app/providers/EditProvider';
import { useAuth } from '@/hooks/useAuth';
import { useThreadCountsSafe } from '@/app/providers/ThreadProvider';
import { uploadFile, isFileSizeValid, createFileAttachment, normalizeFileType, createLinkAttachment, deleteLinkAttachments, getLinkAttachmentUrls, extractUrls, removeUrlsFromText, LINK_ATTACHMENT_TYPE } from '@/lib/message';
import { createScheduledMessage } from '@/lib/message/schedule';
import { MentionDropdown } from './MentionDropdown';
import { RecordButton } from './RecordButton/RecordButton';
import { UploadProgress } from '@/components/message/UploadProgress';
import { AttachmentPreview } from '@/components/message/AttachmentPreview';
import { supabase } from '@/lib/supabase';
import { useInvalidateAttachments } from '@/hooks/useMessageAttachments';
import type { LinkDisplayMode } from '@/types';
import styles from './MessageInput.module.css';

interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

interface UploadingFile {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
}

const MAX_MESSAGE_LENGTH = 100000;
const DRAFT_STORAGE_KEY = 'dark-space-drafts';
const IS_MOBILE = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

interface MessageInputProps {
  parentId?: string;
  placeholder?: string;
  onMessageSent?: () => void;
  /** Optional override: bypass useMessage context */
  onSend?: (content: string, parentId?: string, linkMode?: LinkDisplayMode | null) => Promise<unknown>;
  /** Optional override: channelId when outside channel context */
  overrideChannelId?: string;
  /** Optional override: editing message when outside EditProvider */
  editingMessage?: import('@/types').Message | null;
  /** Optional override: save edited message */
  onSaveEdit?: (content: string, linkMode?: LinkDisplayMode | null) => Promise<void>;
  /** Optional override: cancel editing */
  onCancelEdit?: () => void;
  /** Optional override: conversation id for DM scheduling */
  conversationId?: string | null;
}

let fileIdCounter = 0;
function generateFileId(): string {
  return `file-${Date.now()}-${++fileIdCounter}`;
}

function getDraft(channelId: string): string {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return '';
    const drafts = JSON.parse(raw) as Record<string, string>;
    return drafts[channelId] ?? '';
  } catch {
    return '';
  }
}

function saveDraft(channelId: string, content: string): void {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    const drafts = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (content.trim()) {
      drafts[channelId] = content;
    } else {
      delete drafts[channelId];
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // localStorage not available
  }
}

export function MessageInput({ parentId, placeholder = 'Type a message...', onMessageSent, onSend, overrideChannelId, editingMessage: editingOverride, onSaveEdit, onCancelEdit, conversationId }: MessageInputProps) {
  const messageCtx = useMessageContextSafe();
  const editCtx = useEditSafe();
  const channelCtx = useChannelContextSafe();
  const { userId } = useAuth();
  const threadCountsCtx = useThreadCountsSafe();
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [scheduleInfo, setScheduleInfo] = useState<string | null>(null);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingLinkEmbeds, setPendingLinkEmbeds] = useState<string[]>([]);
  const [linkMode, setLinkMode] = useState<LinkDisplayMode>('embed');
  const [linkNeighbor, setLinkNeighbor] = useState<'text' | 'grid'>('text');
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [channelMemberIds, setChannelMemberIds] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const channelId = overrideChannelId ?? channelCtx?.currentChannel?.id;
  const activeEdit = editingOverride ?? editCtx?.editingMessage ?? null;
  const cancelEdit = onCancelEdit ?? editCtx?.cancelEditing;
  const invalidateAttachments = useInvalidateAttachments();

  useEffect(() => {
    if (activeEdit) {
      setContent(activeEdit.content);
      setLinkMode(activeEdit.link_mode === 'text' ? 'text' : 'embed');
      setLinkNeighbor('text');
      setPendingLinkEmbeds([]);
      textareaRef.current?.focus();
      if (activeEdit.link_mode === 'grid') {
        getLinkAttachmentUrls(activeEdit.id).then((urls) => {
          if (urls.length === 0) return;
          setContent((prev) => {
            const base = prev.trim();
            return base ? `${base}\n${urls.join('\n')}` : urls.join('\n');
          });
        });
      }
    }
  }, [activeEdit]);

  useEffect(() => {
    if (!channelId || parentId) return;
    const draft = getDraft(channelId);
    if (draft) {
      setContent(draft);
      requestAnimationFrame(() => {
        if (textareaRef.current) handleResize(textareaRef.current);
      });
    } else {
      setContent('');
    }
  }, [channelId, parentId]);

  useEffect(() => {
    if (!channelId) {
      setChannelMemberIds([]);
      return;
    }
    supabase
      .from('channel_members')
      .select('user_id')
      .eq('channel_id', channelId)
      .then(({ data }) => {
        setChannelMemberIds(data?.map((r) => r.user_id) ?? []);
      });
  }, [channelId]);

  const contentUrls = extractUrls(content);

  useEffect(() => {
    if (contentUrls.length === 0 && pendingLinkEmbeds.length === 0) {
      setLinkMode('embed');
      setLinkNeighbor('text');
    }
  }, [content, contentUrls.length, pendingLinkEmbeds.length]);

  const handleResize = useCallback((textarea: HTMLTextAreaElement) => {
    if (!textarea.value.trim()) {
      textarea.style.height = '';
      return;
    }
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).maxHeight, 10) || 400;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    if (textareaRef.current) handleResize(textareaRef.current);
  }, [content, handleResize]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length > MAX_MESSAGE_LENGTH && content.length <= MAX_MESSAGE_LENGTH) return;
    setContent(value);
    setSendError(null);
    handleResize(e.target);

    if (channelId && !parentId && !activeEdit) {
      saveDraft(channelId, value);
    }

    const lastAtIndex = value.lastIndexOf('@');
    if (lastAtIndex >= 0) {
      const afterAt = value.slice(lastAtIndex + 1);
      const hasSpace = afterAt.includes(' ');
      if (!hasSpace && afterAt.length <= 20) {
        setMentionQuery(afterAt);
        return;
      }
    }
    setMentionQuery(null);
  }, [handleResize, channelId, parentId, activeEdit, content.length]);

  const handleMentionSelect = useCallback((username: string) => {
    const lastAtIndex = content.lastIndexOf('@');
    if (lastAtIndex >= 0) {
      const newContent = content.slice(0, lastAtIndex) + `@${username} `;
      setContent(newContent);
      setMentionQuery(null);
      textareaRef.current?.focus();
    }
  }, [content]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (!isFileSizeValid(file)) {
        alert(`File ${file.name} is too large (max 50MB)`);
        return;
      }

      const id = generateFileId();
      const normalizedFile = normalizeFileType(file);
      const pending: PendingFile = { id, file: normalizedFile };

      if (normalizedFile.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          pending.preview = ev.target?.result as string;
          setPendingFiles((prev) => [...prev, pending]);
        };
        reader.readAsDataURL(normalizedFile);
      } else {
        setPendingFiles((prev) => [...prev, pending]);
      }
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleRecorded = useCallback((file: File) => {
    if (!isFileSizeValid(file)) {
      alert(`Recording is too large (max 50MB)`);
      return;
    }
    const id = generateFileId();
    setPendingFiles((prev) => [...prev, { id, file }]);
  }, []);

  const removeUploadingFile = useCallback((id: string) => {
    setUploadingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (!isFileSizeValid(file)) {
        alert(`File ${file.name} is too large (max 50MB)`);
        return;
      }

      const id = generateFileId();
      const normalizedFile = normalizeFileType(file);
      const pending: PendingFile = { id, file: normalizedFile };

      if (normalizedFile.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          pending.preview = ev.target?.result as string;
          setPendingFiles((prev) => [...prev, pending]);
        };
        reader.readAsDataURL(normalizedFile);
      } else {
        setPendingFiles((prev) => [...prev, pending]);
      }
    });
  }, []);

  const uploadFiles = useCallback(async (messageId: string): Promise<boolean> => {
    if (pendingFiles.length === 0 || !channelId || !userId) return true;

    const uploadPromises = pendingFiles.map(async (pf) => {
      const uploadingId = generateFileId();
      const uploadingFile: UploadingFile = {
        id: uploadingId,
        file: pf.file,
        progress: 0,
        status: 'uploading',
      };

      setUploadingFiles((prev) => [...prev, uploadingFile]);

      try {
        const url = await uploadFile(pf.file, channelId, (p) => {
          setUploadingFiles((prev) =>
            prev.map((f) => (f.id === uploadingId ? { ...f, progress: p } : f)),
          );
        });
        if (!url) throw new Error('Upload failed');

        setUploadingFiles((prev) =>
          prev.map((f) => (f.id === uploadingId ? { ...f, progress: 100, status: 'complete' as const } : f)),
        );

        setTimeout(() => {
          setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadingId));
        }, 2000);

        if (userId) await createFileAttachment(messageId, userId, pf.file, url);
      } catch {
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.id === uploadingId ? { ...f, status: 'error' as const, error: 'Upload failed' } : f,
          ),
        );
      }
    });

    await Promise.all(uploadPromises);
    setPendingFiles([]);
    window.dispatchEvent(new CustomEvent('attachments-updated', { detail: { messageId } }));
    return true;
  }, [pendingFiles, channelId, userId]);

  const createLinkEmbedsFor = useCallback(async (messageId: string, urls: string[]): Promise<boolean> => {
    if (urls.length === 0 || !userId) return true;
    const results = await Promise.all(
      urls.map((url) => createLinkAttachment(messageId, userId, url)),
    );
    if (results.some((r) => r !== null)) {
      window.dispatchEvent(new CustomEvent('attachments-updated', { detail: { messageId } }));
    }
    return true;
  }, [userId]);

  const createLinkEmbeds = useCallback(async (messageId: string): Promise<boolean> => {
    if (pendingLinkEmbeds.length === 0) return true;
    const ok = await createLinkEmbedsFor(messageId, pendingLinkEmbeds);
    setPendingLinkEmbeds([]);
    return ok;
  }, [pendingLinkEmbeds, createLinkEmbedsFor]);

  const handleEmbedLinkClick = useCallback(() => {
    if (linkMode === 'grid') {
      setLinkMode('embed');
      setPendingLinkEmbeds([]);
    } else {
      setLinkNeighbor((prev) => (prev === 'text' ? 'grid' : 'text'));
    }
  }, [linkMode]);

  const handleGridClick = useCallback(() => {
    setLinkMode('grid');
    if (contentUrls.length > 0) setPendingLinkEmbeds(contentUrls);
  }, [contentUrls]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || isSending) return;

    setIsSending(true);
    setSendError(null);

    try {
      const doSend = onSend ?? messageCtx?.sendMessage;
      const doUpdate = messageCtx?.updateMessage;
      const useGrid = linkMode === 'grid' && pendingLinkEmbeds.length > 0;
      const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : linkMode;
      const sendContent = (useGrid ? removeUrlsFromText(content, pendingLinkEmbeds) : content).trim();

      if (activeEdit) {
        const linkUrls = pendingLinkEmbeds.length > 0 ? pendingLinkEmbeds : contentUrls;
        const useGrid = linkMode === 'grid' && linkUrls.length > 0;
        const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : linkMode;
        const sendContent = (useGrid ? removeUrlsFromText(content, linkUrls) : content).trim();
        if (onSaveEdit) {
          await onSaveEdit(sendContent, sendLinkMode);
        } else if (doUpdate) {
          await doUpdate(activeEdit.id, sendContent, sendLinkMode);
          editCtx?.cancelEditing();
        }
        await deleteLinkAttachments(activeEdit.id);
        if (useGrid) await createLinkEmbedsFor(activeEdit.id, linkUrls);
        invalidateAttachments(activeEdit.id);
        setPendingLinkEmbeds([]);
        setContent('');
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        onMessageSent?.();
      } else if (doSend) {
        const message = await doSend(sendContent || ' ', parentId, sendLinkMode) as import('@/types').Message | null;
        if (message) {
          await Promise.all([
            uploadFiles(message.id),
            useGrid ? createLinkEmbeds(message.id) : Promise.resolve(true),
          ]);
          setContent('');
          if (channelId && !parentId) {
            saveDraft(channelId, '');
          }
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          textareaRef.current?.focus();
          if (parentId) {
            threadCountsCtx?.incrementReplyCount(parentId);
          }
          onMessageSent?.();
        } else {
          setSendError('Failed to send message. Tap to retry.');
        }
      }
    } catch {
      setSendError('Something went wrong. Tap to retry.');
    } finally {
      setIsSending(false);
    }
  }

  function toLocalDatetimeValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function roundUpToNext5(date: Date): Date {
    const d = new Date(date);
    const ms = 5 * 60000;
    d.setTime(Math.ceil(d.getTime() / ms) * ms);
    return d;
  }

  function applyPreset(minutes: number, hour?: number, minute = 0) {
    if (hour !== undefined) {
      const d = new Date();
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      setScheduleAt(toLocalDatetimeValue(d));
      return;
    }
    setScheduleAt(toLocalDatetimeValue(roundUpToNext5(new Date(Date.now() + minutes * 60000))));
  }

  async function handleScheduleSubmit() {
    if (!scheduleAt || (!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || isSending || !userId) return;
    setIsSending(true);
    setSendError(null);
    const files = pendingFiles.map((f) => f.file);
    if (files.length > 0) {
      setUploadingFiles(files.map((file) => ({
        id: generateFileId(),
        file,
        progress: 0,
        status: 'uploading' as const,
      })));
    }
    const useGrid = linkMode === 'grid' && pendingLinkEmbeds.length > 0;
    const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : linkMode;
    const linkAttachments = useGrid
      ? pendingLinkEmbeds.map((url) => ({
          file_url: url,
          file_name: url,
          file_size: 0,
          file_type: LINK_ATTACHMENT_TYPE,
        }))
      : [];
    let scheduled: import('@/types').ScheduledMessage | null = null;
    try {
      scheduled = await createScheduledMessage({
        content: (useGrid ? removeUrlsFromText(content, pendingLinkEmbeds) : content).trim() || ' ',
        linkMode: sendLinkMode,
        scheduledAt: scheduleAt,
        channelId,
        conversationId,
        parentId: parentId ?? null,
        files,
        attachments: linkAttachments,
        userId,
        onFileProgress: (file, percent) => {
          setUploadingFiles((prev) =>
            prev.map((f) => (f.file === file ? { ...f, progress: percent } : f)),
          );
        },
      });
    } finally {
      setUploadingFiles([]);
      setIsSending(false);
    }
    if (scheduled) {
      setContent('');
      setScheduleAt('');
      setPendingFiles([]);
      setPendingLinkEmbeds([]);
      setIsScheduleOpen(false);
      setScheduleInfo(`Scheduled for ${new Date(scheduled.scheduled_at).toLocaleString()}`);
      if (channelId && !parentId) {
        saveDraft(channelId, '');
      }
    } else {
      setSendError('Failed to schedule message. Tap to retry.');
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && activeEdit) {
      e.preventDefault();
      setContent('');
      cancelEdit?.();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !IS_MOBILE) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  const charCount = content.length;
  const isOverLimit = charCount > MAX_MESSAGE_LENGTH;
  const memberIds = channelMemberIds;
  const showLinkControls = contentUrls.length > 0 || pendingLinkEmbeds.length > 0;

  return (
    <div
      className={`${styles.wrapper} ${isDragging ? styles.dragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {pendingFiles.length > 0 && (
        <div className={styles.pendingFiles}>
          {pendingFiles.map((pf) => (
            <AttachmentPreview
              key={pf.id}
              attachment={{
                id: pf.id,
                message_id: '',
                user_id: '',
                file_name: pf.file.name,
                file_size: pf.file.size,
                file_type: pf.file.type,
                file_url: pf.preview ?? URL.createObjectURL(pf.file),
                created_at: '',
              }}
              onRemove={removePendingFile}
              removable
            />
          ))}
        </div>
      )}

      <UploadProgress files={uploadingFiles} onRemove={removeUploadingFile} />

      {activeEdit && (
        <div className={styles.editingBanner}>
          <span>Editing message</span>
          <button type="button" className={styles.cancelEdit} onClick={() => { setContent(''); cancelEdit?.(); if (textareaRef.current) textareaRef.current.style.height = 'auto'; }}>
            ✕
          </button>
        </div>
      )}

      {scheduleInfo && (
        <div className={styles.scheduleBanner}>
          <span>✓ {scheduleInfo}</span>
          <button type="button" className={styles.cancelEdit} onClick={() => setScheduleInfo(null)}>
            ✕
          </button>
        </div>
      )}

      {sendError && (
        <div className={styles.errorBanner}>
          <span>{sendError}</span>
          <button type="button" className={styles.retryButton} onClick={() => { setSendError(null); handleSubmit(new Event('submit') as unknown as FormEvent); }}>
            Retry
          </button>
          <button type="button" className={styles.cancelEdit} onClick={() => setSendError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className={styles.toolbarPlaceholder}>
        {showLinkControls && (
          <>
            {linkMode === 'text' ? (
              <button
                type="button"
                className={`${styles.embedToggle} ${styles.embedToggleActive}`}
                onClick={() => setLinkMode('embed')}
                disabled={isSending}
                title="Show links as plain text"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 6.1H3" />
                  <path d="M21 12.1H3" />
                  <path d="M15.1 18H3" />
                </svg>
                <span>Text</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`${styles.embedToggle} ${linkMode === 'embed' ? styles.embedToggleActive : ''}`}
                  onClick={handleEmbedLinkClick}
                  disabled={isSending}
                  title={linkMode === 'grid' ? 'Send links as embedded cards' : linkNeighbor === 'text' ? 'Show links as attached files instead' : 'Show links as plain text instead'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </svg>
                  <span>Embed link</span>
                </button>
                {linkMode === 'grid' ? (
                  <button
                    type="button"
                    className={`${styles.embedToggle} ${styles.embedToggleActive}`}
                    onClick={() => setLinkMode('embed')}
                    disabled={isSending}
                    title="Show links as attached files instead"
                  >
                    <span>Grid</span>
                  </button>
                ) : linkNeighbor === 'text' ? (
                  <button
                    type="button"
                    className={styles.embedToggle}
                    onClick={() => setLinkMode('text')}
                    disabled={isSending}
                    title="Show links as plain text"
                  >
                    <span>Text</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.embedToggle}
                    onClick={handleGridClick}
                    disabled={isSending}
                    title="Send links as attached files"
                  >
                    <span>Grid</span>
                  </button>
                )}
              </>
            )}
            {linkMode === 'grid' && pendingLinkEmbeds.length > 0 && (
              <div className={styles.embedChips}>
                {pendingLinkEmbeds.map((url) => (
                  <span key={url} className={styles.embedChip}>
                    <span className={styles.embedChipUrl}>{url.replace(/^https?:\/\//, '')}</span>
                    <button
                      type="button"
                      className={styles.embedChipRemove}
                      onClick={() => setPendingLinkEmbeds((prev) => prev.filter((u) => u !== url))}
                      aria-label={`Remove embed for ${url}`}
                      title="Remove embed"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.inputWrapper}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.fileInput}
            onChange={handleFileSelect}
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
          />

          <div className={styles.inputContainer}>
            <textarea
              ref={textareaRef}
              className={`${styles.input} ${isOverLimit ? styles.inputOverLimit : ''}`}
              value={content}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={isSending}
              maxLength={MAX_MESSAGE_LENGTH}
            />
            {mentionQuery !== null && (
              <MentionDropdown
                query={mentionQuery}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
                memberIds={memberIds}
              />
            )}
          </div>

          <div className={styles.inputActions}>
            <div className={styles.inputActionsLeft}>
              <button
                type="button"
                className={styles.attachButton}
                onClick={() => fileInputRef.current?.click()}
                title="Attach file"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>

              <RecordButton
                onRecorded={handleRecorded}
                onError={(msg) => setSendError(msg)}
                disabled={isSending || !!activeEdit}
              />
            </div>

            <div className={styles.inputActionsRight}>
              <button
                type="button"
                className={`${styles.scheduleButton} ${isScheduleOpen ? styles.scheduleButtonActive : ''}`}
                onClick={() => {
                  setIsScheduleOpen(!isScheduleOpen);
                  if (!isScheduleOpen && !scheduleAt) {
                    setScheduleAt(toLocalDatetimeValue(new Date()));
                  }
                }}
                disabled={isSending || !!activeEdit}
                title="Schedule message for later"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                  <path d="M15 16l-3 3-1-1" />
                </svg>
              </button>

              <button
                type="submit"
                className={`${styles.sendButton} ${isSending ? styles.sendButtonLoading : ''}`}
                disabled={(!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || isSending || isOverLimit}
                aria-label="Send message"
              >
                {isSending ? (
                  <svg className={styles.spinner} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {isScheduleOpen && !activeEdit && (
          <div className={styles.schedulePopover}>
            <span className={styles.schedulePopoverTitle}>Schedule message</span>
            <div className={styles.schedulePresets}>
              <button type="button" className={styles.schedulePreset} onClick={() => applyPreset(10)}>In 10 min</button>
              <button type="button" className={styles.schedulePreset} onClick={() => applyPreset(60)}>In 1 hour</button>
              <button type="button" className={styles.schedulePreset} onClick={() => applyPreset(0, 21, 0)}>Tonight 9 PM</button>
              <button type="button" className={styles.schedulePreset} onClick={() => applyPreset(0, 9, 0)}>Tomorrow 9 AM</button>
            </div>
            <input
              type="datetime-local"
              className={styles.scheduleInput}
              value={scheduleAt}
              min={toLocalDatetimeValue(new Date())}
              onChange={(e) => setScheduleAt(e.target.value)}
            />
            <div className={styles.scheduleActions}>
              <button type="button" className={styles.scheduleCancel} onClick={() => setIsScheduleOpen(false)}>Cancel</button>
              <button
                type="button"
                className={styles.scheduleSubmit}
                onClick={handleScheduleSubmit}
                disabled={!scheduleAt || (!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || isSending}
              >
                {isSending ? 'Saving...' : 'Schedule'}
              </button>
            </div>
          </div>
        )}

        <div className={styles.hint}>
          {activeEdit ? (
            <span>Enter to save · Escape to cancel</span>
          ) : IS_MOBILE ? (
            <span>Tap send button · @ to mention</span>
          ) : (
            <>
              <span>Shift + Enter for new line · @ to mention · drag files to attach</span>
              {charCount > MAX_MESSAGE_LENGTH * 0.9 && (
                <span className={`${styles.charCount} ${isOverLimit ? styles.charCountOver : ''}`}>
                  {charCount}/{MAX_MESSAGE_LENGTH}
                </span>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}

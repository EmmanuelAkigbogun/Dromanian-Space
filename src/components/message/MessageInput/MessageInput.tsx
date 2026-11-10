import { DriveShare } from '@/features/platform/DriveShare';
import { api } from '@/features/platform/client';
import { useState, useRef, useCallback, useEffect, useLayoutEffect, type ClipboardEvent, type FormEvent, type KeyboardEvent, type DragEvent } from 'react';
import { useMessageContextSafe } from '@/app/providers/MessageProvider';
import { useChannelContextSafe } from '@/app/providers/ChannelProvider';
import { useEditSafe } from '@/app/providers/EditProvider';
import { useAuth } from '@/hooks/useAuth';
import { useThreadCountsSafe } from '@/app/providers/ThreadProvider';
import { uploadFile, isFileSizeValid, createFileAttachment, normalizeFileType, createLinkAttachment, deleteLinkAttachments, getLinkAttachmentUrls, extractUrls, removeUrlsFromText, LINK_ATTACHMENT_TYPE } from '@/lib/message';
import { createScheduledMessage } from '@/lib/message/schedule';
import { MentionDropdown } from './MentionDropdown';
import { Floating } from '@/lib/overlay/Floating';
import { RecordButton } from './RecordButton/RecordButton';
import { UploadProgress } from '@/components/message/UploadProgress';
import { AttachmentPreview } from '@/components/message/AttachmentPreview';
import { platform } from '@/lib/platform';
import {
  composerIsUnchanged,
  composerRouteKey,
  composerScopeIsCurrent,
  failedAttachmentItems,
  nextComposerScopeToken,
  withoutSubmittedItems,
  type ComposerScopeToken,
} from '@/lib/composerSubmission';
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

interface MessageSubmission {
  content: string;
  files: PendingFile[];
  links: string[];
  linkMode: LinkDisplayMode;
  revision: number;
  providerFailureIds: string[];
  scopeToken: ComposerScopeToken;
}

interface FileAttachmentRetry {
  pending: PendingFile;
  uploadedUrl?: string;
}

interface AttachmentRetryBatch {
  messageId: string;
  files: FileAttachmentRetry[];
  links: string[];
  scopeToken: ComposerScopeToken;
}

interface ScheduledSubmissionRetry {
  submission: MessageSubmission;
  scheduledAt: string;
  channelId?: string | null;
  conversationId?: string | null;
  parentId?: string | null;
  userId: string;
}

type RecoveryKind = 'message' | 'attachments' | 'schedule';

const MAX_MESSAGE_LENGTH = 100000;
const DRAFT_STORAGE_KEY = 'dark-space-drafts';
const IS_MOBILE = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

function resizeTextarea(textarea: HTMLTextAreaElement) {
  if (!textarea.value.trim()) {
    textarea.style.height = '';
    return;
  }
  textarea.style.height = 'auto';
  const maxHeight = parseInt(getComputedStyle(textarea).maxHeight, 10) || 400;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

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
  const sendingRef = useRef(false);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef<number | null>(null);
  const composerRevision = useRef(0);
  const failedSubmission = useRef<MessageSubmission | null>(null);
  const failedAttachmentBatches = useRef<AttachmentRetryBatch[]>([]);
  const failedScheduledSubmission = useRef<ScheduledSubmissionRetry | null>(null);
  const recoveryKindRef = useRef<RecoveryKind | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const channelId = overrideChannelId ?? channelCtx?.currentChannel?.id;
  const routeScopeKey = composerRouteKey(channelId, conversationId, parentId);
  const scopeTokenRef = useRef<ComposerScopeToken>(nextComposerScopeToken(null, routeScopeKey));
  const activeEdit = editingOverride ?? editCtx?.editingMessage ?? null;
  const cancelEdit = onCancelEdit ?? editCtx?.cancelEditing;
  const invalidateAttachments = useInvalidateAttachments();
  const markComposerChanged = useCallback(() => {
    composerRevision.current += 1;
  }, []);

  useLayoutEffect(() => {
    const nextToken = nextComposerScopeToken(scopeTokenRef.current, routeScopeKey);
    if (nextToken === scopeTokenRef.current) return;
    scopeTokenRef.current = nextToken;
    composerRevision.current += 1;
    failedSubmission.current = null;
    failedAttachmentBatches.current = [];
    failedScheduledSubmission.current = null;
    recoveryKindRef.current = null;
    activeOperationRef.current = null;
    sendingRef.current = false;
    setContent('');
    setPendingFiles([]);
    setPendingLinkEmbeds([]);
    setScheduleAt('');
    setIsScheduleOpen(false);
    setScheduleInfo(null);
    setLinkMode('embed');
    setLinkNeighbor('text');
    setMentionQuery(null);
    setIsDragging(false);
    setIsSending(false);
    setUploadingFiles([]);
    setSendError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    cancelEdit?.();
  }, [cancelEdit, routeScopeKey]);

  useEffect(() => {
    if (activeEdit) {
      const editScopeToken = scopeTokenRef.current;
      setContent(activeEdit.content);
      setLinkMode(activeEdit.link_mode === 'text' ? 'text' : 'embed');
      setLinkNeighbor('text');
      setPendingLinkEmbeds([]);
      textareaRef.current?.focus();
      if (activeEdit.link_mode === 'grid') {
        getLinkAttachmentUrls(activeEdit.id).then((urls) => {
          if (urls.length === 0 || !composerScopeIsCurrent(editScopeToken, scopeTokenRef.current)) return;
          setContent((prev) => {
            const base = prev.trim();
            return base ? `${base}\n${urls.join('\n')}` : urls.join('\n');
          });
        }).catch(() => undefined);
      }
    }
  }, [activeEdit]);

  useEffect(() => {
    if (!channelId) return;
    const draft = getDraft(`${userId}:${channelId}:${parentId ?? 'root'}`);
    if (draft) {
      setContent(draft);
      requestAnimationFrame(() => {
        if (textareaRef.current) resizeTextarea(textareaRef.current);
      });
    } else {
      setContent('');
    }
  }, [userId, channelId, parentId]);

  useEffect(() => {
    if (!channelId) {
      setChannelMemberIds([]);
      return;
    }
    platform
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

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [content]);

  useEffect(() => {
    const submission = failedSubmission.current;
    if (!submission || !messageCtx) return;
    const knownIds = new Set(submission.providerFailureIds);
    const useGrid = submission.linkMode === 'grid' && submission.links.length > 0;
    const sentMode: LinkDisplayMode = useGrid ? 'grid' : submission.linkMode;
    const sentContent = (useGrid ? removeUrlsFromText(submission.content, submission.links) : submission.content).trim() || ' ';
    const duplicate = [...messageCtx.failedMessages].reverse().find((failed) =>
      !knownIds.has(failed.tempId)
      && failed.content === sentContent
      && failed.parentId === parentId
      && failed.linkMode === sentMode,
    );
    if (duplicate) messageCtx.removeFailedMessage(duplicate.tempId);
  }, [messageCtx, parentId, sendError]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length > MAX_MESSAGE_LENGTH && content.length <= MAX_MESSAGE_LENGTH) return;
    markComposerChanged();
    setContent(value);
    if (!hasRecoverableFailure()) setSendError(null);
    resizeTextarea(e.target);

    if (channelId && !parentId && !activeEdit) {
      saveDraft(`${userId}:${channelId}:${parentId ?? 'root'}`, value);
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
  }, [channelId, parentId, activeEdit, content.length, markComposerChanged, userId]);

  const handleMentionSelect = useCallback((username: string) => {
    const lastAtIndex = content.lastIndexOf('@');
    if (lastAtIndex >= 0) {
      const newContent = content.slice(0, lastAtIndex) + `@${username} `;
      markComposerChanged();
      setContent(newContent);
      if (channelId && !parentId && !activeEdit) {
        saveDraft(`${userId}:${channelId}:${parentId ?? 'root'}`, newContent);
      }
      setMentionQuery(null);
      textareaRef.current?.focus();
    }
  }, [activeEdit, channelId, content, markComposerChanged, parentId, userId]);

  const queueFiles = useCallback((files: File[]) => {
    const queuedScopeToken = scopeTokenRef.current;
    files.forEach((file) => {
      if (!isFileSizeValid(file)) {
        alert(`File ${file.name} is too large (max 50MB)`);
        return;
      }

      const id = generateFileId();
      const normalizedFile = normalizeFileType(file);
      const pending: PendingFile = { id, file: normalizedFile };
      markComposerChanged();
      setPendingFiles((prev) => [...prev, pending]);

      if (normalizedFile.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (!composerScopeIsCurrent(queuedScopeToken, scopeTokenRef.current)) return;
          const preview = ev.target?.result;
          if (typeof preview !== 'string') return;
          setPendingFiles((prev) => prev.map((item) => (
            item.id === pending.id ? { ...item, preview } : item
          )));
        };
        reader.readAsDataURL(normalizedFile);
      }
    });
  }, [markComposerChanged]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) queueFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [queueFiles]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemImages = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const images = itemImages.length > 0
      ? itemImages
      : Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'));

    if (images.length === 0) return;
    e.preventDefault();
    queueFiles(images);
    if (!hasRecoverableFailure()) setSendError(null);
  }, [queueFiles]);

  const removePendingFile = useCallback((id: string) => {
    markComposerChanged();
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, [markComposerChanged]);

  const handleRecorded = useCallback((file: File) => {
    if (!isFileSizeValid(file)) {
      alert(`Recording is too large (max 50MB)`);
      return;
    }
    const id = generateFileId();
    markComposerChanged();
    setPendingFiles((prev) => [...prev, { id, file }]);
  }, [markComposerChanged]);

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

    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) queueFiles(files);
  }, [queueFiles]);

  const attachFilesToMessage = useCallback(async (
    messageId: string,
    files: FileAttachmentRetry[],
    scopeToken: ComposerScopeToken,
  ): Promise<FileAttachmentRetry[]> => {
    if (files.length === 0) return [];
    if (!channelId || !userId) return files;
    const scopeIsCurrent = () => composerScopeIsCurrent(scopeToken, scopeTokenRef.current);

    const uploadPromises = files.map(async (retry) => {
      const pf = retry.pending;
      const uploadingId = generateFileId();
      const uploadingFile: UploadingFile = {
        id: uploadingId,
        file: pf.file,
        progress: 0,
        status: 'uploading',
      };

      if (scopeIsCurrent()) setUploadingFiles((prev) => [...prev, uploadingFile]);

      let uploadedUrl = retry.uploadedUrl;
      try {
        if (!uploadedUrl) {
          const uploaded = await uploadFile(pf.file, channelId, (p) => {
            if (!scopeIsCurrent()) return;
            setUploadingFiles((prev) =>
              prev.map((f) => (f.id === uploadingId ? { ...f, progress: p } : f)),
            );
          });
          if (uploaded) uploadedUrl = uploaded;
        }
        if (!uploadedUrl) throw new Error('Upload failed');

        const attachment = await createFileAttachment(messageId, userId, pf.file, uploadedUrl);
        if (!attachment) throw new Error('Could not create attachment');

        if (scopeIsCurrent()) {
          setUploadingFiles((prev) =>
            prev.map((f) => (f.id === uploadingId ? { ...f, progress: 100, status: 'complete' as const } : f)),
          );
        }

        setTimeout(() => {
          if (scopeIsCurrent()) {
            setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadingId));
          }
        }, 2000);

        return {
          item: { pending: pf, uploadedUrl },
          succeeded: true,
        };
      } catch {
        if (scopeIsCurrent()) {
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.id === uploadingId ? { ...f, status: 'error' as const, error: 'Upload failed' } : f,
            ),
          );
        }
        return {
          item: { pending: pf, uploadedUrl },
          succeeded: false,
        };
      }
    });

    const attempts = await Promise.all(uploadPromises);
    if (attempts.some((attempt) => attempt.succeeded)) {
      window.dispatchEvent(new CustomEvent('attachments-updated', { detail: { messageId } }));
    }
    return failedAttachmentItems(attempts);
  }, [channelId, userId]);

  const createLinkEmbedsFor = useCallback(async (messageId: string, urls: string[]): Promise<string[]> => {
    if (urls.length === 0) return [];
    if (!userId) return urls;
    const attempts = await Promise.all(
      urls.map(async (url) => {
        try {
          return {
            item: url,
            succeeded: (await createLinkAttachment(messageId, userId, url)) !== null,
          };
        } catch {
          return { item: url, succeeded: false };
        }
      }),
    );
    if (attempts.some((attempt) => attempt.succeeded)) {
      window.dispatchEvent(new CustomEvent('attachments-updated', { detail: { messageId } }));
    }
    return failedAttachmentItems(attempts);
  }, [userId]);

  const handleEmbedLinkClick = useCallback(() => {
    markComposerChanged();
    if (linkMode === 'grid') {
      setLinkMode('embed');
      setPendingLinkEmbeds([]);
    } else {
      setLinkNeighbor((prev) => (prev === 'text' ? 'grid' : 'text'));
    }
  }, [linkMode, markComposerChanged]);

  const handleGridClick = useCallback(() => {
    markComposerChanged();
    setLinkMode('grid');
    if (contentUrls.length > 0) setPendingLinkEmbeds(contentUrls);
  }, [contentUrls, markComposerChanged]);

  function scopeIsCurrent(scopeToken: ComposerScopeToken): boolean {
    return composerScopeIsCurrent(scopeToken, scopeTokenRef.current);
  }

  function hasRecoverableFailure(): boolean {
    return failedSubmission.current !== null
      || failedAttachmentBatches.current.length > 0
      || failedScheduledSubmission.current !== null;
  }

  function storeAttachmentFailure(batch: AttachmentRetryBatch): AttachmentRetryBatch[] {
    const existing = failedAttachmentBatches.current.find((item) => item.messageId === batch.messageId);
    const merged = existing
      ? {
          ...batch,
          files: [
            ...existing.files.filter((item) => !batch.files.some((next) => next.pending.id === item.pending.id)),
            ...batch.files,
          ],
          links: [...new Set([...existing.links, ...batch.links])],
        }
      : batch;
    failedAttachmentBatches.current = [
      ...failedAttachmentBatches.current.filter((item) => item.messageId !== batch.messageId),
      merged,
    ];
    recoveryKindRef.current = 'attachments';
    return failedAttachmentBatches.current;
  }

  function attachmentFailureMessage(batches: readonly AttachmentRetryBatch[]): string {
    const count = batches.reduce((total, batch) => total + batch.files.length + batch.links.length, 0);
    return `Message sent, but ${count === 1 ? 'an attachment' : `${count} attachments`} could not be added. Tap to retry.`;
  }

  function surfaceRemainingRecovery(): boolean {
    if (failedScheduledSubmission.current) {
      recoveryKindRef.current = 'schedule';
      setSendError('Failed to schedule message. Tap to retry.');
      return true;
    }
    if (failedAttachmentBatches.current.length > 0) {
      recoveryKindRef.current = 'attachments';
      setSendError(attachmentFailureMessage(failedAttachmentBatches.current));
      return true;
    }
    if (failedSubmission.current) {
      recoveryKindRef.current = 'message';
      setSendError('Failed to send message. Tap to retry.');
      return true;
    }
    recoveryKindRef.current = null;
    setSendError(null);
    return false;
  }

  function beginOperation(): number {
    const operationId = ++operationSequenceRef.current;
    activeOperationRef.current = operationId;
    sendingRef.current = true;
    setIsSending(true);
    return operationId;
  }

  function finishOperation(
    operationId: number,
    scopeToken: ComposerScopeToken,
    clearUploads = false,
  ): void {
    if (activeOperationRef.current !== operationId) return;
    activeOperationRef.current = null;
    sendingRef.current = false;
    if (!scopeIsCurrent(scopeToken)) return;
    if (clearUploads) setUploadingFiles([]);
    setIsSending(false);
    requestAnimationFrame(() => {
      if (scopeIsCurrent(scopeToken)) textareaRef.current?.focus({ preventScroll: true });
    });
  }

  function restoreSubmissionIfUnchanged(submission: MessageSubmission): boolean {
    if (!scopeIsCurrent(submission.scopeToken)) return false;
    if (!composerIsUnchanged(submission.revision, composerRevision.current)) return false;
    setContent(submission.content);
    setPendingFiles(submission.files);
    setPendingLinkEmbeds(submission.links);
    setLinkMode(submission.linkMode);
    setLinkNeighbor(submission.linkMode === 'grid' ? 'grid' : 'text');
    if (channelId) saveDraft(`${userId}:${channelId}:${parentId ?? 'root'}`, submission.content);
    return true;
  }

  function clearSubmittedComposer(submission: MessageSubmission) {
    setContent('');
    setMentionQuery(null);
    setPendingFiles((current) => withoutSubmittedItems(current, submission.files));
    setPendingLinkEmbeds([]);
    setLinkMode('embed');
    setLinkNeighbor('text');
    if (channelId) saveDraft(`${userId}:${channelId}:${parentId ?? 'root'}`, '');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  async function attachSubmissionArtifacts(
    messageId: string,
    files: FileAttachmentRetry[],
    links: string[],
    scopeToken: ComposerScopeToken,
  ): Promise<AttachmentRetryBatch | null> {
    const [failedFiles, failedLinks] = await Promise.all([
      attachFilesToMessage(messageId, files, scopeToken),
      createLinkEmbedsFor(messageId, links),
    ]);
    if (failedFiles.length === 0 && failedLinks.length === 0) return null;
    return { messageId, files: failedFiles, links: failedLinks, scopeToken };
  }

  async function deliverSubmission(submission: MessageSubmission): Promise<boolean> {
    const doSend = onSend ?? messageCtx?.sendMessage;
    if (!doSend) return false;
    const useGrid = submission.linkMode === 'grid' && submission.links.length > 0;
    const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : submission.linkMode;
    const sendContent = (useGrid ? removeUrlsFromText(submission.content, submission.links) : submission.content).trim();
    const message = await doSend(sendContent || ' ', parentId, sendLinkMode) as import('@/types').Message | null;
    if (!message) return false;

    const attachmentFailure = await attachSubmissionArtifacts(
      message.id,
      submission.files.map((pending) => ({ pending })),
      useGrid ? submission.links : [],
      submission.scopeToken,
    );
    if (attachmentFailure && scopeIsCurrent(submission.scopeToken)) {
      setSendError(attachmentFailureMessage(storeAttachmentFailure(attachmentFailure)));
    }
    if (sendContent.includes('@')) {
      void api('agents/mention', { message_id: message.id })
        .catch(() => {
          if (scopeIsCurrent(submission.scopeToken) && !hasRecoverableFailure()) {
            setSendError('Message sent. The agent could not start; check AI configuration.');
          }
        });
    }
    if (parentId) threadCountsCtx?.incrementReplyCount(parentId);
    if (scopeIsCurrent(submission.scopeToken)) onMessageSent?.();
    return true;
  }

  async function retryFailedSubmission() {
    const submission = failedSubmission.current;
    if (!submission || sendingRef.current || !scopeIsCurrent(submission.scopeToken)) return;
    const composerStillShowsFailure = composerIsUnchanged(submission.revision, composerRevision.current);
    const operationId = beginOperation();
    setSendError(null);
    if (composerStillShowsFailure) clearSubmittedComposer(submission);
    textareaRef.current?.focus({ preventScroll: true });
    try {
      if (await deliverSubmission(submission)) {
        if (scopeIsCurrent(submission.scopeToken) && failedSubmission.current === submission) {
          failedSubmission.current = null;
          surfaceRemainingRecovery();
        }
      } else if (scopeIsCurrent(submission.scopeToken)) {
        restoreSubmissionIfUnchanged(submission);
        recoveryKindRef.current = 'message';
        setSendError('Failed to send message. Tap to retry.');
      }
    } catch {
      if (scopeIsCurrent(submission.scopeToken)) {
        restoreSubmissionIfUnchanged(submission);
        recoveryKindRef.current = 'message';
        setSendError('Something went wrong. Tap to retry.');
      }
    } finally {
      finishOperation(operationId, submission.scopeToken);
    }
  }

  async function retryFailedAttachments() {
    const batches = failedAttachmentBatches.current.filter((batch) => scopeIsCurrent(batch.scopeToken));
    if (batches.length === 0 || sendingRef.current) return;
    const operationScopeToken = scopeTokenRef.current;
    const operationId = beginOperation();
    setSendError(null);
    try {
      const remaining: AttachmentRetryBatch[] = [];
      for (const batch of batches) {
        if (!scopeIsCurrent(operationScopeToken)) return;
        const failed = await attachSubmissionArtifacts(
          batch.messageId,
          batch.files,
          batch.links,
          operationScopeToken,
        );
        if (failed) remaining.push(failed);
      }
      if (!scopeIsCurrent(operationScopeToken)) return;
      failedAttachmentBatches.current = remaining;
      if (remaining.length > 0) {
        recoveryKindRef.current = 'attachments';
        setSendError(attachmentFailureMessage(remaining));
      } else {
        surfaceRemainingRecovery();
      }
    } catch {
      if (scopeIsCurrent(operationScopeToken)) {
        recoveryKindRef.current = 'attachments';
        setSendError(attachmentFailureMessage(batches));
      }
    } finally {
      finishOperation(operationId, operationScopeToken, true);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || sendingRef.current) return;

    const operationScopeToken = scopeTokenRef.current;
    const operationId = beginOperation();
    failedSubmission.current = null;
    if (recoveryKindRef.current === 'message') recoveryKindRef.current = null;
    if (!hasRecoverableFailure()) setSendError(null);

    // Keep focus during the submit gesture. Disabling this field closes a
    // mobile keyboard, which browsers will not reliably reopen after await.
    textareaRef.current?.focus({ preventScroll: true });

    if (activeEdit) {
      try {
        const doUpdate = messageCtx?.updateMessage;
        const linkUrls = pendingLinkEmbeds.length > 0 ? pendingLinkEmbeds : contentUrls;
        const useGrid = linkMode === 'grid' && linkUrls.length > 0;
        const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : linkMode;
        const sendContent = (useGrid ? removeUrlsFromText(content, linkUrls) : content).trim();
        if (onSaveEdit) {
          await onSaveEdit(sendContent, sendLinkMode);
        } else if (doUpdate) {
          await doUpdate(activeEdit.id, sendContent, sendLinkMode);
          if (scopeIsCurrent(operationScopeToken)) editCtx?.cancelEditing();
        }
        await deleteLinkAttachments(activeEdit.id);
        const failedLinks = useGrid ? await createLinkEmbedsFor(activeEdit.id, linkUrls) : [];
        invalidateAttachments(activeEdit.id);
        if (scopeIsCurrent(operationScopeToken)) {
          if (failedLinks.length > 0) {
            const failure: AttachmentRetryBatch = {
              messageId: activeEdit.id,
              files: [],
              links: failedLinks,
              scopeToken: operationScopeToken,
            };
            setSendError(attachmentFailureMessage(storeAttachmentFailure(failure)));
          }
          setPendingLinkEmbeds([]);
          setContent('');
          if (textareaRef.current) textareaRef.current.style.height = 'auto';
          onMessageSent?.();
        }
      } catch {
        if (scopeIsCurrent(operationScopeToken)) {
          setSendError('Something went wrong. Please try again.');
        }
      } finally {
        finishOperation(operationId, operationScopeToken);
      }
      return;
    }

    const submission: MessageSubmission = {
      content,
      files: [...pendingFiles],
      links: [...pendingLinkEmbeds],
      linkMode,
      revision: composerRevision.current,
      providerFailureIds: messageCtx?.failedMessages.map((failed) => failed.tempId) ?? [],
      scopeToken: operationScopeToken,
    };
    clearSubmittedComposer(submission);
    try {
      if (await deliverSubmission(submission)) {
        if (scopeIsCurrent(submission.scopeToken)) {
          failedSubmission.current = null;
        }
      } else if (scopeIsCurrent(submission.scopeToken)) {
        failedSubmission.current = submission;
        restoreSubmissionIfUnchanged(submission);
        recoveryKindRef.current = 'message';
        setSendError('Failed to send message. Tap to retry.');
      }
    } catch {
      if (scopeIsCurrent(submission.scopeToken)) {
        failedSubmission.current = submission;
        restoreSubmissionIfUnchanged(submission);
        recoveryKindRef.current = 'message';
        setSendError('Something went wrong. Tap to retry.');
      }
    } finally {
      finishOperation(operationId, submission.scopeToken);
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

  async function createScheduledFromSnapshot(
    retry: ScheduledSubmissionRetry,
  ): Promise<import('@/types').ScheduledMessage | null> {
    const { submission } = retry;
    const files = submission.files.map((item) => item.file);
    if (scopeIsCurrent(submission.scopeToken) && files.length > 0) {
      setUploadingFiles(files.map((file) => ({
        id: generateFileId(),
        file,
        progress: 0,
        status: 'uploading' as const,
      })));
    }
    const useGrid = submission.linkMode === 'grid' && submission.links.length > 0;
    const sendLinkMode: LinkDisplayMode = useGrid ? 'grid' : submission.linkMode;
    const linkAttachments = useGrid
      ? submission.links.map((url) => ({
          file_url: url,
          file_name: url,
          file_size: 0,
          file_type: LINK_ATTACHMENT_TYPE,
        }))
      : [];
    try {
      return await createScheduledMessage({
        content: (useGrid ? removeUrlsFromText(submission.content, submission.links) : submission.content).trim() || ' ',
        linkMode: sendLinkMode,
        scheduledAt: retry.scheduledAt,
        channelId: retry.channelId,
        conversationId: retry.conversationId,
        parentId: retry.parentId ?? null,
        files,
        attachments: linkAttachments,
        userId: retry.userId,
        onFileProgress: (file, percent) => {
          if (scopeIsCurrent(submission.scopeToken)) {
            setUploadingFiles((prev) =>
              prev.map((item) => (item.file === file ? { ...item, progress: percent } : item)),
            );
          }
        },
      });
    } catch {
      return null;
    }
  }

  async function handleScheduleSubmit() {
    if (!scheduleAt || (!content.trim() && pendingFiles.length === 0 && pendingLinkEmbeds.length === 0) || sendingRef.current || !userId) return;
    const operationScopeToken = scopeTokenRef.current;
    const operationId = beginOperation();
    failedSubmission.current = null;
    if (recoveryKindRef.current === 'message') recoveryKindRef.current = null;
    if (!hasRecoverableFailure()) setSendError(null);
    const submission: MessageSubmission = {
      content,
      files: [...pendingFiles],
      links: [...pendingLinkEmbeds],
      linkMode,
      revision: composerRevision.current,
      providerFailureIds: [],
      scopeToken: operationScopeToken,
    };
    const retry: ScheduledSubmissionRetry = {
      submission,
      scheduledAt: scheduleAt,
      channelId,
      conversationId,
      parentId: parentId ?? null,
      userId,
    };
    clearSubmittedComposer(submission);
    setIsScheduleOpen(false);
    textareaRef.current?.focus({ preventScroll: true });
    let scheduled: import('@/types').ScheduledMessage | null = null;
    try {
      scheduled = await createScheduledFromSnapshot(retry);
    } finally {
      finishOperation(operationId, submission.scopeToken, true);
    }
    if (!scopeIsCurrent(submission.scopeToken)) return;
    const composerStayedUnchanged = composerIsUnchanged(
      submission.revision,
      composerRevision.current,
    );
    if (scheduled && scheduled.status !== 'draft') {
      failedScheduledSubmission.current = null;
      if (recoveryKindRef.current === 'schedule') recoveryKindRef.current = null;
      if (composerStayedUnchanged && scheduleAt === retry.scheduledAt) setScheduleAt('');
      setScheduleInfo(`Scheduled for ${new Date(scheduled.scheduled_at).toLocaleString()}`);
      surfaceRemainingRecovery();
    } else if (scheduled) {
      failedScheduledSubmission.current = null;
      if (recoveryKindRef.current === 'schedule') recoveryKindRef.current = null;
      if (composerStayedUnchanged && scheduleAt === retry.scheduledAt) setScheduleAt('');
      if (!surfaceRemainingRecovery()) {
        setSendError('The message was saved as a draft because an attachment could not be queued. Open Calendar to review and retry it.');
      }
    } else {
      failedScheduledSubmission.current = retry;
      recoveryKindRef.current = 'schedule';
      if (restoreSubmissionIfUnchanged(submission)) {
        setScheduleAt(retry.scheduledAt);
        setIsScheduleOpen(true);
      }
      setSendError('Failed to schedule message. Tap to retry.');
    }
  }

  async function retryFailedScheduledSubmission() {
    const retry = failedScheduledSubmission.current;
    if (!retry || sendingRef.current || !scopeIsCurrent(retry.submission.scopeToken)) return;
    const composerShowsFailure = composerIsUnchanged(
      retry.submission.revision,
      composerRevision.current,
    );
    const operationId = beginOperation();
    setSendError(null);
    if (composerShowsFailure) clearSubmittedComposer(retry.submission);
    setIsScheduleOpen(false);
    textareaRef.current?.focus({ preventScroll: true });
    let scheduled: import('@/types').ScheduledMessage | null = null;
    try {
      scheduled = await createScheduledFromSnapshot(retry);
    } finally {
      finishOperation(operationId, retry.submission.scopeToken, true);
    }
    if (!scopeIsCurrent(retry.submission.scopeToken)) return;
    if (scheduled && scheduled.status !== 'draft') {
      failedScheduledSubmission.current = null;
      if (recoveryKindRef.current === 'schedule') recoveryKindRef.current = null;
      if (composerShowsFailure && scheduleAt === retry.scheduledAt) setScheduleAt('');
      setScheduleInfo(`Scheduled for ${new Date(scheduled.scheduled_at).toLocaleString()}`);
      surfaceRemainingRecovery();
    } else if (scheduled) {
      failedScheduledSubmission.current = null;
      if (recoveryKindRef.current === 'schedule') recoveryKindRef.current = null;
      if (!surfaceRemainingRecovery()) {
        setSendError('The message was saved as a draft because an attachment could not be queued. Open Calendar to review and retry it.');
      }
    } else {
      recoveryKindRef.current = 'schedule';
      if (restoreSubmissionIfUnchanged(retry.submission)) {
        setScheduleAt(retry.scheduledAt);
        setIsScheduleOpen(true);
      }
      setSendError('Failed to schedule message. Tap to retry.');
    }
  }

  function retryRecoverableFailure(): void {
    if (recoveryKindRef.current === 'schedule' && failedScheduledSubmission.current) {
      void retryFailedScheduledSubmission();
      return;
    }
    if (recoveryKindRef.current === 'attachments' && failedAttachmentBatches.current.length > 0) {
      void retryFailedAttachments();
      return;
    }
    if (failedSubmission.current) {
      void retryFailedSubmission();
      return;
    }
    if (failedScheduledSubmission.current) void retryFailedScheduledSubmission();
    else if (failedAttachmentBatches.current.length > 0) void retryFailedAttachments();
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
      ref={wrapperRef}
      className={`${styles.wrapper} ${isDragging ? styles.dragging : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && <div className={styles.dropOverlay} role="status">Drop images or files to attach</div>}
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
        <div className={styles.errorBanner} role="alert">
          <span>{sendError}</span>
          {hasRecoverableFailure() && (
            <button type="button" className={styles.retryButton} onClick={retryRecoverableFailure} disabled={isSending}>
              Retry
            </button>
          )}
          <button type="button" className={styles.cancelEdit} onClick={() => {
            failedSubmission.current = null;
            failedAttachmentBatches.current = [];
            failedScheduledSubmission.current = null;
            recoveryKindRef.current = null;
            setSendError(null);
          }}>
            ✕
          </button>
        </div>
      )}

      {(showLinkControls || (channelId && !activeEdit)) && (
        <div className={styles.composerUtilities}>
          <div className={styles.toolbarPlaceholder}>
            {showLinkControls && (
              <>
            {linkMode === 'text' ? (
              <button
                type="button"
                className={`${styles.embedToggle} ${styles.embedToggleActive}`}
                onClick={() => { markComposerChanged(); setLinkMode('embed'); }}
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
                    onClick={() => { markComposerChanged(); setLinkMode('embed'); }}
                    disabled={isSending}
                    title="Show links as attached files instead"
                  >
                    <span>Grid</span>
                  </button>
                ) : linkNeighbor === 'text' ? (
                  <button
                    type="button"
                    className={styles.embedToggle}
                    onClick={() => { markComposerChanged(); setLinkMode('text'); }}
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
                      onClick={() => { markComposerChanged(); setPendingLinkEmbeds((prev) => prev.filter((u) => u !== url)); }}
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

          {channelId && !activeEdit && <DriveShare channelId={channelId} parentId={parentId} />}
        </div>
      )}
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

          <div className={styles.inputContainer} ref={inputContainerRef}>
            <textarea
              ref={textareaRef}
              className={`${styles.input} ${isOverLimit ? styles.inputOverLimit : ''}`}
              value={content}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              rows={1}
              aria-busy={isSending}
              maxLength={MAX_MESSAGE_LENGTH}
            />
            {mentionQuery !== null && (
              <MentionDropdown
                anchor={inputContainerRef}
                query={mentionQuery}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
                memberIds={memberIds}
                allowAll={!overrideChannelId && channelCtx?.currentChannel?.slug === 'general'}
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

        <Floating open={isScheduleOpen && !activeEdit} anchor={wrapperRef} placement="top-end" offset={8} onDismiss={() => setIsScheduleOpen(false)} role="dialog" aria-label="Schedule message" className={styles.schedulePopover}>
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
        </Floating>

        <div className={styles.hint}>
          {activeEdit ? (
            <span>Enter to save · Escape to cancel</span>
          ) : IS_MOBILE ? (
            <span>Tap send button · @ to mention</span>
          ) : (
            <>
              <span>Shift + Enter for new line · @ to mention · paste or drag files to attach</span>
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

import { useState, useRef, useCallback, useEffect, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Radio } from '@/components/ui/Radio';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useAutomation } from '@/hooks/useAutomation';
import { useToast } from '@/components/ui/Toast';
import { AutomationVisibilityDialog } from '@/components/automation/AutomationVisibilityDialog';
import { InviteLinkSection } from '@/components/workspace/InviteLinkSection';
import { uploadWorkspaceAvatar, removeWorkspaceAvatar } from '@/lib/workspace';
import { getForwardedAttachmentPolicy, updateProfile } from '@/lib/profile';
import { canUpdateWorkspace, canUploadAvatar } from '@/lib/workspace/permissions';
import type { ForwardedAttachmentPolicy } from '@/types/profile';
import styles from './WorkspaceGeneralSettings.module.css';

export function WorkspaceGeneralSettings() {
  const { currentWorkspace, currentRole, updateWorkspace: ctxUpdateWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const {
    visibility,
    visibleMembers,
    setVisibility,
  } = useAutomation();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const avatarEditButtonRef = useRef<HTMLButtonElement>(null);
  const [showVisibility, setShowVisibility] = useState(false);
  const [forwardedPolicy, setForwardedPolicy] = useState<ForwardedAttachmentPolicy>('keep');
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPosition, setEmojiPosition] = useState({ x: 0, y: 0 });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isRemoving, setIsRemoving] = useState(false);

  const [name, setName] = useState(currentWorkspace?.name ?? '');
  const [description, setDescription] = useState(currentWorkspace?.description ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errors, setErrors] = useState<{ name?: string }>({});
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    getForwardedAttachmentPolicy(userId).then(setForwardedPolicy).catch(() => {});
  }, [userId]);

  const handlePolicyChange = useCallback(async (policy: ForwardedAttachmentPolicy) => {
    if (!userId || isSavingPolicy) return;
    setForwardedPolicy(policy);
    setIsSavingPolicy(true);
    try {
      await updateProfile(userId, { forwarded_attachment_policy: policy });
      toast({ variant: 'success', description: 'Forwarded attachment setting updated.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to save setting.' });
    } finally {
      setIsSavingPolicy(false);
    }
  }, [userId, isSavingPolicy, toast]);

  const canEdit = canUpdateWorkspace(currentRole);
  const canAvatar = canUploadAvatar(currentRole);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentWorkspace) return;

    if (!file.type.startsWith('image/')) {
      toast({ variant: 'error', description: 'Please select an image file.' });
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast({ variant: 'error', description: 'Image must be under 2 MB.' });
      return;
    }

    setAvatarMenuOpen(false);
    setShowEmojiPicker(false);
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const url = await uploadWorkspaceAvatar(
        currentWorkspace.id,
        file,
        (percent) => setUploadProgress(percent),
      );
      setAvatarPreview(url);
      await ctxUpdateWorkspace(currentWorkspace.id, { avatar_url: url });
      toast({ variant: 'success', title: 'Avatar updated', description: 'Your avatar has been updated.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to upload avatar.' });
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [currentWorkspace, ctxUpdateWorkspace, toast]);

  const handleSetInitial = useCallback(async () => {
    if (!currentWorkspace || isRemoving) return;
    setAvatarMenuOpen(false);
    setShowEmojiPicker(false);
    setIsRemoving(true);
    try {
      setAvatarPreview(null);
      await removeWorkspaceAvatar(currentWorkspace.id);
      await ctxUpdateWorkspace(currentWorkspace.id, { avatar_url: null });
      toast({ variant: 'success', title: 'Avatar updated', description: 'Showing the workspace initials.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to update avatar.' });
    } finally {
      setIsRemoving(false);
    }
  }, [currentWorkspace, isRemoving, ctxUpdateWorkspace, toast]);

  const handleOpenEmojiPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setEmojiPosition({ x: rect.left, y: rect.bottom + 4 });
    setAvatarMenuOpen(false);
    setShowEmojiPicker(true);
  };

  const handleEmojiSelect = useCallback(async (emoji: string) => {
    setShowEmojiPicker(false);
    setAvatarMenuOpen(false);
    if (!currentWorkspace) return;
    setAvatarPreview(emoji);
    try {
      await ctxUpdateWorkspace(currentWorkspace.id, { avatar_url: emoji });
      toast({ variant: 'success', title: 'Avatar updated', description: 'Emoji avatar set.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to update avatar.' });
    }
  }, [currentWorkspace, ctxUpdateWorkspace, toast]);

  const handleRemoveAvatar = useCallback(async () => {
    if (!currentWorkspace || isRemoving) return;
    setAvatarMenuOpen(false);
    setShowEmojiPicker(false);
    setIsRemoving(true);
    try {
      setAvatarPreview(null);
      await removeWorkspaceAvatar(currentWorkspace.id);
      await ctxUpdateWorkspace(currentWorkspace.id, { avatar_url: null });
      toast({ variant: 'success', title: 'Avatar removed', description: 'Your workspace avatar has been removed.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to remove avatar.' });
    } finally {
      setIsRemoving(false);
    }
  }, [currentWorkspace, isRemoving, ctxUpdateWorkspace, toast]);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (avatarEditButtonRef.current && avatarEditButtonRef.current.contains(target)) return;
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(target)) {
        setAvatarMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [avatarMenuOpen]);

  function validate(): boolean {
    if (!name.trim()) {
      setErrors({ name: 'Workspace name is required' });
      return false;
    }
    if (name.trim().length < 2) {
      setErrors({ name: 'Name must be at least 2 characters' });
      return false;
    }
    if (name.trim().length > 50) {
      setErrors({ name: 'Name must be 50 characters or less' });
      return false;
    }
    setErrors({});
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate() || !currentWorkspace) return;

    const hasChanges =
      name.trim() !== currentWorkspace.name ||
      description.trim() !== (currentWorkspace.description ?? '');

    if (!hasChanges) return;

    setIsSaving(true);
    try {
      await ctxUpdateWorkspace(currentWorkspace.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      toast({ variant: 'success', title: 'Settings saved', description: 'Your workspace settings have been updated.' });
    } catch {
      toast({ variant: 'error', description: 'Failed to save settings.' });
    } finally {
      setIsSaving(false);
    }
  }

  if (!currentWorkspace) return null;

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.avatarSection}>
        <div className={styles.avatarDisplayArea}>
          <WorkspaceAvatar
            name={currentWorkspace.name}
            avatarUrl={avatarPreview ?? currentWorkspace.avatar_url}
            size="lg"
          />
          {canAvatar && (
            <button
              type="button"
              className={styles.avatarEditButton}
              ref={avatarEditButtonRef}
              onClick={() => {
                setShowEmojiPicker(false);
                setAvatarMenuOpen((prev) => !prev);
              }}
              aria-label="Edit avatar"
              aria-expanded={avatarMenuOpen}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          )}

          {avatarMenuOpen && (
            <div className={styles.avatarMenu} role="menu" aria-label="Avatar options" ref={avatarMenuRef}>
              <button
                type="button"
                className={styles.avatarMenuItem}
                role="menuitem"
                onClick={handleSetInitial}
              >
                <span className={styles.avatarMenuItemIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <span className={styles.avatarMenuItemText}>
                  <span className={styles.avatarMenuItemLabel}>Initials</span>
                  <span className={styles.avatarMenuItemHint}>Show the workspace monogram</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.avatarMenuItem}
                role="menuitem"
                onClick={handleOpenEmojiPicker}
              >
                <span className={styles.avatarMenuItemIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" />
                    <line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                </span>
                <span className={styles.avatarMenuItemText}>
                  <span className={styles.avatarMenuItemLabel}>Emoji</span>
                  <span className={styles.avatarMenuItemHint}>Pick something fun</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.avatarMenuItem}
                role="menuitem"
                onClick={() => {
                  setAvatarMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                <span className={styles.avatarMenuItemIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </span>
                <span className={styles.avatarMenuItemText}>
                  <span className={styles.avatarMenuItemLabel}>Photo</span>
                  <span className={styles.avatarMenuItemHint}>Upload your own image</span>
                </span>
              </button>
            </div>
          )}

          {showEmojiPicker && (
            <EmojiPicker
              position={emojiPosition}
              onSelect={handleEmojiSelect}
              onClose={() => setShowEmojiPicker(false)}
              showCloseButton
            />
          )}
        </div>
        <div className={styles.avatarActions}>
          <span className={styles.avatarLabel}>Workspace avatar</span>
          <div className={styles.avatarButtons}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className={styles.hiddenInput}
              onChange={handleAvatarChange}
              disabled={!canAvatar || isUploading}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={isUploading}
              disabled={!canAvatar}
              onClick={() => fileInputRef.current?.click()}
            >
              {avatarPreview || currentWorkspace.avatar_url ? 'Change image' : 'Upload image'}
            </Button>
            {(avatarPreview || currentWorkspace.avatar_url) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={isRemoving}
                disabled={!canAvatar || isRemoving}
                onClick={handleRemoveAvatar}
              >
                Remove
              </Button>
            )}
          </div>
          {isUploading && (
            <div className={styles.uploadProgress}>
              <div className={styles.uploadProgressBar}>
                <div
                  className={styles.uploadProgressFill}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span className={styles.uploadProgressText}>Uploading... {uploadProgress}%</span>
            </div>
          )}
        </div>
      </div>

      <Input
        label="Name"
        required
        placeholder="My Workspace"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (errors.name) setErrors({ name: undefined });
        }}
        error={errors.name}
        maxLength={50}
        disabled={!canEdit}
      />

      <Input
        label="Description"
        placeholder="What is this workspace for?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={200}
        disabled={!canEdit}
      />

      {canEdit && (
        <div className={styles.actions}>
          <Button type="submit" loading={isSaving}>
            Save changes
          </Button>
        </div>
      )}

      <div className={styles.visibilitySection}>
        <h3 className={styles.sectionTitle}>Automation visibility</h3>
        <p className={styles.sectionHint}>
          Choose which automations you see on the automation page. This only changes your own view.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => setShowVisibility(true)}
            title="Choose which automations you see"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Showing: {visibility === 'own' ? 'Mine' : visibility === 'all' ? "Everyone's" : 'Selected'}
          </button>
        </div>
      </div>

      <div className={styles.visibilitySection}>
        <h3 className={styles.sectionTitle}>Forwarded attachments</h3>
        <p className={styles.sectionHint}>
          Choose what happens to the files of a message you sent when you delete it after it has been forwarded.
        </p>
        <div className={styles.optionList}>
          <Radio
            id="forwarded-policy-keep"
            name="forwarded-policy"
            value="keep"
            checked={forwardedPolicy === 'keep'}
            disabled={isSavingPolicy}
            onChange={() => handlePolicyChange('keep')}
            label="Keep forwarded files"
            description="Deleting your message won't delete files that forwarded copies still use, so forwards keep working."
          />
          <Radio
            id="forwarded-policy-delete"
            name="forwarded-policy"
            value="delete"
            checked={forwardedPolicy === 'delete'}
            disabled={isSavingPolicy}
            onChange={() => handlePolicyChange('delete')}
            label="Delete forwarded files"
            description="Deleting your message also removes its files from forwarded copies, leaving them without attachments."
          />
        </div>
      </div>

      {canEdit && (
        <InviteLinkSection />
      )}

      <AutomationVisibilityDialog
        open={showVisibility}
        visibility={visibility}
        visibleMembers={visibleMembers}
        onSave={setVisibility}
        onClose={() => setShowVisibility(false)}
      />
    </form>
  );
}

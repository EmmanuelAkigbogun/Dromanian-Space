import { useState, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { Dialog } from '@/components/ui/Dialog';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/ui/Toast';
import type { Project, ProjectVisibility } from '@/types';
import styles from './ProjectSettings.module.css';

interface ProjectSettingsProps {
  project: Project;
  onUpdate: (updates: Partial<Project>) => void;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  canManage?: boolean;
}

const VISIBILITY_OPTIONS = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'members', label: 'Members Only' },
  { value: 'private', label: 'Private' },
];

const COLOR_PRESETS = [
  '#82A6B1', '#4A90D9', '#8B5CF6', '#2D8A4E',
  '#D4A03C', '#E8784A', '#C43E3E', '#EC4899',
  '#14B8A6', '#6366F1', '#F59E0B', '#6B7280',
];

export function ProjectSettings({ project, onUpdate, onArchive, onDelete, canManage = false }: ProjectSettingsProps) {
  const { toast } = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || '');
  const [icon, setIcon] = useState(project.icon || '');
  const [color, setColor] = useState(project.color || COLOR_PRESETS[0]);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility);
  const [isSaving, setIsSaving] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const emojiAnchorRef = useRef<HTMLButtonElement>(null);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast({ description: 'Project name is required', variant: 'error' });
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('projects')
        .update({
          name: name.trim(),
          description: description.trim() || null,
          icon: icon || null,
          color,
          visibility,
          updated_at: new Date().toISOString(),
        })
        .eq('id', project.id);

      if (error) throw error;

      onUpdate({
        name: name.trim(),
        description: description.trim() || null,
        icon: icon || null,
        color,
        visibility,
      });

      toast({ description: 'Settings saved', variant: 'success' });
    } catch {
      toast({ description: 'Failed to save settings', variant: 'error' });
    } finally {
      setIsSaving(false);
    }
  }, [name, description, icon, color, visibility, project.id, onUpdate, toast]);

  const handleArchive = useCallback(async () => {
    try {
      await onArchive();
      setShowArchiveConfirm(false);
    } catch {
      toast({ description: 'Failed to archive project', variant: 'error' });
    }
  }, [onArchive, toast]);

  const handleDelete = useCallback(async () => {
    if (deleteConfirmText !== project.name) return;
    await onDelete();
    toast({ description: 'Project deleted', variant: 'success' });
  }, [deleteConfirmText, project.name, onDelete, toast]);

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>General</h3>
        <div className={styles.sectionContent}>
          <div className={styles.iconSection}>
            <button
              ref={emojiAnchorRef}
              type="button"
              className={styles.iconButton}
              onClick={() => canManage && setShowEmojiPicker(!showEmojiPicker)}
              disabled={!canManage}
            >
              {icon ? (
                <span className={styles.iconPreview}>{icon}</span>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              )}
            </button>
            {showEmojiPicker && (
              <EmojiPicker
                position={{ x: 80, y: 200 }}
                onSelect={(emoji) => {
                  setIcon(emoji);
                  setShowEmojiPicker(false);
                }}
                onClose={() => setShowEmojiPicker(false)}
              />
            )}
            <div className={styles.colorPicker}>
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${styles.colorDot} ${color === c ? styles.colorActive : ''}`}
                  style={{ backgroundColor: c }}
                  onClick={() => canManage && setColor(c)}
                  disabled={!canManage}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          <Input
            label="Project Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            disabled={!canManage}
          />

          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Project description"
            rows={3}
            disabled={!canManage}
          />

          <Select
            label="Visibility"
            options={VISIBILITY_OPTIONS}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
            disabled={!canManage}
          />

          <div className={styles.saveRow}>
            {canManage ? (
              <Button onClick={handleSave} loading={isSaving}>
                Save Changes
              </Button>
            ) : (
              <p className={styles.readOnlyNote}>
                Only the project owner or an admin can change these settings.
              </p>
            )}
          </div>
        </div>
      </div>

      {canManage && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Archive</h3>
          <div className={styles.sectionContent}>
            <p className={styles.sectionDescription}>
              Archiving a project hides it from the active list but preserves all data. It can be restored later.
            </p>
            <Button variant="secondary" onClick={() => setShowArchiveConfirm(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-2)' }}>
                <path d="M21 8v13H3V8" />
                <path d="M1 3h22v5H1z" />
                <path d="M10 12h4" />
              </svg>
              Archive Project
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showArchiveConfirm} onClose={() => setShowArchiveConfirm(false)} title="Archive project" size="sm">
        <p className={styles.archiveDescription}>
          Archive <strong>{project.name}</strong>? It will be hidden from the active list but all data is preserved. You can restore it anytime.
        </p>
        <div className={styles.archiveActions}>
          <Button variant="ghost" onClick={() => setShowArchiveConfirm(false)}>
            Cancel
          </Button>
          <Button onClick={handleArchive}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-2)' }}>
              <path d="M21 8v13H3V8" />
              <path d="M1 3h22v5H1z" />
              <path d="M10 12h4" />
            </svg>
            Archive
          </Button>
        </div>
      </Dialog>

      {canManage && (
        <div className={`${styles.section} ${styles.dangerSection}`}>
          <h3 className={`${styles.sectionTitle} ${styles.dangerTitle}`}>Danger Zone</h3>
          <div className={styles.sectionContent}>
            <p className={styles.sectionDescription}>
              Permanently delete this project and all its data. This action cannot be undone.
            </p>

            {!showDeleteConfirm ? (
              <Button variant="danger" onClick={() => setShowDeleteConfirm(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 'var(--space-2)' }}>
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Delete Project
              </Button>
            ) : (
              <div className={styles.deleteConfirm}>
                <p className={styles.deleteWarning}>
                  Type <strong>{project.name}</strong> to confirm deletion.
                </p>
                <Input
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={project.name}
                  autoFocus
                />
                <div className={styles.deleteActions}>
                  <Button variant="ghost" onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(''); }}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    onClick={handleDelete}
                    disabled={deleteConfirmText !== project.name}
                  >
                    Delete Forever
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

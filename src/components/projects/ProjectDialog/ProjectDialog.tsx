import { useState, useCallback, useRef, useEffect } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import type { Project, ProjectVisibility } from '@/types';
import styles from './ProjectDialog.module.css';

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

interface ProjectDialogProps {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  onSave: (data: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    visibility?: ProjectVisibility;
    due_date?: string;
  }) => Promise<boolean>;
}

export function ProjectDialog({ open, onClose, project, onSave }: ProjectDialogProps) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [icon, setIcon] = useState(project?.icon || '');
  const [color, setColor] = useState(project?.color || COLOR_PRESETS[0]);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project?.visibility || 'workspace');
  const [dueDate, setDueDate] = useState(project?.due_date ? project.due_date.split('T')[0] : '');
  const [isSaving, setIsSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiAnchorRef = useRef<HTMLButtonElement>(null);

  const isEditing = !!project;

  useEffect(() => {
    if (open) {
      setName(project?.name || '');
      setDescription(project?.description || '');
      setIcon(project?.icon || '');
      setColor(project?.color || COLOR_PRESETS[0]);
      setVisibility(project?.visibility || 'workspace');
      setDueDate(project?.due_date ? project.due_date.split('T')[0] : '');
      setNameError('');
    }
  }, [open, project]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setNameError('Project name is required');
      return;
    }

    setIsSaving(true);
    try {
      const success = await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon || undefined,
        color,
        visibility,
        due_date: dueDate || undefined,
      });
      if (success) onClose();
    } finally {
      setIsSaving(false);
    }
  }, [name, description, icon, color, visibility, dueDate, onSave, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave();
    }
  }, [handleSave]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEditing ? 'Edit Project' : 'Create Project'}
      size="md"
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={isSaving}>
            {isEditing ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      }
    >
      <div className={styles.form} onKeyDown={handleKeyDown}>
        <div className={styles.iconSection}>
          <button
            ref={emojiAnchorRef}
            type="button"
            className={styles.iconButton}
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            aria-label="Choose project icon"
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
              position={{ x: 80, y: 100 }}
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
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>

        <Input
          label="Project Name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError('');
          }}
          error={nameError}
          placeholder="e.g. Website Redesign"
          autoFocus
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this project about?"
          rows={3}
        />

        <div className={styles.row}>
          <Select
            label="Visibility"
            options={VISIBILITY_OPTIONS}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ProjectVisibility)}
          />
          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}

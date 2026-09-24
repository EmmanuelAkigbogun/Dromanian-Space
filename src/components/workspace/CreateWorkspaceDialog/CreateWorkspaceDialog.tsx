import { useState, useCallback, type FormEvent } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { WorkspaceAvatar } from '@/components/workspace/WorkspaceAvatar';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import styles from './CreateWorkspaceDialog.module.css';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function CreateWorkspaceDialog({ open, onClose }: CreateWorkspaceDialogProps) {
  const { createWorkspace, workspaces } = useWorkspace();
  const { toast } = useToast();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});

  const resetForm = useCallback(() => {
    setName('');
    setSlug('');
    setDescription('');
    setSlugEdited(false);
    setErrors({});
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
    if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
  }

  function handleSlugChange(value: string) {
    setSlugEdited(true);
    setSlug(slugify(value));
    if (errors.slug) setErrors((prev) => ({ ...prev, slug: undefined }));
  }

  function validate(): boolean {
    const next: typeof errors = {};

    if (!name.trim()) {
      next.name = 'Workspace name is required';
    } else if (name.trim().length < 2) {
      next.name = 'Name must be at least 2 characters';
    } else if (name.trim().length > 50) {
      next.name = 'Name must be 50 characters or less';
    }

    if (!slug) {
      next.slug = 'Slug is required';
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      next.slug = 'Slug can only contain lowercase letters, numbers, and hyphens';
    } else if (slug.length < 3) {
      next.slug = 'Slug must be at least 3 characters';
    } else if (workspaces.some((w) => w.slug === slug)) {
      next.slug = 'A workspace with this slug already exists';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setIsCreating(true);
    try {
      const workspace = await createWorkspace(name.trim(), slug, description.trim() || undefined);
      if (workspace) {
        toast({ variant: 'success', title: 'Workspace created', description: `"${workspace.name}" is ready to use.` });
        handleClose();
      } else {
        toast({ variant: 'error', description: 'Failed to create workspace. Please try again.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Create workspace"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isCreating} disabled={!name.trim() || !slug}>
            Create workspace
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.previewRow}>
          <WorkspaceAvatar name={name || '?'} size="lg" />
          <div className={styles.previewInfo}>
            <span className={styles.previewName}>{name || 'Workspace name'}</span>
            <span className={styles.previewSlug}>{slug || 'workspace-slug'}</span>
          </div>
        </div>

        <Input
          label="Name"
          required
          placeholder="My Workspace"
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          error={errors.name}
          maxLength={50}
          autoFocus
        />

        <Input
          label="URL slug"
          required
          placeholder="my-workspace"
          value={slug}
          onChange={(e) => handleSlugChange(e.target.value)}
          error={errors.slug}
          helperText={!errors.slug ? `dark-space.space/${slug || '...'}` : undefined}
          maxLength={48}
        />

        <Input
          label="Description"
          placeholder="Optional — what is this workspace for?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
        />
      </form>
    </Dialog>
  );
}

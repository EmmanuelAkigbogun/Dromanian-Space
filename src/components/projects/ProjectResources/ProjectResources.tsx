import { useState, useEffect, useCallback, useRef } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { uploadFile, getSignedUrlsBatch } from '@/lib/message/attachment';
import { getDisplayName } from '@/lib/message';
import { formatRelativeTime } from '@/utils';
import styles from './ProjectResources.module.css';

interface ProjectResource {
  id: string;
  project_id: string;
  created_by: string;
  type: 'link' | 'image';
  url: string;
  title: string | null;
  created_at: string;
}

interface ResourceComment {
  id: string;
  resource_id: string;
  user_id: string;
  content: string;
  created_at: string;
  profile?: {
    display_name: string | null;
    avatar_url: string | null;
    email: string | null;
  };
}

interface ProjectResourcesProps {
  projectId: string;
  canManage?: boolean;
}

export function ProjectResources({ projectId, canManage = false }: ProjectResourcesProps) {
  const { userId } = useAuth();
  const { toast } = useToast();
  const canContribute = Boolean(userId);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [signedUrls, setSignedUrls] = useState<Map<string, string | null>>(new Map());
  const [failedResources, setFailedResources] = useState<Set<string>>(new Set());
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [isAddingLink, setIsAddingLink] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandedIdRef = useRef<string | null>(null);
  const [deleteResource, setDeleteResource] = useState<ProjectResource | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [comments, setComments] = useState<Record<string, ResourceComment[]>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [commentInput, setCommentInput] = useState('');
  const [commentSendingId, setCommentSendingId] = useState<string | null>(null);

  const fetchResources = useCallback(async () => {
    const { data, error } = await supabase
      .from('project_resources' as any)
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error || !data) {
      setError(error?.message || 'Could not load resources.');
      setIsLoading(false);
      return;
    }

    setError(null);

    const rows = data as unknown as ProjectResource[];
    setResources(rows);

    const commentIds = rows.map((r) => r.id);
    if (commentIds.length > 0) {
      const { data: commentRows } = await supabase
        .from('project_resource_comments' as any)
        .select('resource_id')
        .in('resource_id', commentIds);
      const counts: Record<string, number> = {};
      for (const row of (commentRows ?? []) as unknown as { resource_id: string }[]) {
        counts[row.resource_id] = (counts[row.resource_id] ?? 0) + 1;
      }
      setCommentCounts(counts);
    } else {
      setCommentCounts({});
    }

    const imageUrls = rows.filter((r) => r.type === 'image').map((r) => r.url);
    if (imageUrls.length > 0) {
      const signed = await getSignedUrlsBatch(imageUrls);
      setSignedUrls(signed);
      const failed = new Set<string>();
      for (const r of rows) {
        if (r.type === 'image' && !signed.get(r.url)) failed.add(r.id);
      }
      setFailedResources(failed);
    } else {
      setFailedResources(new Set());
    }
    setIsLoading(false);
  }, [projectId]);

  const fetchComments = useCallback(async (resourceId: string) => {
    const { data, error } = await supabase
      .from('project_resource_comments' as any)
      .select('*, profile:profiles(display_name, avatar_url, email)')
      .eq('resource_id', resourceId)
      .order('created_at', { ascending: true });

    if (error || !data) return;
    setComments((prev) => ({ ...prev, [resourceId]: data as unknown as ResourceComment[] }));
  }, []);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-resources-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_resources', filter: `project_id=eq.${projectId}` },
        () => fetchResources(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, fetchResources]);

  useEffect(() => {
    const channel = supabase
      .channel(`project-resource-comments-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'project_resource_comments' },
        () => {
          fetchResources();
          if (expandedIdRef.current) {
            fetchComments(expandedIdRef.current);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, fetchResources, fetchComments]);

  const handleAddLink = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url || !userId) return;

    const normalized = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
    setIsAddingLink(true);
    const { error } = await supabase
      .from('project_resources' as any)
      .insert({
        project_id: projectId,
        created_by: userId,
        type: 'link',
        url: normalized,
        title: linkTitle.trim() || null,
      });

    if (error) {
      toast({ description: 'Failed to add link', variant: 'error' });
    } else {
      setLinkUrl('');
      setLinkTitle('');
      toast({ description: 'Link added', variant: 'success' });
      fetchResources();
    }
    setIsAddingLink(false);
  }, [linkUrl, linkTitle, projectId, userId, fetchResources, toast]);

  const handleUploadImages = useCallback(
    async (files: File[]) => {
      if (!userId || files.length === 0) return;
      setIsUploading(true);
      setUploadProgress(0);
      setUploadIndex(0);
      setUploadTotal(files.length);

      let saved = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadIndex(i + 1);
        const path = await uploadFile(
          file,
          `project-resources/${projectId}`,
          (percent) => setUploadProgress(percent),
        );
        if (!path) {
          toast({ description: `"${file.name}" upload failed`, variant: 'error' });
          continue;
        }

        const { error } = await supabase
          .from('project_resources' as any)
          .insert({
            project_id: projectId,
            created_by: userId,
            type: 'image',
            url: path,
            title: file.name,
          });

        if (error) {
          toast({ description: `Failed to save "${file.name}"`, variant: 'error' });
        } else {
          saved++;
        }
      }

      setIsUploading(false);
      setUploadProgress(0);
      setUploadIndex(0);
      setUploadTotal(0);

      if (saved > 0) {
        toast({
          description: saved === 1 ? 'Image added' : `${saved} images added`,
          variant: 'success',
        });
        fetchResources();
      }
    },
    [projectId, userId, fetchResources, toast],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteResource) return;
    setIsDeleting(true);
    const { error } = await supabase
      .from('project_resources' as any)
      .delete()
      .eq('id', deleteResource.id);

    setIsDeleting(false);
    if (error) {
      toast({ description: 'Failed to delete item', variant: 'error' });
      return;
    }
    setResources((prev) => prev.filter((r) => r.id !== deleteResource.id));
    setDeleteResource(null);
    toast({ description: 'Item deleted', variant: 'success' });
  }, [deleteResource, toast]);

  const handleAddComment = useCallback(
    async (resourceId: string) => {
      const content = commentInput.trim();
      if (!content || !userId || commentSendingId) return;

      setCommentSendingId(resourceId);
      const { data, error } = await supabase
        .from('project_resource_comments' as any)
        .insert({ resource_id: resourceId, user_id: userId, content })
        .select()
        .single();

      setCommentSendingId(null);
      if (error || !data) {
        toast({ description: 'Failed to add comment', variant: 'error' });
        return;
      }
      setCommentInput('');
      setCommentCounts((prev) => ({ ...prev, [resourceId]: (prev[resourceId] ?? 0) + 1 }));
      await fetchComments(resourceId);
    },
    [commentInput, userId, commentSendingId, fetchComments, toast],
  );

  const handleDeleteComment = useCallback(
    async (resourceId: string, commentId: string) => {
      const { error } = await supabase
        .from('project_resource_comments' as any)
        .delete()
        .eq('id', commentId);

      if (error) {
        toast({ description: 'Failed to delete comment', variant: 'error' });
        return;
      }
      setCommentCounts((prev) => ({
        ...prev,
        [resourceId]: Math.max(0, (prev[resourceId] ?? 0) - 1),
      }));
      await fetchComments(resourceId);
    },
    [fetchComments, toast],
  );

  const commentName = useCallback(
    (c: ResourceComment) =>
      getDisplayName(
        {
          display_name: c.profile?.display_name ?? null,
          username: null,
          email: c.profile?.email ?? undefined,
        },
        c.user_id,
      ),
    [],
  );

  const handleToggleExpand = useCallback(
    async (resourceId: string) => {
      if (expandedId === resourceId) {
        expandedIdRef.current = null;
        setExpandedId(null);
        return;
      }
      expandedIdRef.current = resourceId;
      setExpandedId(resourceId);
      if (!comments[resourceId]) {
        await fetchComments(resourceId);
      }
    },
    [expandedId, comments, fetchComments],
  );

  const resourceComments = (id: string) => comments[id] ?? [];

  return (
    <div className={styles.container}>
      {canContribute && (
        <div className={styles.addPanel}>
          <div className={styles.addRow}>
            <Input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="Paste a link (https://...)"
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddLink(); }}
            />
            <Input
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              placeholder="Title (optional)"
            />
            <Button onClick={handleAddLink} loading={isAddingLink}>
              Add link
            </Button>
          </div>
          <label className={styles.uploadLabel}>
            <input
              type="file"
              accept="image/*"
              multiple
              className={styles.uploadInput}
              disabled={isUploading}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) handleUploadImages(files);
                e.target.value = '';
              }}
            />
            {isUploading ? (
              <span className={styles.uploadText}>
                <Spinner size="sm" />
                {uploadTotal > 1 ? `Uploading ${uploadIndex}/${uploadTotal}` : 'Uploading...'}
                {uploadProgress > 0 && ` ${uploadProgress}%`}
              </span>
            ) : (
              <span className={styles.uploadText}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                Upload images
              </span>
            )}
          </label>
          {isUploading && (
            <div className={styles.uploadProgressBar}>
              <div
                className={styles.uploadProgressFill}
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className={styles.loading}>
          <Spinner size="md" />
        </div>
      ) : error ? (
        <div className={styles.error}>
          <p>Could not load resources.</p>
          <span>{error}</span>
        </div>
      ) : resources.length === 0 ? (
        <div className={styles.empty}>
          <p>No links or images yet. {canContribute ? 'Paste a link or upload an image above.' : ''}</p>
        </div>
      ) : (
        <div className={styles.grid}>
          {resources.map((resource) => {
            const signedUrl = resource.type === 'image' ? (signedUrls.get(resource.url) ?? null) : null;
            const isExpanded = expandedId === resource.id;
            const canDelete = resource.created_by === userId || canManage;

            return (
              <div key={resource.id} className={styles.card}>
                <div className={styles.cardBody}>
                  {resource.type === 'image' ? (
                    <div className={styles.imageWrap}>
                      {signedUrl ? (
                        <a href={signedUrl} target="_blank" rel="noopener noreferrer">
                          <img src={signedUrl} alt={resource.title ?? 'Image'} className={styles.image} loading="lazy" />
                        </a>
                      ) : failedResources.has(resource.id) ? (
                        <div className={styles.imageFailed}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <polyline points="21 15 16 10 5 21" />
                          </svg>
                          Image unavailable
                        </div>
                      ) : (
                        <div className={styles.imagePlaceholder}>
                          <Spinner size="sm" />
                        </div>
                      )}
                    </div>
                  ) : (
                    <a
                      href={resource.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.linkCard}
                    >
                      <span className={styles.linkIcon}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                        </svg>
                      </span>
                      <div className={styles.linkInfo}>
                        <span className={styles.linkTitle}>{resource.title || resource.url}</span>
                        <span className={styles.linkUrl}>{resource.url}</span>
                      </div>
                    </a>
                  )}
                  {resource.type === 'image' && resource.title && (
                    <div className={styles.imageTitle}>{resource.title}</div>
                  )}
                </div>

                <div className={styles.cardFooter}>
                  <button
                    type="button"
                    className={styles.commentToggle}
                    onClick={() => handleToggleExpand(resource.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    Comments ({commentCounts[resource.id] ?? 0})
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      onClick={() => setDeleteResource(resource)}
                      title="Delete"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  )}
                </div>

                {isExpanded && (
                  <div className={styles.comments}>
                    {resourceComments(resource.id).length === 0 ? (
                      <p className={styles.noComments}>No comments yet.</p>
                    ) : (
                      resourceComments(resource.id).map((c) => (
                        <div key={c.id} className={styles.comment}>
                          <Avatar
                            src={c.profile?.avatar_url ?? undefined}
                            name={commentName(c)}
                            size="xs"
                          />
                          <div className={styles.commentBody}>
                            <div className={styles.commentHeader}>
                              <span className={styles.commentAuthor}>
                                {commentName(c)}
                              </span>
                              <span className={styles.commentTime}>{formatRelativeTime(c.created_at)}</span>
                              {(c.user_id === userId || canManage) && (
                                <button
                                  type="button"
                                  className={styles.commentDelete}
                                  onClick={() => handleDeleteComment(resource.id, c.id)}
                                  title="Delete comment"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                  </svg>
                                </button>
                              )}
                            </div>
                            <span className={styles.commentText}>{c.content}</span>
                          </div>
                        </div>
                      ))
                    )}
                    {canContribute && (
                      <div className={styles.commentInputRow}>
                        <input
                          className={styles.commentInput}
                          value={commentInput}
                          onChange={(e) => setCommentInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleAddComment(resource.id); }}
                          placeholder="Write a comment..."
                        />
                        <Button
                          size="sm"
                          onClick={() => handleAddComment(resource.id)}
                          disabled={commentSendingId === resource.id || !commentInput.trim()}
                        >
                          {commentSendingId === resource.id ? <Spinner size="sm" /> : 'Post'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteResource !== null}
        title="Delete item"
        message={deleteResource
          ? `Delete "${deleteResource.title || (deleteResource.type === 'image' ? 'image' : deleteResource.url)}"? This action cannot be undone.`
          : ''}
        confirmLabel="Delete"
        danger
        loading={isDeleting}
        onConfirm={handleDelete}
        onClose={() => { if (!isDeleting) setDeleteResource(null); }}
      />
    </div>
  );
}

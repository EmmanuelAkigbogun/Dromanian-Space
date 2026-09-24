import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useTasks } from '@/hooks/useTasks';
import { supabase } from '@/lib/supabase';
import { formatRelativeTime } from '@/utils';
import { Avatar } from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/Spinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog/ConfirmDialog';
import type { TaskComment } from '@/types/task';
import type { Profile } from '@/types';
import styles from './TaskComments.module.css';

interface TaskCommentsProps {
  taskId: string;
}

interface CommentWithProfile extends TaskComment {
  profile?: Profile;
  replies?: CommentWithProfile[];
}

export function TaskComments({ taskId }: TaskCommentsProps) {
  const { userId } = useAuth();
  const { getTaskComments, addTaskComment, updateTaskComment, deleteTaskComment } = useTasks();
  const [comments, setComments] = useState<CommentWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadComments = useCallback(async () => {
    setIsLoading(true);
    const rawComments = await getTaskComments(taskId);

    const userIds = [...new Set(rawComments.map((c) => c.user_id))];
    let profilesMap: Record<string, Profile> = {};

    if (userIds.length > 0) {
      const { data } = await supabase
        .from('profiles' as any)
        .select('*')
        .in('id', userIds);

      if (data) {
        for (const p of data as unknown as Profile[]) {
          profilesMap[p.id] = p;
        }
      }
    }

    const topLevel = rawComments.filter((c) => !c.parent_id);
    const withProfiles: CommentWithProfile[] = topLevel.map((c) => ({
      ...c,
      profile: profilesMap[c.user_id],
      replies: rawComments
        .filter((r) => r.parent_id === c.id)
        .map((r) => ({ ...r, profile: profilesMap[r.user_id] })),
    }));

    setComments(withProfiles);
    setIsLoading(false);
  }, [taskId, getTaskComments]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const handleSubmit = useCallback(async () => {
    if (!newComment.trim() || isSubmitting) return;
    setIsSubmitting(true);

    const comment = await addTaskComment(taskId, newComment.trim());
    if (comment) {
      setNewComment('');
      await loadComments();
    }

    setIsSubmitting(false);
  }, [newComment, isSubmitting, taskId, addTaskComment, loadComments]);

  const handleReply = useCallback(async (parentId: string) => {
    if (!replyContent.trim() || isSubmitting) return;
    setIsSubmitting(true);

    const comment = await addTaskComment(taskId, replyContent.trim(), parentId);
    if (comment) {
      setReplyContent('');
      setReplyingTo(null);
      await loadComments();
    }

    setIsSubmitting(false);
  }, [replyContent, isSubmitting, taskId, addTaskComment, loadComments]);

  const handleEdit = useCallback(async (commentId: string) => {
    if (!editContent.trim() || isSubmitting) return;
    setIsSubmitting(true);

    const success = await updateTaskComment(commentId, editContent.trim());
    if (success) {
      setEditingId(null);
      setEditContent('');
      await loadComments();
    }

    setIsSubmitting(false);
  }, [editContent, isSubmitting, updateTaskComment, loadComments]);

  const handleDelete = useCallback((commentId: string) => {
    setDeletingId(commentId);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingId) return;
    setIsDeleting(true);
    const success = await deleteTaskComment(deletingId);
    setIsDeleting(false);
    if (success) {
      await loadComments();
    }
    setDeletingId(null);
  }, [deletingId, deleteTaskComment, loadComments]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <span className={styles.loadingSpinner}>
          <Spinner size="sm" />
        </span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.commentsList}>
        {comments.length === 0 && (
          <p className={styles.emptyComments}>No comments yet</p>
        )}

        {comments.map((comment) => (
          <div key={comment.id}>
            <div className={styles.comment}>
              <Avatar
                src={comment.profile?.avatar_url ?? undefined}
                name={comment.profile?.display_name ?? comment.profile?.username ?? 'User'}
                size="sm"
              />
              <div className={styles.commentBody}>
                <div className={styles.commentHeader}>
                  <span className={styles.commentAuthor}>
                    {comment.profile?.display_name ?? comment.profile?.username ?? 'Unknown'}
                  </span>
                  <span className={styles.commentTime}>
                    {formatRelativeTime(comment.created_at)}
                  </span>
                </div>

                {editingId === comment.id ? (
                  <div className={styles.editSection}>
                    <textarea
                      className={styles.editInput}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleEdit(comment.id);
                        }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                    />
                    <div className={styles.editActions}>
                      <button
                        type="button"
                        className={styles.editSaveButton}
                        onClick={() => handleEdit(comment.id)}
                        disabled={!editContent.trim() || isSubmitting}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className={styles.editCancelButton}
                        onClick={() => {
                          setEditingId(null);
                          setEditContent('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.commentContent}>{comment.content}</div>
                )}

                {editingId !== comment.id && (
                  <div className={styles.commentActions}>
                    <button
                      type="button"
                      className={styles.commentAction}
                      onClick={() => {
                        setReplyingTo(comment.id);
                        setReplyContent('');
                      }}
                    >
                      Reply
                    </button>
                    {comment.user_id === userId && (
                      <>
                        <button
                          type="button"
                          className={styles.commentAction}
                          onClick={() => {
                            setEditingId(comment.id);
                            setEditContent(comment.content);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`${styles.commentAction} ${styles.commentActionDanger}`}
                          onClick={() => handleDelete(comment.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {replyingTo === comment.id && (
              <div className={styles.replySection}>
                <div className={styles.addComment}>
                  <textarea
                    placeholder="Write a reply..."
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleReply(comment.id);
                      }
                    }}
                    rows={2}
                  />
                  <button
                    type="button"
                    className={styles.addCommentButton}
                    onClick={() => handleReply(comment.id)}
                    disabled={!replyContent.trim()}
                  >
                    Reply
                  </button>
                </div>
              </div>
            )}

            {comment.replies && comment.replies.length > 0 && (
              <div className={styles.replySection}>
                {comment.replies.map((reply) => (
                  <div key={reply.id} className={styles.comment}>
                    <Avatar
                      src={reply.profile?.avatar_url ?? undefined}
                      name={reply.profile?.display_name ?? reply.profile?.username ?? 'User'}
                      size="xs"
                    />
                    <div className={styles.commentBody}>
                      <div className={styles.commentHeader}>
                        <span className={styles.commentAuthor}>
                          {reply.profile?.display_name ?? reply.profile?.username ?? 'Unknown'}
                        </span>
                        <span className={styles.commentTime}>
                          {formatRelativeTime(reply.created_at)}
                        </span>
                      </div>
                      {editingId === reply.id ? (
                        <div className={styles.editSection}>
                          <textarea
                            className={styles.editInput}
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleEdit(reply.id);
                              }
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            autoFocus
                          />
                          <div className={styles.editActions}>
                            <button
                              type="button"
                              className={styles.editSaveButton}
                              onClick={() => handleEdit(reply.id)}
                              disabled={!editContent.trim() || isSubmitting}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className={styles.editCancelButton}
                              onClick={() => {
                                setEditingId(null);
                                setEditContent('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={styles.commentContent}>{reply.content}</div>
                      )}
                      {editingId !== reply.id && reply.user_id === userId && (
                        <div className={styles.commentActions}>
                          <button
                            type="button"
                            className={styles.commentAction}
                            onClick={() => {
                              setEditingId(reply.id);
                              setEditContent(reply.content);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={`${styles.commentAction} ${styles.commentActionDanger}`}
                            onClick={() => handleDelete(reply.id)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.addComment}>
        <textarea
          placeholder="Add a comment..."
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          rows={2}
        />
        <button
          type="button"
          className={styles.addCommentButton}
          onClick={handleSubmit}
          disabled={!newComment.trim() || isSubmitting}
        >
          {isSubmitting ? <Spinner size="sm" color="inverse" /> : 'Comment'}
        </button>
      </div>

      <ConfirmDialog
        open={deletingId !== null}
        title="Delete comment"
        message="Are you sure you want to delete this comment? This cannot be undone."
        confirmLabel="Delete"
        danger
        loading={isDeleting}
        onConfirm={handleConfirmDelete}
        onClose={() => {
          if (!isDeleting) setDeletingId(null);
        }}
      />
    </div>
  );
}

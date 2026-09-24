import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { FilesGrid } from './FilesGrid';
import type { FileAttachment } from '@/types';
import styles from './Files.module.css';

const PAGE_SIZE = 50;

export function Files() {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const fetchFiles = useCallback(
    async (rangeStart: number, reset: boolean) => {
      if (!userId) return;
      setIsLoading(reset);
      setIsLoadingMore(!reset);

      const query = supabase
        .from('file_attachments')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(rangeStart, rangeStart + PAGE_SIZE - 1);

      if (currentWorkspace) {
        query.eq('workspace_id', currentWorkspace.id);
      }

      const { data, error } = await query;

      if (!error && data) {
        setFiles((prev) => (reset ? (data as FileAttachment[]) : [...prev, ...(data as FileAttachment[])]));
        setHasMore(data.length === PAGE_SIZE);
      }
      setIsLoading(false);
      setIsLoadingMore(false);
    },
    [userId, currentWorkspace],
  );

  useEffect(() => {
    fetchFiles(0, true);
  }, [fetchFiles]);

  const handleLoadMore = useCallback(() => {
    fetchFiles(files.length, false);
  }, [files.length, fetchFiles]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Files</h1>
        </div>
        <div className={styles.loading}>Loading files...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Files</h1>
        <p className={styles.subtitle}>
          {files.length} file{files.length !== 1 ? 's' : ''} uploaded
        </p>
      </div>

      {files.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <h3 className={styles.emptyTitle}>No files yet</h3>
          <p className={styles.emptyDescription}>
            Files you attach to messages will appear here.
          </p>
        </div>
      ) : (
        <>
          <FilesGrid attachments={files} />
          {hasMore && (
            <div className={styles.loadMoreRow}>
              <button
                type="button"
                className={styles.loadMoreBtn}
                onClick={handleLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading...' : 'Load more files'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

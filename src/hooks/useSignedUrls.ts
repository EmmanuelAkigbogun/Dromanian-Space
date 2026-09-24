import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getSignedUrlsBatch, isLocalUrl } from '@/lib/message';
import type { FileAttachment } from '@/types';

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function useSignedUrls(attachments: FileAttachment[]) {
  const uniqueUrls = useMemo(
    () => [...new Set(attachments.map((a) => a.file_url).filter((u) => !isExternalUrl(u)))],
    [attachments],
  );
  const key = useMemo(() => [...uniqueUrls].sort().join('|'), [uniqueUrls]);

  const query = useQuery({
    queryKey: ['signedUrlBatch', key],
    queryFn: async () => {
      // getSignedUrlsBatch resolves every url (signed or null) so missing
      // files are handled without throwing and without the retry spam that
      // fired 400s for forwarded copies whose source file was deleted.
      return getSignedUrlsBatch(uniqueUrls);
    },
    staleTime: 55 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: 0,
    enabled: key.length > 0,
  });

  const map = query.data;

  const urlsData = useMemo(() => {
    const urls = new Map<string, string>();
    const loaded = new Set<string>();
    for (const att of attachments) {
      if (isLocalUrl(att.file_url) || isExternalUrl(att.file_url)) {
        urls.set(att.id, att.file_url);
        loaded.add(att.id);
      } else {
        const signed = map?.get(att.file_url);
        if (signed) {
          urls.set(att.id, signed);
          loaded.add(att.id);
        }
      }
    }
    return { urls, loaded };
  }, [attachments, map]);

  const failed = useMemo(() => {
    const set = new Set<string>();
    if (query.isError) {
      for (const att of attachments) {
        if (!isLocalUrl(att.file_url) && !isExternalUrl(att.file_url)) set.add(att.id);
      }
      return set;
    }
    for (const att of attachments) {
      if (!isLocalUrl(att.file_url) && !isExternalUrl(att.file_url) && map != null && map.get(att.file_url) == null) {
        set.add(att.id);
      }
    }
    return set;
  }, [attachments, map, query.isError]);

  return { urls: urlsData.urls, loaded: urlsData.loaded, failed, isLoading: query.isPending };
}

import { useEffect, useMemo, useState } from 'react';
import { platform } from '@/lib/platform';

export interface CallProfile {
  id: string;
  display_name: string | null;
  username: string | null;
  email: string | null;
  avatar_url: string | null;
}

export function useCallProfiles(userIds: readonly string[]): Map<string, CallProfile> {
  const idsKey = useMemo(() => [...new Set(userIds)].filter(Boolean).sort().join(','), [userIds]);
  const [profiles, setProfiles] = useState<Map<string, CallProfile>>(new Map());

  useEffect(() => {
    if (!idsKey) {
      setProfiles(new Map());
      return;
    }
    let active = true;
    const ids = idsKey.split(',');
    void platform
      .from('profiles')
      .select('id, display_name, username, email, avatar_url')
      .in('id', ids)
      .then(({ data }) => {
        if (!active) return;
        const next = new Map<string, CallProfile>();
        for (const row of data ?? []) next.set(row.id, row);
        setProfiles(next);
      });
    return () => { active = false; };
  }, [idsKey]);

  return profiles;
}

export function callProfileName(profile: CallProfile | undefined, fallback = 'Unknown caller'): string {
  return profile?.display_name || profile?.username || profile?.email?.split('@')[0] || fallback;
}

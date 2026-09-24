import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types';

const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  profile: Profile;
  fetchedAt: number;
}

const profileCache = new Map<string, CacheEntry>();

// Event system for realtime profile updates
type Listener = (userIds: string[]) => void;
const listeners = new Set<Listener>();

function notifyProfileChange(userId: string) {
  profileCache.delete(userId);
  listeners.forEach((fn) => fn([userId]));
}

// Subscribe to profiles table changes via a module-level singleton, held only
// while at least one useProfiles consumer is mounted. Profiles are global
// (not workspace-scoped), so events are filtered client-side by tracked ids.
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let realtimeSubscriberCount = 0;

function handleProfilePayload(payload: { new: Record<string, unknown> }) {
  const newProfile = payload.new as unknown as Profile;
  if (newProfile?.id) {
    notifyProfileChange(newProfile.id);
  }
}

function ensureRealtimeSubscription() {
  realtimeSubscriberCount += 1;
  if (realtimeChannel) return;
  realtimeChannel = supabase
    .channel('profiles-realtime')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, handleProfilePayload)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'profiles' }, handleProfilePayload)
    .subscribe();
}

function releaseRealtimeSubscription() {
  realtimeSubscriberCount = Math.max(0, realtimeSubscriberCount - 1);
  if (realtimeSubscriberCount === 0 && realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

function cleanupCache() {
  if (profileCache.size <= MAX_CACHE_SIZE) return;
  const keys = Array.from(profileCache.keys());
  const toDelete = keys.slice(0, keys.length - MAX_CACHE_SIZE);
  toDelete.forEach((key) => profileCache.delete(key));
}

export function invalidateProfile(userId: string) {
  profileCache.delete(userId);
}

export function clearProfileCache() {
  profileCache.clear();
}

export function useProfiles(userIds: string[], options?: { forceRefresh?: boolean }) {
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const userIdsRef = useRef(userIds);
  userIdsRef.current = userIds;

  const fetchProfiles = useCallback(async (ids: string[], force = false) => {
    if (ids.length === 0) return;

    const uncachedIds = force
      ? ids
      : ids.filter((id) => {
          const entry = profileCache.get(id);
          return !entry || !isCacheValid(entry);
        });

    if (uncachedIds.length === 0) {
      setProfiles((prev) => {
        let changed = false;
        const next = new Map(prev);
        ids.forEach((id) => {
          const entry = profileCache.get(id);
          if (entry) {
            next.set(id, entry.profile);
            if (prev.get(id) !== entry.profile) {
              changed = true;
            }
          }
        });
        return changed ? next : prev;
      });
      return;
    }

    setIsLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .in('id', uncachedIds);

    if (!error && data) {
      setProfiles((prev) => {
        const next = new Map(prev);
        data.forEach((row) => {
          const profile = row as unknown as Profile;
          profileCache.set(profile.id, { profile, fetchedAt: Date.now() });
          next.set(profile.id, profile);
        });
        cleanupCache();
        return next;
      });
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length > 0) {
      fetchProfiles(uniqueIds, options?.forceRefresh);
    }
  }, [userIds, fetchProfiles, options?.forceRefresh]);

  // Realtime: re-fetch when any of our tracked profiles change
  useEffect(() => {
    ensureRealtimeSubscription();

    const handleProfileChange = (changedIds: string[]) => {
      const currentIds = userIdsRef.current;
      const affected = changedIds.filter((id) => currentIds.includes(id));
      if (affected.length > 0) {
        fetchProfiles(affected, true);
      }
    };

    listeners.add(handleProfileChange);
    return () => {
      listeners.delete(handleProfileChange);
      releaseRealtimeSubscription();
    };
  }, [fetchProfiles]);

  return { profiles, isLoading, refresh: () => fetchProfiles([...new Set(userIds.filter(Boolean))], true) };
}

import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getProfile, updateProfile as updateProfileService, checkUsernameAvailable, uploadAvatar } from '@/lib/profile';
import { invalidateProfile } from '@/hooks/useProfiles/useProfiles';
import { supabase } from '@/lib/supabase';
import type { Profile, ProfileUpdate } from '@/types/profile';

interface ProfileContextValue {
  profile: Profile | null;
  isLoading: boolean;
  error: string | null;
  updateProfile: (updates: ProfileUpdate) => Promise<{ error: string | null }>;
  uploadUserAvatar: (file: File) => Promise<{ url: string | null; error: string | null }>;
  checkUsername: (username: string) => Promise<boolean>;
  refreshProfile: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

interface ProfileProviderProps {
  children: ReactNode;
}

export function ProfileProvider({ children }: ProfileProviderProps) {
  const { userId, isAuthenticated } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    if (!userId || !isAuthenticated) {
      setProfile(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const data = await getProfile(userId);
      setProfile(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setIsLoading(false);
    }
  }, [userId, isAuthenticated]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Realtime: listen for changes to current user's profile
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('current-profile-realtime')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as Profile;
          if (updated) {
            setProfile(updated);
            invalidateProfile(userId);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          const inserted = payload.new as Profile;
          if (inserted) {
            setProfile(inserted);
            invalidateProfile(userId);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const updateProfileHandler = useCallback(async (updates: ProfileUpdate) => {
    if (!userId) return { error: 'Not authenticated' };

    try {
      const updated = await updateProfileService(userId, updates);
      setProfile(updated);
      invalidateProfile(userId);
      return { error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update profile';
      return { error: message };
    }
  }, [userId]);

  const uploadUserAvatar = useCallback(async (file: File) => {
    if (!userId) return { url: null, error: 'Not authenticated' };

    try {
      const url = await uploadAvatar(userId, file);
      setProfile((prev) => prev ? { ...prev, avatar_url: url } : null);
      invalidateProfile(userId);
      return { url, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload avatar';
      return { url: null, error: message };
    }
  }, [userId]);

  const checkUsername = useCallback(async (username: string) => {
    if (!userId) return false;
    return checkUsernameAvailable(username, userId);
  }, [userId]);

  const completeOnboarding = useCallback(async () => {
    if (!userId) return;

    try {
      const updated = await updateProfileService(userId, { onboarding_completed: true });
      setProfile(updated);
      invalidateProfile(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete onboarding');
    }
  }, [userId]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      isLoading,
      error,
      updateProfile: updateProfileHandler,
      uploadUserAvatar,
      checkUsername,
      refreshProfile: fetchProfile,
      completeOnboarding,
    }),
    [profile, isLoading, error, updateProfileHandler, uploadUserAvatar, checkUsername, fetchProfile, completeOnboarding]
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfileContext(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error('useProfileContext must be used within a ProfileProvider');
  }
  return context;
}

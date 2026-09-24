import { useProfileContext } from '@/app/providers/ProfileProvider';
import type { Profile, ProfileUpdate } from '@/types/profile';

interface UseProfileReturn {
  profile: Profile | null;
  isLoading: boolean;
  error: string | null;
  updateProfile: (updates: ProfileUpdate) => Promise<{ error: string | null }>;
  uploadAvatar: (file: File) => Promise<{ url: string | null; error: string | null }>;
  checkUsername: (username: string) => Promise<boolean>;
  refreshProfile: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  isOnboardingComplete: boolean;
  displayName: string;
  avatarUrl: string | null;
  username: string | null;
}

export function useProfile(): UseProfileReturn {
  const ctx = useProfileContext();

  return {
    profile: ctx.profile,
    isLoading: ctx.isLoading,
    error: ctx.error,
    updateProfile: ctx.updateProfile,
    uploadAvatar: ctx.uploadUserAvatar,
    checkUsername: ctx.checkUsername,
    refreshProfile: ctx.refreshProfile,
    completeOnboarding: ctx.completeOnboarding,
    isOnboardingComplete: ctx.profile?.onboarding_completed ?? false,
    displayName: ctx.profile?.display_name ?? ctx.profile?.email?.split('@')[0] ?? 'User',
    avatarUrl: ctx.profile?.avatar_url ?? null,
    username: ctx.profile?.username ?? null,
  };
}

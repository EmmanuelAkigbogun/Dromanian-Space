import { useCallback, useMemo } from 'react';
import { useAuthContext } from '@/app/providers/AuthProvider';
import type { AuthState, AuthError, UserRole } from '@/types/auth';

interface UseAuthReturn extends AuthState {
  signUp: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signInWithOAuth: (provider: 'google' | 'github', options?: { redirectTo?: string }) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: AuthError | null }>;
  updateProfile: (data: Record<string, unknown>) => Promise<{ error: AuthError | null }>;
  error: AuthError | null;
  clearError: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
  isUnauthenticated: boolean;
  userId: string | null;
  userRole: UserRole | null;
}

export function useAuth(): UseAuthReturn {
  const auth = useAuthContext();

  const signUp = useCallback(
    async (email: string, password: string) => {
      return auth.signUp({ email, password });
    },
    [auth.signUp]
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      return auth.signIn({ email, password });
    },
    [auth.signIn]
  );

  const resetPassword = useCallback(
    async (email: string) => {
      return auth.resetPassword(email);
    },
    [auth.resetPassword]
  );

  const isLoading = auth.status === 'loading';
  const isAuthenticated = auth.status === 'authenticated';
  const isUnauthenticated = auth.status === 'unauthenticated';
  const userId = auth.user?.id ?? null;

  // Extract role from user metadata, default to 'member'
  const userRole = useMemo<UserRole | null>(() => {
    if (!auth.user) return null;
    const role = auth.user.user_metadata?.role ?? auth.user.app_metadata?.role;
    if (role === 'owner' || role === 'admin' || role === 'member' || role === 'guest') {
      return role;
    }
    return 'member';
  }, [auth.user]);

  return useMemo(
    () => ({
      ...auth,
      signUp,
      signIn,
      signInWithOAuth: auth.signInWithOAuth,
      signOut: auth.signOut,
      resetPassword,
      updateProfile: auth.updateProfile,
      error: auth.error,
      clearError: auth.clearError,
      isLoading,
      isAuthenticated,
      isUnauthenticated,
      userId,
      userRole,
    }),
    [
      auth.status,
      auth.user,
      auth.error,
      auth.signInWithOAuth,
      auth.signOut,
      auth.updateProfile,
      auth.clearError,
      signUp,
      signIn,
      resetPassword,
      isLoading,
      isAuthenticated,
      isUnauthenticated,
      userId,
      userRole,
    ]
  );
}

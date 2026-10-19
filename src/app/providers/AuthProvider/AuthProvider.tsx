import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { clearSignedUrlCache } from '@/lib/message/attachment';
import { platform } from '@/lib/platform';
import type { AuthState, AuthError, SignUpCredentials, SignInCredentials, AuthResponse } from '@/types/auth';

interface AuthContextValue extends AuthState {
  signUp: (credentials: SignUpCredentials) => Promise<AuthResponse>;
  signIn: (credentials: SignInCredentials) => Promise<AuthResponse>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<AuthResponse>;
  updateProfile: (data: Record<string, unknown>) => Promise<AuthResponse>;
  error: AuthError | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const PROFILE_SETUP_FLAG = 'darkspace:pendingProfileSetup';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    session: null,
  });
  const [error, setError] = useState<AuthError | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Handle auth state changes
  useEffect(() => {
    let mounted = true;

    // Get initial session
    platform.auth.getSession().then(({ data: { session }, error: sessionError }) => {
      if (!mounted) return;

      if (sessionError) {
        setError({ message: sessionError.message, code: sessionError.code });
        setState((prev) => ({
          ...prev,
          status: 'unauthenticated',
          user: null,
          session: null,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        status: session ? 'authenticated' : 'unauthenticated',
        user: session?.user ?? null,
        session,
      }));
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = platform.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'SIGNED_OUT') { queryClient.clear(); clearSignedUrlCache(); localStorage.removeItem('dark-space-thread'); void platform.removeAllChannels(); }

      setState((prev) => ({
        ...prev,
        status: session ? 'authenticated' : 'unauthenticated',
        user: session?.user ?? null,
        session,
      }));
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [queryClient]);
  // temporarily block auth
  // setTimeout(() => {
  //   setState({
  //     status: 'authenticated',
  //     user: null,
  //     session: null,
  //   })
  // }, 200);

  const signUp = useCallback(async (credentials: SignUpCredentials): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: signUpError } = await platform.auth.signUp({
        email: credentials.email,
        password: credentials.password,
        options: credentials.options,
      });

      if (signUpError) {
        const authError = { message: signUpError.message, code: signUpError.code };
        setError(authError);
        return { error: authError };
      }

      localStorage.setItem(PROFILE_SETUP_FLAG, '1');
      return { error: null };
    } catch (err) {
      const authError = { message: 'An unexpected error occurred during sign up' };
      setError(authError);
      return { error: authError };
    }
  }, []);

  const signIn = useCallback(async (credentials: SignInCredentials): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: signInError } = await platform.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password,
      });

      if (signInError) {
        const authError = { message: signInError.message, code: signInError.code };
        setError(authError);
        return { error: authError };
      }

      return { error: null };
    } catch (err) {
      const authError = { message: 'An unexpected error occurred during sign in' };
      setError(authError);
      return { error: authError };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      setError(null);
      localStorage.setItem(PROFILE_SETUP_FLAG, '1');
      await platform.auth.signOut();
    } catch (err) {
      setError({ message: 'An unexpected error occurred during sign out' });
    }
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: resetError } = await platform.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });

      if (resetError) {
        const authError = { message: resetError.message, code: resetError.code };
        setError(authError);
        return { error: authError };
      }

      return { error: null };
    } catch (err) {
      const authError = { message: 'An unexpected error occurred during password reset' };
      setError(authError);
      return { error: authError };
    }
  }, []);

  const updateProfile = useCallback(async (data: Record<string, unknown>): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: updateError } = await platform.auth.updateUser({ data });

      if (updateError) {
        const authError = { message: updateError.message, code: updateError.code };
        setError(authError);
        return { error: authError };
      }

      return { error: null };
    } catch (err) {
      const authError = { message: 'An unexpected error occurred during profile update' };
      setError(authError);
      return { error: authError };
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updateProfile,
      error,
      clearError,
    }),
    [state, signUp, signIn, signOut, resetPassword, updateProfile, error, clearError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { supabase } from '@/lib/supabase';
import type { AuthState, AuthError, SignUpCredentials, SignInCredentials, AuthResponse } from '@/types/auth';

interface AuthContextValue extends AuthState {
  signUp: (credentials: SignUpCredentials) => Promise<AuthResponse>;
  signIn: (credentials: SignInCredentials) => Promise<AuthResponse>;
  signInWithOAuth: (provider: 'google' | 'github', options?: { redirectTo?: string }) => Promise<AuthResponse>;
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
    supabase.auth.getSession().then(({ data: { session }, error: sessionError }) => {
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
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

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
  }, [false]);
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
      const { error: signUpError } = await supabase.auth.signUp({
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
      const { error: signInError } = await supabase.auth.signInWithPassword({
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

  const signInWithOAuth = useCallback(async (provider: 'google' | 'github', options?: { redirectTo?: string }): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: options?.redirectTo ?? `${window.location.origin}/auth/callback`,
        },
      });

      if (oauthError) {
        const authError = { message: oauthError.message, code: oauthError.code };
        setError(authError);
        return { error: authError };
      }

      return { error: null };
    } catch (err) {
      const authError = { message: 'An unexpected error occurred during OAuth sign in' };
      setError(authError);
      return { error: authError };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      setError(null);
      localStorage.setItem(PROFILE_SETUP_FLAG, '1');
      await supabase.auth.signOut();
    } catch (err) {
      setError({ message: 'An unexpected error occurred during sign out' });
    }
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<AuthResponse> => {
    try {
      setError(null);
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
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
      const { error: updateError } = await supabase.auth.updateUser({ data });

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
      signInWithOAuth,
      signOut,
      resetPassword,
      updateProfile,
      error,
      clearError,
    }),
    [state, signUp, signIn, signInWithOAuth, signOut, resetPassword, updateProfile, error, clearError]
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

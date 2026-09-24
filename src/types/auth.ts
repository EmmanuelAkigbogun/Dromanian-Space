import type { User, Session } from '@supabase/supabase-js';

export type { User, Session };

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
}

export interface AuthError {
  message: string;
  code?: string;
}

export type UserRole = 'owner' | 'admin' | 'member' | 'guest';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface SignUpCredentials {
  email: string;
  password: string;
  options?: {
    data?: Record<string, unknown>;
  };
}

export interface SignInCredentials {
  email: string;
  password: string;
}

export interface AuthResponse {
  error: AuthError | null;
}

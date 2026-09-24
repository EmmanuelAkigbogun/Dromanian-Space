import type { User } from '@/types';

export interface AuthService {
  signUp: (email: string, password: string) => Promise<{ user: User | null; error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ user: User | null; error: Error | null }>;
  signOut: () => Promise<{ error: Error | null }>;
  getSession: () => Promise<{ user: User | null; error: Error | null }>;
}

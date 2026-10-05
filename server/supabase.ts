import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { dbError, HttpError } from './http.js';

let service: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses RLS, so every query made with it must apply
 * the acting user's access explicitly (the *_for SQL functions do this).
 */
export function serviceClient(): SupabaseClient {
  if (service) return service;
  const { supabaseUrl, supabaseSecretKey } = env();
  if (!supabaseUrl || !supabaseSecretKey) {
    throw new HttpError(503, 'not_configured', 'The server is missing SUPABASE_URL or SUPABASE_SECRET_KEY.');
  }
  service = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return service;
}

export interface AuthUser {
  id: string;
  email: string | null;
}

/** Verifies the caller's Supabase access token (signature, expiry, role). */
export async function authenticate(request: Request): Promise<AuthUser> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
  const { data, error } = await serviceClient().auth.getClaims(match[1]);
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== 'string' || claims.role !== 'authenticated') {
    throw new HttpError(401, 'unauthenticated', 'Your session has expired. Sign in again.');
  }
  return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
}

/** Calls a SQL function with the service client and maps errors. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await serviceClient().rpc(fn, args);
  if (error) throw dbError(error, fn);
  return data as T;
}

export async function requireMember(workspaceId: string, userId: string): Promise<void> {
  const { data, error } = await serviceClient()
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw dbError(error, 'requireMember');
  if (!data) throw new HttpError(403, 'forbidden', 'You are not a member of this workspace.');
}

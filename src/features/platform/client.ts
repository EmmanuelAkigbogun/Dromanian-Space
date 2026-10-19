import { platform as basePlatform } from '@/lib/platform';
import type { PlatformDatabase } from '@/types/platform-database';

// Reuse the authenticated same-origin client; schema row types remain local.
export const platform = basePlatform;
export type Row<K extends keyof PlatformDatabase['public']['Tables']> = PlatformDatabase['public']['Tables'][K]['Row'];
export type RpcRow<K extends keyof PlatformDatabase['public']['Functions']> = PlatformDatabase['public']['Functions'][K]['Returns'] extends (infer R)[] ? R : never;
export async function result(request: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return data;
}
export async function api(path: string, body?: unknown): Promise<Response> {
  const { data: { session } } = await platform.auth.getSession();
  if (!session) throw new Error('Please sign in again.');
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? data?.message ?? `Request failed (${response.status}).`);
  }
  return response;
}
export const errorText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.';
export async function workspacePeople(workspaceId:string) {
  const members=await result(platform.from('workspace_members').select('user_id').eq('workspace_id',workspaceId));
  if(!members.length)return [];
  return result(platform.from('profiles').select('id,display_name,username').in('id',members.map(m=>m.user_id)));
}

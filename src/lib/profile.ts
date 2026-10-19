import { platform } from '@/lib/platform';
import type { ForwardedAttachmentPolicy, Profile, ProfileUpdate } from '@/types/profile';

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await platform
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Profile;
}

export async function getProfilesByUserIds(userIds: string[]): Promise<Profile[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await platform
    .from('profiles')
    .select('*')
    .in('id', userIds);

  if (error || !data) return [];
  return data as Profile[];
}

const SAFE_SEARCH_QUERY = /^[\p{L}\p{N}@._+\- ]*$/u;

export function isSafeSearchQuery(query: string): boolean {
  const q = query.trim();
  return q.length >= 2 && SAFE_SEARCH_QUERY.test(q);
}

export async function searchProfiles(query: string, limit = 8): Promise<Profile[]> {
  const q = query.trim();
  if (!isSafeSearchQuery(q)) return [];
  const { data, error } = await platform
    .from('profiles')
    .select('*')
    .or(`email.ilike.%${q}%,display_name.ilike.%${q}%,username.ilike.%${q}%`)
    .limit(limit);

  if (error || !data) return [];
  return data as Profile[];
}

export async function upsertProfile(userId: string, data: Partial<Profile>): Promise<Profile | null> {
  const { data: existing } = await platform
    .from('profiles' as never)
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (existing) {
    const { data: updated, error } = await platform
      .from('profiles' as never)
      .update(data as never)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return updated as Profile;
  }

  const { data: created, error } = await platform
    .from('profiles' as never)
    .insert({ id: userId, ...data } as never)
    .select()
    .single();

  if (error) throw error;
  return created as Profile;
}

export async function updateProfile(userId: string, updates: ProfileUpdate): Promise<Profile | null> {
  const { data, error } = await platform
    .from('profiles' as never)
    .update(updates as never)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data as Profile;
}

export async function getForwardedAttachmentPolicy(userId: string): Promise<ForwardedAttachmentPolicy> {
  if (!userId) return 'keep';
  const { data } = await platform
    .from('profiles')
    .select('forwarded_attachment_policy')
    .eq('id', userId)
    .maybeSingle();

  const value = (data as { forwarded_attachment_policy?: string } | null)?.forwarded_attachment_policy;
  return value === 'delete' ? 'delete' : 'keep';
}

export async function checkUsernameAvailable(username: string, excludeUserId?: string): Promise<boolean> {
  let query = platform
    .from('profiles')
    .select('id')
    .eq('username', username)
    .limit(1);

  if (excludeUserId) {
    query = query.neq('id', excludeUserId);
  }

  const { data } = await query;
  return !data || data.length === 0;
}

export async function removeAvatar(userId: string): Promise<void> {
  const { data } = await platform.storage.from('avatars').list(`${userId}`);
  if (data && data.length > 0) {
    const paths = data.map((f) => `${userId}/${f.name}`);
    await platform.storage.from('avatars').remove(paths);
  }
}

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  const fileExt = file.name.split('.').pop() || 'png';
  const filePath = `${userId}/avatar-${Date.now()}.${fileExt}`;

  const { error: uploadError } = await platform.storage
    .from('avatars')
    .upload(filePath, file);

  if (uploadError) throw uploadError;

  const { data: urlData } = platform.storage
    .from('avatars')
    .getPublicUrl(filePath);

  return `${urlData.publicUrl}?v=${Date.now()}`;
}

export async function listUserAvatars(userId: string): Promise<string[]> {
  const { data, error } = await platform.storage
    .from('avatars')
    .list(userId, { sortBy: { column: 'created_at', order: 'desc' } });

  if (error || !data) return [];

  return data
    .filter((f) => f.name.startsWith('avatar-'))
    .map((f) => platform.storage.from('avatars').getPublicUrl(`${userId}/${f.name}`).data.publicUrl);
}

export async function deleteAvatar(userId: string, url: string): Promise<void> {
  const clean = url.split('?')[0];
  let path = '';
  try {
    const parsed = new URL(clean);
    const marker = '/avatars/';
    const idx = parsed.pathname.indexOf(marker);
    if (idx !== -1) path = decodeURIComponent(parsed.pathname.slice(idx + marker.length));
  } catch {
    path = clean;
  }

  if (!path) return;
  const { error } = await platform.storage.from('avatars').remove([path]);
  if (error) throw error;
}

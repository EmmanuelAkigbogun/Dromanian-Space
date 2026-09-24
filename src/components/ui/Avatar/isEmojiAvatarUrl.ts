const EMOJI_AVATAR_MAX_LENGTH = 16;

export function isEmojiAvatarUrl(value?: string | null): boolean {
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^(data|blob):/i.test(value)) return false;
  if (value.startsWith('/')) return false;
  if (value.length > EMOJI_AVATAR_MAX_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return true;
  }
  return false;
}

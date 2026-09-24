export type ForwardedAttachmentPolicy = 'keep' | 'delete';

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  avatar_style?: AvatarDisplayStyle | null;
  bio: string | null;
  role: ProfileRole;
  status: ProfileStatus;
  onboarding_completed: boolean;
  timezone: string | null;
  forwarded_attachment_policy?: ForwardedAttachmentPolicy;
  created_at: string;
  updated_at: string;
}

export type ProfileRole = 'owner' | 'admin' | 'member' | 'guest';

export type ProfileStatus = 'online' | 'offline' | 'away' | 'busy';

export type AvatarDisplayStyle = 'frame' | 'circle' | 'polaroid';

export interface ProfileUpdate {
  display_name?: string;
  username?: string;
  avatar_url?: string | null;
  avatar_style?: AvatarDisplayStyle | null;
  bio?: string;
  status?: ProfileStatus;
  timezone?: string;
  onboarding_completed?: boolean;
  forwarded_attachment_policy?: ForwardedAttachmentPolicy;
}

export interface OnboardingData {
  display_name: string;
  username: string;
  avatar_url?: string;
}

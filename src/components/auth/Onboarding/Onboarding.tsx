import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AvatarDisplay } from '@/components/ui/AvatarDisplay';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { deleteAvatar, listUserAvatars } from '@/lib/profile';
import type { AvatarDisplayStyle } from '@/types/profile';
import styles from './Onboarding.module.css';

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const { profile, updateProfile, uploadAvatar, checkUsername } = useProfile();
  const { userId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const avatarEditButtonRef = useRef<HTMLButtonElement>(null);

  const emailPrefix = profile?.email?.split('@')[0] ?? '';
  const [displayName, setDisplayName] = useState(profile?.display_name || emailPrefix);
  const [username, setUsername] = useState(profile?.username || emailPrefix.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30));
  const [avatarPreview, setAvatarPreview] = useState<string | null>(profile?.avatar_url ?? null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarStyle, setAvatarStyle] = useState<AvatarDisplayStyle>(profile?.avatar_style ?? 'polaroid');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ displayName?: string; username?: string; general?: string }>({});
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPosition, setEmojiPosition] = useState({ x: 0, y: 0 });
  const [avatarGallery, setAvatarGallery] = useState<string[]>([]);
  const [selectedGalleryUrls, setSelectedGalleryUrls] = useState<string[]>([]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setErrors((prev) => ({ ...prev, general: 'Avatar must be under 2MB' }));
      return;
    }

    setAvatarFile(file);
    const reader = new FileReader();
    reader.onload = () => setAvatarPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveAvatar = () => {
    setSelectedGalleryUrls([]);
    setAvatarMenuOpen(false);
    setAvatarFile(null);
    setAvatarPreview(null);
  };

  const handleOpenEmojiPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setEmojiPosition({ x: rect.left, y: rect.bottom + 4 });
    setSelectedGalleryUrls([]);
    setAvatarMenuOpen(false);
    setShowEmojiPicker(true);
  };

  const handleEmojiSelect = (emoji: string) => {
    setShowEmojiPicker(false);
    setSelectedGalleryUrls([]);
    setAvatarMenuOpen(false);
    setAvatarFile(null);
    setAvatarPreview(emoji);
  };

  useEffect(() => {
    if (!avatarMenuOpen || !userId) return;
    listUserAvatars(userId)
      .then(setAvatarGallery)
      .catch(() => setAvatarGallery([]));
  }, [avatarMenuOpen, userId]);

  const handleSelectGallery = (url: string) => {
    setSelectedGalleryUrls([]);
    setAvatarMenuOpen(false);
    setAvatarFile(null);
    setAvatarPreview(url);
  };

  const handleDeleteGalleryImages = async (urls: string[]) => {
    const activeUrl = (avatarPreview ?? '').split('?')[0];
    if (urls.some((u) => u.split('?')[0] === activeUrl)) {
      setErrors((prev) => ({ ...prev, general: "You can't delete your current avatar" }));
      return;
    }
    if (!userId) return;
    try {
      for (const url of urls) {
        await deleteAvatar(userId, url);
      }
      setAvatarGallery((prev) => prev.filter((u) => !urls.includes(u)));
      setSelectedGalleryUrls([]);
    } catch {
      setErrors((prev) => ({ ...prev, general: 'Failed to delete photo' }));
    }
  };

  const handleSetAvatarStyle = (style: AvatarDisplayStyle) => {
    setShowEmojiPicker(false);
    setAvatarMenuOpen(false);
    setAvatarStyle(style);
  };

  useEffect(() => {
    if (!avatarMenuOpen && !showEmojiPicker) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (avatarEditButtonRef.current && avatarEditButtonRef.current.contains(target)) return;
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(target)) {
        setAvatarMenuOpen(false);
        setSelectedGalleryUrls([]);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setAvatarMenuOpen(false);
        setShowEmojiPicker(false);
        setSelectedGalleryUrls([]);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [avatarMenuOpen, showEmojiPicker]);

  const handleUsernameChange = async (value: string) => {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    setUsername(sanitized);

    if (sanitized.length < 3) {
      setUsernameStatus('idle');
      return;
    }

    setUsernameStatus('checking');
    const available = await checkUsername(sanitized);
    setUsernameStatus(available ? 'available' : 'taken');
  };

  const validate = (): boolean => {
    const newErrors: { displayName?: string; username?: string } = {};

    if (!displayName.trim()) {
      newErrors.displayName = 'Display name is required';
    } else if (displayName.trim().length < 2) {
      newErrors.displayName = 'Display name must be at least 2 characters';
    }

    if (username && username.length < 3) {
      newErrors.username = 'Username must be at least 3 characters';
    } else if (username && usernameStatus === 'taken') {
      newErrors.username = 'This username is already taken';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (!validate()) return;

    setIsSubmitting(true);

    let avatarUrl = avatarPreview ?? null;

    if (avatarFile) {
      const { url, error: uploadError } = await uploadAvatar(avatarFile);
      if (uploadError) {
        setErrors({ general: 'Failed to upload avatar. Please try again.' });
        setIsSubmitting(false);
        return;
      }
      avatarUrl = url;
    }

    const { error } = await updateProfile({
      display_name: displayName.trim(),
      username: username || undefined,
      avatar_url: avatarUrl,
      avatar_style: avatarStyle,
      onboarding_completed: true,
    });

    setIsSubmitting(false);

    if (error) {
      setErrors({ general: error });
      return;
    }

    onComplete();
  };

  return (
    <div className={styles.onboarding}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>Welcome to Δαρκ space</h1>
          <p className={styles.subtitle}>Set up your profile to get started</p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className={styles.avatarSection}>
            <div className={styles.avatarDisplayArea}>
              <AvatarDisplay
                src={avatarPreview ?? undefined}
                name={displayName || emailPrefix || 'User'}
                size="xl"
                style={avatarStyle}
                caption="hey, it's me!"
                action={
                  <button
                    type="button"
                    className={styles.avatarEditButton}
                    ref={avatarEditButtonRef}
                    onClick={() => {
                      setShowEmojiPicker(false);
                      setSelectedGalleryUrls([]);
                      setAvatarMenuOpen((prev) => !prev);
                    }}
                    aria-label="Edit avatar"
                    aria-expanded={avatarMenuOpen}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                  </button>
                }
              />

              {avatarMenuOpen && (
                <div className={styles.avatarMenu} role="menu" aria-label="Avatar options" ref={avatarMenuRef}>
                  <div className={styles.avatarMenuHeader}>
                    <span className={styles.avatarMenuTitle}>Avatar style</span>
                    <button
                      type="button"
                      className={styles.avatarMenuClose}
                      onClick={() => setAvatarMenuOpen(false)}
                      aria-label="Close avatar menu"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.avatarMenuItem}
                    role="menuitem"
                    onClick={handleRemoveAvatar}
                  >
                    <span className={styles.avatarMenuItemIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </span>
                    <span className={styles.avatarMenuItemText}>
                      <span className={styles.avatarMenuItemLabel}>Initials</span>
                      <span className={styles.avatarMenuItemHint}>Show your monogram</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.avatarMenuItem}
                    role="menuitem"
                    onClick={handleOpenEmojiPicker}
                  >
                    <span className={styles.avatarMenuItemIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </span>
                    <span className={styles.avatarMenuItemText}>
                      <span className={styles.avatarMenuItemLabel}>Emoji</span>
                      <span className={styles.avatarMenuItemHint}>Pick something fun</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.avatarMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setSelectedGalleryUrls([]);
                      setAvatarMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <span className={styles.avatarMenuItemIcon}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="M21 15l-5-5L5 21" />
                      </svg>
                    </span>
                    <span className={styles.avatarMenuItemText}>
                      <span className={styles.avatarMenuItemLabel}>Photo</span>
                      <span className={styles.avatarMenuItemHint}>Upload your own image</span>
                    </span>
                  </button>

                  {avatarGallery.length > 0 && (
                    <>
                      <div className={styles.avatarMenuTitle}>Previous photos</div>
                      <div className={styles.avatarGallery}>
                        {avatarGallery.map((url) => (
                          <button
                            key={url}
                            type="button"
                            className={`${styles.avatarGalleryItem} ${selectedGalleryUrls.includes(url) ? styles.avatarGalleryItemSelected : ''}`}
                            onClick={() =>
                              setSelectedGalleryUrls((prev) =>
                                prev.includes(url)
                                  ? prev.filter((u) => u !== url)
                                  : [...prev, url]
                              )
                            }
                            title="Select photo"
                            aria-pressed={selectedGalleryUrls.includes(url)}
                          >
                            <img src={url} alt="" />
                            {selectedGalleryUrls.includes(url) && (
                              <span className={styles.avatarGalleryCheck} aria-hidden="true">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                      {selectedGalleryUrls.length > 0 && (
                        <div className={styles.avatarGalleryActions}>
                          {selectedGalleryUrls.length === 1 && (
                            <button
                              type="button"
                              className={styles.avatarGalleryActionPrimary}
                              onClick={() => handleSelectGallery(selectedGalleryUrls[0])}
                              title="Use as profile"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                              Use
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.avatarGalleryActionDanger}
                            onClick={() => handleDeleteGalleryImages(selectedGalleryUrls)}
                            title="Delete"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {showEmojiPicker && (
                <EmojiPicker
                  position={emojiPosition}
                  onSelect={handleEmojiSelect}
                  onClose={() => setShowEmojiPicker(false)}
                  showCloseButton
                />
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                className={styles.hiddenInput}
                aria-hidden="true"
              />
            </div>

            <div className={styles.avatarStyleRow} role="radiogroup" aria-label="Avatar display style">
              <button
                type="button"
                role="radio"
                aria-checked={avatarStyle === 'frame'}
                className={`${styles.avatarStyleChip} ${avatarStyle === 'frame' ? styles.avatarStyleChipActive : ''}`}
                onClick={() => handleSetAvatarStyle('frame')}
              >
                <span className={styles.avatarStyleChipIcon} aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <path d="M4 15l4.5-4.5 3.5 3.5 3-3L21 17" />
                    <path d="M14.5 9h.01" />
                  </svg>
                </span>
                Wall frame
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={avatarStyle === 'circle'}
                className={`${styles.avatarStyleChip} ${avatarStyle === 'circle' ? styles.avatarStyleChipActive : ''}`}
                onClick={() => handleSetAvatarStyle('circle')}
              >
                <span className={styles.avatarStyleChipIcon} aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5" />
                  </svg>
                </span>
                Circle
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={avatarStyle === 'polaroid'}
                className={`${styles.avatarStyleChip} ${avatarStyle === 'polaroid' ? styles.avatarStyleChipActive : ''}`}
                onClick={() => handleSetAvatarStyle('polaroid')}
              >
                <span className={styles.avatarStyleChipIcon} aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="14" rx="2" />
                    <path d="M6 21h12" />
                  </svg>
                </span>
                Polaroid
              </button>
            </div>
          </div>

          <div className={styles.fields}>
            <Input
              label="Display name"
              placeholder="How should we call you?"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={errors.displayName}
              autoFocus
              required
            />

            <div>
              <Input
                label="Username"
                placeholder="choose-a-username"
                value={username}
                onChange={(e) => handleUsernameChange(e.target.value)}
                error={errors.username}
              />
              {username.length >= 3 && (
                <p className={`${styles.usernameStatus} ${usernameStatus === 'available' ? styles.available : usernameStatus === 'taken' ? styles.taken : ''}`}>
                  {usernameStatus === 'checking' && 'Checking...'}
                  {usernameStatus === 'available' && 'Username is available'}
                  {usernameStatus === 'taken' && 'Username is already taken'}
                </p>
              )}
            </div>
          </div>

          {errors.general && (
            <div className={styles.error} role="alert">{errors.general}</div>
          )}

          <Button
            type="submit"
            fullWidth
            loading={isSubmitting}
            className={styles.submitButton}
          >
            Continue
          </Button>

          <button
            type="button"
            className={styles.skipButton}
            onClick={onComplete}
          >
            Skip for now
          </button>
        </form>
      </div>
    </div>
  );
}

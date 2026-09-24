import { useState, useCallback, useRef, useEffect, type FormEvent, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Avatar } from '@/components/ui/Avatar';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { createInvitation } from '@/lib/workspace';
import { searchProfiles, isSafeSearchQuery } from '@/lib/profile';
import type { Profile } from '@/types';
import styles from './InviteMemberDialog.module.css';

interface InviteMemberDialogProps {
  open: boolean;
  onClose: () => void;
}

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member — can view and send messages' },
  { value: 'admin', label: 'Admin — can manage members and settings' },
];

export function InviteMemberDialog({ open, onClose }: InviteMemberDialogProps) {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<{ email?: string }>({});

  const [suggestions, setSuggestions] = useState<Profile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionsStyle, setSuggestionsStyle] = useState<{ top: number; left: number; width: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLUListElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTokenRef = useRef(0);

  const resetForm = useCallback(() => {
    setEmail('');
    setRole('member');
    setErrors({});
    setSuggestions([]);
    setShowSuggestions(false);
    setSuggestionsStyle(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTokenRef.current += 1;
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const runSearch = useCallback(async (value: string) => {
    const q = value.trim();
    const token = ++searchTokenRef.current;
    if (!isSafeSearchQuery(q)) {
      setSuggestions([]);
      setShowSuggestions(false);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const results = await searchProfiles(q);
    if (token !== searchTokenRef.current) return;
    setSuggestions(results);
    setShowSuggestions(results.length > 0);
    setIsSearching(false);
    const inputEl = inputRef.current;
    if (inputEl && results.length > 0) {
      const rect = inputEl.getBoundingClientRect();
      setSuggestionsStyle({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  function handleEmailChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setEmail(value);
    if (errors.email) setErrors({});
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => runSearch(value), 250);
  }

  function handleSelectProfile(profile: Profile) {
    setEmail(profile.email || '');
    setSuggestions([]);
    setShowSuggestions(false);
  }

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  useEffect(() => {
    function onPointerDown(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      if (suggestionsRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      setShowSuggestions(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  function validate(): boolean {
    if (!email.trim()) {
      setErrors({ email: 'Email is required' });
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErrors({ email: 'Enter a valid email address' });
      return false;
    }
    setErrors({});
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate() || !currentWorkspace || !userId) return;

    setIsSubmitting(true);
    try {
      const result = await createInvitation(
        currentWorkspace.id,
        email.trim(),
        userId,
        role as 'admin' | 'member',
      );

      if (result.invitation) {
        window.dispatchEvent(new CustomEvent('invitations-updated'));
        if (result.resend) {
          toast({
            variant: 'success',
            title: 'Invitation updated',
            description: `${email.trim()} already had a pending invitation — it has been refreshed.`,
          });
        } else if (result.recipientHasAccount === false) {
          toast({
            variant: 'warning',
            title: 'Invitation sent',
            description: 'No account exists for this email yet — they must sign up with this exact email, then check their invitations.',
          });
        } else {
          toast({
            variant: 'success',
            title: 'Invitation sent',
            description: `Invited ${email.trim()} as ${role}.`,
          });
        }
        handleClose();
      } else {
        toast({ variant: 'error', description: result.error || 'Failed to send invitation.' });
      }
    } catch {
      toast({ variant: 'error', description: 'An unexpected error occurred.' });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Invite member"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isSubmitting} disabled={!email.trim()}>
            Send invitation
          </Button>
        </>
      }
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.emailField}>
          <Input
            ref={inputRef}
            label="Email address"
            required
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={handleEmailChange}
            error={errors.email}
            helperText="Start typing to find someone already on the app, or enter any email."
            autoFocus
          />
          {showSuggestions && suggestionsStyle && suggestions.length > 0 && (
            <ul
              ref={suggestionsRef}
              className={styles.suggestions}
              style={{ top: suggestionsStyle.top, left: suggestionsStyle.left, width: suggestionsStyle.width }}
            >
              {isSearching && <li className={styles.suggestionLoading}>Searching…</li>}
              {suggestions.map((profile) => (
                <li key={profile.id}>
                  <button
                    type="button"
                    className={styles.suggestionItem}
                    onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      handleSelectProfile(profile);
                    }}
                  >
                    <Avatar
                      size="xs"
                      src={profile.avatar_url || undefined}
                      name={profile.display_name || profile.username || profile.email || '?'}
                    />
                    <span className={styles.suggestionText}>
                      <span className={styles.suggestionName}>
                        {profile.display_name || profile.username || 'Unnamed'}
                      </span>
                      <span className={styles.suggestionEmail}>{profile.email}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

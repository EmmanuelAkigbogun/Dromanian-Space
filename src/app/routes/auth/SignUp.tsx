import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { formatAuthError } from '@/lib/auth';
import { AuthLayout, AuthHeader, AuthError, AuthSuccess } from '@/components/auth/AuthLayout';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function SignUp() {
  const { signUp, signInWithOAuth, error: authError, clearError } = useAuth();
  const [searchParams] = useSearchParams();

  const inviteToken = searchParams.get('invite');
  const joinToken = searchParams.get('join');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [validationErrors, setValidationErrors] = useState<{
    email?: string;
    password?: string;
    confirmPassword?: string;
  }>({});

  const formattedError = formatAuthError(authError);

  const validate = (): boolean => {
    const errors: { email?: string; password?: string; confirmPassword?: string } = {};

    if (!email) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Please enter a valid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }

    if (!confirmPassword) {
      errors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    setSuccessMessage('');

    if (!validate()) return;

    setIsSubmitting(true);
    const { error } = await signUp(email, password);
    setIsSubmitting(false);

    if (!error) {
      if (inviteToken) {
        setSuccessMessage('Account created! Redirecting to join workspace...');
        setTimeout(() => {
          window.location.href = `/signin?invite=${inviteToken}`;
        }, 1500);
      } else if (joinToken) {
        setSuccessMessage('Account created! Redirecting to join workspace...');
        setTimeout(() => {
          window.location.href = `/signin?join=${joinToken}`;
        }, 1500);
      } else {
        setSuccessMessage('Check your email for a confirmation link to complete your account.');
      }
    }
  };

  const handleOAuthSignUp = async (provider: 'google' | 'github') => {
    clearError();
    let redirectTo = `${window.location.origin}/auth/callback`;
    if (inviteToken) {
      redirectTo += `?invite=${encodeURIComponent(inviteToken)}`;
    } else if (joinToken) {
      redirectTo += `?join=${encodeURIComponent(joinToken)}`;
    }
    await signInWithOAuth(provider, { redirectTo });
  };

  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Create your account"
          subtitle="Join Δαρκ space"
        />

        {successMessage && <AuthSuccess message={successMessage} />}

        {!successMessage && (
          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formFields}>
              <Input
                label="Email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={validationErrors.email}
                autoComplete="email"
                autoFocus
                required
              />

              <PasswordInput
                label="Password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={validationErrors.password}
                autoComplete="new-password"
                required
              />

              <PasswordInput
                label="Confirm password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                error={validationErrors.confirmPassword}
                autoComplete="new-password"
                required
              />

              {formattedError && <AuthError message={formattedError.message} />}

              <Button
                type="submit"
                fullWidth
                loading={isSubmitting}
                className={styles.submitButton}
              >
                Create account
              </Button>
            </div>
          </form>
        )}

        {!successMessage && (
          <div className={styles.oauthSection}>
            <div className={styles.oauthButtons}>
              <button
                type="button"
                className={styles.oauthButton}
                onClick={() => handleOAuthSignUp('google')}
                disabled={isSubmitting}
              >
                <svg className={styles.oauthIcon} viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Continue with Google
              </button>

              <button
                type="button"
                className={styles.oauthButton}
                onClick={() => handleOAuthSignUp('github')}
                disabled={isSubmitting}
              >
                <svg className={styles.oauthIcon} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                Continue with GitHub
              </button>
            </div>
          </div>
        )}

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
            Already have an account?{' '}
            <Link
              to={
                inviteToken
                  ? `/signin?invite=${inviteToken}`
                  : joinToken
                    ? `/signin?join=${joinToken}`
                    : '/signin'
              }
              style={{
                color: 'var(--color-primary)',
                fontWeight: 'var(--font-weight-medium)',
              }}
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}

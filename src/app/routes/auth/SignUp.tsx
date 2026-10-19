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
  const { signUp, error: authError, clearError } = useAuth();
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
    } else if (!/^[^\s@]+@digitalromanian\.com$/i.test(email.trim())) {
      errors.email = 'Use your @digitalromanian.com email address';
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
    const { error } = await signUp(email.trim().toLowerCase(), password);
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
        setSuccessMessage('Account created. Redirecting to your workspace...');
        setTimeout(() => {
          window.location.href = '/';
        }, 800);
      }
    }
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
                placeholder="you@digitalromanian.com"
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

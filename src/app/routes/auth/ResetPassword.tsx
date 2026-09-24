import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { AuthLayout, AuthHeader, AuthError, AuthSuccess } from '@/components/auth/AuthLayout';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isValidSession, setIsValidSession] = useState<boolean | null>(null);
  const [validationErrors, setValidationErrors] = useState<{
    password?: string;
    confirmPassword?: string;
  }>({});

  // Verify the recovery token on mount
  useEffect(() => {
    const verifyToken = async () => {
      const accessToken = searchParams.get('access_token');
      const refreshToken = searchParams.get('refresh_token');

      if (!accessToken || !refreshToken) {
        setIsValidSession(false);
        return;
      }

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (sessionError) {
        setIsValidSession(false);
        return;
      }

      setIsValidSession(true);
    };

    verifyToken();
  }, [searchParams]);

  const validate = (): boolean => {
    const errors: { password?: string; confirmPassword?: string } = {};

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
    setError('');

    if (!validate()) return;

    setIsSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setIsSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSuccessMessage('Your password has been reset. Redirecting to sign in...');
    setTimeout(() => navigate('/signin', { replace: true }), 3000);
  };

  // Loading state while verifying token
  if (isValidSession === null) {
    return (
      <AuthLayout>
        <div className={styles.signInPage}>
          <AuthHeader title="Verifying link..." subtitle="Please wait while we verify your reset link." />
        </div>
      </AuthLayout>
    );
  }

  // Invalid token state
  if (!isValidSession) {
    return (
      <AuthLayout>
        <div className={styles.signInPage}>
          <AuthHeader title="Invalid link" subtitle="This password reset link is invalid or has expired." />
          <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
            <Button onClick={() => navigate('/forgot-password', { replace: true })} fullWidth>
              Request a new link
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Set new password"
          subtitle="Choose a strong password for your account"
        />

        {successMessage && <AuthSuccess message={successMessage} />}

        {!successMessage && (
          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formFields}>
              <PasswordInput
                label="New password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={validationErrors.password}
                autoComplete="new-password"
                autoFocus
                required
              />

              <PasswordInput
                label="Confirm new password"
                placeholder="Re-enter your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                error={validationErrors.confirmPassword}
                autoComplete="new-password"
                required
              />

              {error && <AuthError message={error} />}

              <Button
                type="submit"
                fullWidth
                loading={isSubmitting}
                className={styles.submitButton}
              >
                Reset password
              </Button>
            </div>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}

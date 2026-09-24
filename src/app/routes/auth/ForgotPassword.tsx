import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { formatAuthError } from '@/lib/auth';
import { AuthLayout, AuthHeader, AuthError, AuthSuccess } from '@/components/auth/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function ForgotPassword() {
  const { resetPassword, error: authError, clearError } = useAuth();

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [validationError, setValidationError] = useState('');

  const formattedError = formatAuthError(authError);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    setSuccessMessage('');
    setValidationError('');

    if (!email) {
      setValidationError('Email is required');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setValidationError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);
    const { error } = await resetPassword(email);
    setIsSubmitting(false);

    if (!error) {
      setSuccessMessage('If an account exists with that email, you will receive a password reset link shortly.');
    }
  };

  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Reset your password"
          subtitle="Enter your email and we'll send you a reset link"
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
                error={validationError}
                autoComplete="email"
                autoFocus
                required
              />

              {formattedError && <AuthError message={formattedError.message} />}

              <Button
                type="submit"
                fullWidth
                loading={isSubmitting}
                className={styles.submitButton}
              >
                Send reset link
              </Button>
            </div>
          </form>
        )}

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
            Remember your password?{' '}
            <Link
              to="/signin"
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

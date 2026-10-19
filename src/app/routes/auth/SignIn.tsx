import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { formatAuthError } from '@/lib/auth';
import { AuthLayout, AuthHeader, AuthError } from '@/components/auth/AuthLayout';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function SignIn() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signIn, error: authError, clearError } = useAuth();

  const inviteToken = searchParams.get('invite');
  const joinToken = searchParams.get('join');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<{
    email?: string;
    password?: string;
  }>({});

  const formattedError = formatAuthError(authError);

  const validate = (): boolean => {
    const errors: { email?: string; password?: string } = {};

    if (!email) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Please enter a valid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validate()) return;

    setIsSubmitting(true);
    const { error } = await signIn(email, password);
    setIsSubmitting(false);

    if (!error) {
      if (inviteToken) {
        navigate(`/invite/${inviteToken}`, { replace: true });
      } else if (joinToken) {
        navigate(`/join/${joinToken}`, { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    }
  };

  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Welcome back"
          subtitle="Sign in to your account"
        />

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
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={validationErrors.password}
              autoComplete="current-password"
              required
            />

            <div className={styles.rememberForgot}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  className={styles.checkboxInput}
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Remember me
              </label>
              <Link to="/forgot-password" className={styles.forgotLink}>
                Forgot password?
              </Link>
            </div>

            {formattedError && <AuthError message={formattedError.message} />}

            <Button
              type="submit"
              fullWidth
              loading={isSubmitting}
              className={styles.submitButton}
            >
              Sign in
            </Button>
          </div>
        </form>

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
            Don't have an account?{' '}
            <Link
              to={
                inviteToken
                  ? `/signup?invite=${inviteToken}`
                  : joinToken
                    ? `/signup?join=${joinToken}`
                    : '/signup'
              }
              style={{
                color: 'var(--color-primary)',
                fontWeight: 'var(--font-weight-medium)',
              }}
            >
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </AuthLayout>
  );
}

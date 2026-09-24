import { Link } from 'react-router-dom';
import { AuthLayout, AuthHeader } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function EmailVerification() {
  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Check your email"
          subtitle="We've sent you a confirmation link. Click it to activate your account."
        />

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
            Didn't receive the email? Check your spam folder, or try signing in — your account may already be confirmed.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <Button onClick={() => window.location.reload()} fullWidth variant="secondary">
              Resend email
            </Button>
            <Link to="/signin" style={{ textDecoration: 'none' }}>
              <Button fullWidth variant="ghost">
                Back to sign in
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </AuthLayout>
  );
}

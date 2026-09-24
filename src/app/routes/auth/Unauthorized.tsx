import { Link } from 'react-router-dom';
import { AuthLayout, AuthHeader } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/Button';
import styles from './SignIn.module.css';

export function Unauthorized() {
  return (
    <AuthLayout>
      <div className={styles.signInPage}>
        <AuthHeader
          title="Access denied"
          subtitle="You don't have permission to view this page."
        />

        <div style={{ marginTop: 'var(--space-6)', textAlign: 'center' }}>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
            If you believe this is a mistake, please contact your workspace administrator.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <Link to="/" style={{ textDecoration: 'none' }}>
              <Button fullWidth>
                Go to home
              </Button>
            </Link>
            <Link to="/signin" style={{ textDecoration: 'none' }}>
              <Button fullWidth variant="secondary">
                Sign in as different user
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </AuthLayout>
  );
}

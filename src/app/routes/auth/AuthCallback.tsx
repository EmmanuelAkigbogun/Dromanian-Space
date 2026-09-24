import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout, AuthHeader } from '@/components/auth/AuthLayout';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { PROFILE_SETUP_FLAG } from '@/app/providers/AuthProvider/AuthProvider';
import styles from './AuthCallback.module.css';

export function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isLoading, isAuthenticated, userId } = useAuth();
  const handledRef = useRef(false);

  const inviteToken = searchParams.get('invite');
  const joinToken = searchParams.get('join');

  useEffect(() => {
    if (isLoading || handledRef.current) return;
    handledRef.current = true;

    if (!isAuthenticated) {
      navigate('/signin', { replace: true });
      return;
    }

    const finish = async () => {
      if (userId) {
        try {
          const { data } = await supabase
            .from('profiles')
            .select('username')
            .eq('id', userId)
            .maybeSingle();
          if (!data || !data.username) {
            localStorage.setItem(PROFILE_SETUP_FLAG, '1');
          }
        } catch {
          // Ignore profile lookup failures and continue signing in.
        }
      }

      if (inviteToken) {
        navigate(`/invite/${inviteToken}`, { replace: true });
      } else if (joinToken) {
        navigate(`/join/${joinToken}`, { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    };

    void finish();
  }, [isLoading, isAuthenticated, userId, inviteToken, joinToken, navigate]);

  return (
    <AuthLayout>
      <AuthHeader title="Signing you in" subtitle="Completing your sign in..." />
      <div className={styles.centered}>
        <Spinner size="md" />
        <p className={styles.loadingText}>You'll be redirected in a moment.</p>
      </div>
    </AuthLayout>
  );
}

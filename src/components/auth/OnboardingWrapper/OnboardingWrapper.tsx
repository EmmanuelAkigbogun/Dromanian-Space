import { useState, useEffect, useCallback } from 'react';
import { useProfileContext } from '@/app/providers/ProfileProvider';
import { useAuth } from '@/hooks/useAuth';
import { PROFILE_SETUP_FLAG } from '@/app/providers/AuthProvider/AuthProvider';
import { Onboarding } from '@/components/auth/Onboarding';
import { Spinner } from '@/components/ui/Spinner';

interface OnboardingWrapperProps {
  children: React.ReactNode;
}

export function OnboardingWrapper({ children }: OnboardingWrapperProps) {
  const { profile, isLoading, completeOnboarding } = useProfileContext();
  const { isAuthenticated } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    if (isAuthenticated && profile && !isLoading && localStorage.getItem(PROFILE_SETUP_FLAG) === '1') {
      setShowOnboarding(true);
    }
  }, [isAuthenticated, profile, isLoading]);

  const handleComplete = useCallback(async () => {
    localStorage.removeItem(PROFILE_SETUP_FLAG);
    setShowOnboarding(false);
    await completeOnboarding();
  }, [completeOnboarding]);

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if (showOnboarding) {
    return <Onboarding onComplete={handleComplete} />;
  }

  return <>{children}</>;
}

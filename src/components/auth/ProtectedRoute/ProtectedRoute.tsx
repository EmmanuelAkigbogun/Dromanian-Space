import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Spinner } from '@/components/ui/Spinner';
import type { UserRole } from '@/types/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: UserRole;
  fallback?: string;
}

export function ProtectedRoute({ children, requiredRole, fallback = '/signin' }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, userRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate(fallback, { state: { from: location }, replace: true });
    }
  }, [isLoading, isAuthenticated, navigate, fallback, location]);

  useEffect(() => {
    if (!isLoading && isAuthenticated && requiredRole && userRole) {
      const roleHierarchy: Record<UserRole, number> = {
        owner: 4,
        admin: 3,
        member: 2,
        guest: 1,
      };
      if (roleHierarchy[userRole] < roleHierarchy[requiredRole]) {
        navigate('/unauthorized', { replace: true });
      }
    }
  }, [isLoading, isAuthenticated, requiredRole, userRole, navigate]);

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

  if (!isAuthenticated) {
    return null;
  }

  if (requiredRole && userRole) {
    const roleHierarchy: Record<UserRole, number> = {
      owner: 4,
      admin: 3,
      member: 2,
      guest: 1,
    };
    if (roleHierarchy[userRole] < roleHierarchy[requiredRole]) {
      return null;
    }
  }

  return <>{children}</>;
}

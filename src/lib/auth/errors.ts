import type { AuthError } from '@/types/auth';

export interface FormattedAuthError {
  message: string;
  field?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  'Invalid login credentials': 'Invalid email or password. Please try again.',
  'Email not confirmed': 'Please check your email and confirm your account before signing in.',
  'User already registered': 'An account with this email already exists.',
  'Password should be at least 6 characters': 'Password must be at least 6 characters long.',
  'Unable to validate email address: invalid format': 'Please enter a valid email address.',
  'Email rate limit exceeded': 'Too many attempts. Please try again later.',
  'Password rate limit exceeded': 'Too many attempts. Please try again later.',
};

export function formatAuthError(error: AuthError | null): FormattedAuthError | null {
  if (!error) return null;

  const message = ERROR_MESSAGES[error.message] ?? error.message;

  return {
    message,
    field: error.code === 'invalid_credentials' ? 'email' : undefined,
  };
}

export function isAuthErrorCode(error: AuthError | null, code: string): boolean {
  return error?.code === code;
}

export function getAuthErrorMessage(error: AuthError | null): string {
  if (!error) return '';
  return ERROR_MESSAGES[error.message] ?? 'An unexpected error occurred. Please try again.';
}

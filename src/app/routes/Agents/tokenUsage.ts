export type TokenUsageTone = 'normal' | 'warning' | 'exceeded';

export interface TokenUsagePresentation {
  used: number;
  limit: number | null;
  percentage: number | null;
  visualPercentage: number | null;
  tone: TokenUsageTone;
}

function safeTokenCount(value: number | null | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

/**
 * Produces progress data only when the workspace has a real positive limit.
 * An unlimited account deliberately has no synthetic percentage or maximum.
 */
export function tokenUsagePresentation(usedValue: number, limitValue: number | null): TokenUsagePresentation {
  const used = safeTokenCount(usedValue);
  const candidateLimit = safeTokenCount(limitValue);
  const limit = candidateLimit > 0 ? candidateLimit : null;
  if (limit === null) return { used, limit, percentage: null, visualPercentage: null, tone: 'normal' };

  const percentage = (used / limit) * 100;
  return {
    used,
    limit,
    percentage,
    visualPercentage: Math.min(100, percentage),
    tone: percentage >= 100 ? 'exceeded' : percentage >= 80 ? 'warning' : 'normal',
  };
}

/** Converts an optional administrator input to a real integer limit or null. */
export function parseTokenLimit(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) throw new Error('Token limits must be positive whole numbers.');
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Token limits must be positive whole numbers.');
  return parsed;
}

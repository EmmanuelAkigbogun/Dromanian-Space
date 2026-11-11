const MAX_PREFILLED_BRIEF = 3_500;

/** Bound and normalize a URL-provided composer draft. It is never auto-sent. */
export function prefilledAgentBrief(value: string | null): string {
  return (value ?? '').trim().slice(0, MAX_PREFILLED_BRIEF);
}

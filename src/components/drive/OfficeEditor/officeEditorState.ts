export type OfficeEditorPhase =
  | 'configuring'
  | 'loading'
  | 'opening'
  | 'ready'
  | 'saving'
  | 'closing'
  | 'failed';

export type OfficeEditorCapability = 'edit' | 'fill' | 'view';

export function officeEditorStatus(phase: OfficeEditorPhase, capability: OfficeEditorCapability | null): string {
  switch (phase) {
    case 'configuring':
      return 'Preparing secure editor…';
    case 'loading':
      return 'Loading document editor…';
    case 'opening':
      return 'Opening document…';
    case 'saving':
      return capability === 'fill' ? 'Saving completed PDF as a new version…' : 'Saving changes…';
    case 'closing':
      return 'Closing editor…';
    case 'failed':
      return 'Editor unavailable';
    case 'ready':
      if (capability === 'fill') return 'Fill PDF form · changes save as new versions';
      return capability === 'edit' ? 'Editing · changes save automatically' : 'View only';
  }
}

export function officeEditorError(event: unknown): string {
  const data = event && typeof event === 'object' && 'data' in event
    ? (event as { data?: unknown }).data
    : null;
  const details = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const description = typeof details?.errorDescription === 'string'
    ? details.errorDescription.trim()
    : '';
  const code = typeof details?.errorCode === 'number' || typeof details?.errorCode === 'string'
    ? String(details.errorCode)
    : '';

  if (description && code) return `${description} (error ${code}).`;
  if (description) return description.endsWith('.') ? description : `${description}.`;
  if (code) return `The document editor reported error ${code}.`;
  return 'The document editor could not open this file.';
}

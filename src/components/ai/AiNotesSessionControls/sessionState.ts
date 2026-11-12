export type AiNotesRunStatus = 'reserving' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;

const IN_FLIGHT_STATUSES = new Set<AiNotesRunStatus>(['reserving', 'queued', 'running']);
const RETRYABLE_STATUSES = new Set<AiNotesRunStatus>(['failed', 'cancelled', 'interrupted']);

export function isAiNotesRunInFlight(status: AiNotesRunStatus): boolean {
  return IN_FLIGHT_STATUSES.has(status);
}

export function isAiNotesRunRetryable(status: AiNotesRunStatus): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export interface JobRow {
  id: string;
  kind: string;
  workspace_id: string | null;
  principal_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
}

export interface JobContext {
  worker: string;
  /** Aborted when the lease is lost or the invocation is about to time out. */
  signal: AbortSignal;
  isLastAttempt: boolean;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<Record<string, unknown> | null>;

/** A failure that retrying cannot fix (bad input, missing object). */
export class PermanentJobError extends Error {}

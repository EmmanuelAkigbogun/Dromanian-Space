import { describe, expect, it } from 'vitest';
import {
  isAiNotesRunInFlight,
  isAiNotesRunRetryable,
  type AiNotesRunStatus,
} from '../../src/components/ai/AiNotesSessionControls/sessionState.js';

describe('AI notes session status', () => {
  it.each<AiNotesRunStatus>(['reserving', 'queued', 'running'])('treats %s as in flight', (status) => {
    expect(isAiNotesRunInFlight(status)).toBe(true);
    expect(isAiNotesRunRetryable(status)).toBe(false);
  });

  it.each<AiNotesRunStatus>(['failed', 'cancelled', 'interrupted'])('offers retry only after %s', (status) => {
    expect(isAiNotesRunInFlight(status)).toBe(false);
    expect(isAiNotesRunRetryable(status)).toBe(true);
  });

  it.each<AiNotesRunStatus>([null, 'completed'])('does not mislabel %s as active or retryable', (status) => {
    expect(isAiNotesRunInFlight(status)).toBe(false);
    expect(isAiNotesRunRetryable(status)).toBe(false);
  });
});

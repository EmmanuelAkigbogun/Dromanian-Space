import { describe, expect, it } from 'vitest';
import { withReplyCount } from '../../src/app/providers/ThreadProvider/threadCounts.js';

describe('thread reply counts', () => {
  it('preserves the map identity when a fetched count is unchanged', () => {
    const counts = new Map([['message-1', 3]]);

    expect(withReplyCount(counts, 'message-1', 3)).toBe(counts);
  });

  it('returns an updated map without mutating the previous state', () => {
    const counts = new Map([['message-1', 3]]);
    const updated = withReplyCount(counts, 'message-1', 4);

    expect(updated).not.toBe(counts);
    expect(updated.get('message-1')).toBe(4);
    expect(counts.get('message-1')).toBe(3);
  });
});

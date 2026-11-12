import { describe, expect, it } from 'vitest';
import { getFirstMessageUrl } from '../../src/lib/message/richText.js';

describe('message copy-link visibility', () => {
  it('returns no copyable link for messages without an embedded URL', () => {
    expect(getFirstMessageUrl('No link in this message.')).toBeNull();
  });

  it('returns the first embedded URL and removes trailing punctuation', () => {
    expect(getFirstMessageUrl('See https://first.example/path, then https://second.example.')).toBe(
      'https://first.example/path',
    );
  });
});

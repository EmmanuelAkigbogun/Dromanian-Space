import { describe, expect, it } from 'vitest';
import { composeSocialPostText } from '../../src/lib/socialPost.js';

describe('social post publishing text', () => {
  it('publishes the reviewed caption, CTA and hashtags', () => {
    expect(composeSocialPostText('A new launch.', 'Book a demo', ['launch', '#Romania'])).toBe(
      'A new launch.\n\nBook a demo\n\n#launch #Romania',
    );
  });

  it('does not duplicate CTA or hashtags already written in the caption', () => {
    expect(composeSocialPostText('Book a demo today. #Launch', 'Book a demo', ['launch', 'B2B'])).toBe(
      'Book a demo today. #Launch\n\n#B2B',
    );
  });
});

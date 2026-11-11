import { describe, expect, it } from 'vitest';
import { MESSAGE_REACTIONS } from '../../src/components/message/ReactionPicker/reactions.js';
import { groupReactions } from '../../src/lib/message/reactionGroups.js';

describe('message reactions', () => {
  it('offers a short, conventional reaction set without duplicates', () => {
    expect(MESSAGE_REACTIONS).toEqual([
      { emoji: '👍', label: 'Like' },
      { emoji: '❤️', label: 'Love' },
      { emoji: '😂', label: 'Laugh' },
      { emoji: '🎉', label: 'Celebrate' },
      { emoji: '👀', label: 'Looking' },
      { emoji: '🙏', label: 'Thanks' },
    ]);
    expect(new Set(MESSAGE_REACTIONS.map(({ emoji }) => emoji)).size).toBe(MESSAGE_REACTIONS.length);
  });

  it('continues to group and identify arbitrary stored legacy reactions', () => {
    const reactions = [
      { id: '1', message_id: 'message', user_id: 'viewer', emoji: '👽', created_at: '2026-11-11T00:00:00Z' },
      { id: '2', message_id: 'message', user_id: 'other', emoji: '👽', created_at: '2026-11-11T00:00:00Z' },
      { id: '3', message_id: 'message', user_id: 'other', emoji: '🍁', created_at: '2026-11-11T00:00:00Z' },
    ];

    expect(groupReactions(reactions, 'viewer')).toEqual([
      { emoji: '👽', count: 2, userIds: ['viewer', 'other'], hasOwn: true },
      { emoji: '🍁', count: 1, userIds: ['other'], hasOwn: false },
    ]);
  });
});

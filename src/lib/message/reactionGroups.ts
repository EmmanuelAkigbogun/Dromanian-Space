interface ReactionRecord {
  emoji: string;
  user_id: string;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  userIds: string[];
  hasOwn: boolean;
}

/** Groups every stored emoji without restricting it to the current picker. */
export function groupReactions(
  reactions: readonly ReactionRecord[],
  currentUserId: string,
): ReactionGroup[] {
  const map = new Map<string, ReactionGroup>();

  reactions.forEach((reaction) => {
    const existing = map.get(reaction.emoji);
    if (existing) {
      if (!existing.userIds.includes(reaction.user_id)) {
        existing.userIds.push(reaction.user_id);
        existing.count++;
      }
      if (reaction.user_id === currentUserId) existing.hasOwn = true;
    } else {
      map.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        userIds: [reaction.user_id],
        hasOwn: reaction.user_id === currentUserId,
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

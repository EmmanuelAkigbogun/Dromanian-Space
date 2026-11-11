import { describe, expect, it } from 'vitest';
import {
  getNotificationPresentation,
  groupNotifications,
  notificationGroupMatches,
  summarizeNotificationGroups,
  type NotificationCategory,
  type NotificationEntityType,
  type PresentableNotification,
} from '../../src/features/notifications/presentation.js';

function notification(overrides: Partial<PresentableNotification> & { id: string }): PresentableNotification {
  return {
    user_id: 'user-1',
    type: 'system',
    title: 'Workspace update',
    message: 'A routine update is available.',
    read: false,
    link: '/activity',
    created_at: '2026-11-11T10:00:00.000Z',
    category: 'workspace',
    entity_type: 'workspace',
    entity_id: null,
    actor_id: null,
    workspace_id: 'workspace-1',
    ...overrides,
  };
}

describe('notification presentation', () => {
  it.each([
    ['invitation', 'Workspace invitation', 'You were invited to join', 'Review invitation'],
    ['task_approval', 'Approval requested', 'A draft is ready for approval', 'Review request'],
    ['system', 'Access request', 'A teammate requested permission', 'Review access'],
    ['system', 'Publishing failed', 'The provider returned an error', 'Resolve issue'],
    ['system', 'Task overdue', 'The due date has passed', 'Open overdue item'],
  ] as Array<[string, string, string, string]>) (
    'classifies %s notifications as requiring action',
    (type, title, message, actionLabel) => {
      const result = getNotificationPresentation(notification({ id: type, type, title, message }));
      expect(result).toMatchObject({
        priority: 'action',
        priorityLabel: 'Action required',
        actionLabel,
      });
    },
  );

  it.each([
    ['mention', 'You were mentioned', 'Please review this', 'messaging', 'message'],
    ['task_assigned', 'Task assigned', 'A task was assigned to you', 'tasks', 'task'],
    ['system', 'Event starts soon', 'The meeting starts in 10 minutes', 'calendar', 'event'],
  ] as Array<[string, string, string, NotificationCategory, NotificationEntityType]>) (
    'classifies %s notifications as important',
    (type, title, message, category, entityType) => {
      const result = getNotificationPresentation(notification({
        id: type,
        type,
        title,
        message,
        category,
        entity_type: entityType,
      }));
      expect(result.priority).toBe('important');
      expect(result.priorityLabel).toBe('Important');
    },
  );

  it('keeps routine messages and system updates normal and never invents a CTA without a link', () => {
    const message = getNotificationPresentation(notification({
      id: 'message',
      type: 'message',
      category: 'messaging',
      entity_type: 'message',
      link: null,
    }));
    const system = getNotificationPresentation(notification({ id: 'system', link: null }));

    expect(message).toMatchObject({ priority: 'normal', actionLabel: null });
    expect(system).toMatchObject({ priority: 'normal', actionLabel: null });
  });

  it('groups repeated updates for the same entity while preserving each backing notification', () => {
    const notifications = [
      notification({
        id: 'latest',
        title: 'Task updated',
        category: 'tasks',
        entity_type: 'task',
        entity_id: 'task-1',
      }),
      notification({
        id: 'overdue',
        title: 'Task overdue',
        category: 'tasks',
        entity_type: 'task',
        entity_id: 'task-1',
        read: true,
      }),
      notification({
        id: 'other-task',
        title: 'Task updated',
        category: 'tasks',
        entity_type: 'task',
        entity_id: 'task-2',
      }),
    ];

    const groups = groupNotifications(notifications);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      primary: { id: 'latest' },
      count: 2,
      unreadCount: 1,
      presentation: { priority: 'action', priorityLabel: 'Action required' },
    });
    expect(groups[0].items.map(({ id }) => id)).toEqual(['latest', 'overdue']);
  });

  it('filters grouped entities and reports useful grouped counts', () => {
    const groups = groupNotifications([
      notification({ id: 'approval', type: 'task_approval', category: 'tasks', entity_type: 'task', entity_id: 'task-1' }),
      notification({ id: 'approval-old', type: 'task_approval', category: 'tasks', entity_type: 'task', entity_id: 'task-1', read: true }),
      notification({ id: 'mention', type: 'mention', category: 'messaging', entity_type: 'message', entity_id: 'message-1' }),
      notification({ id: 'routine', read: true }),
    ]);
    const summary = summarizeNotificationGroups(groups);

    expect(summary).toMatchObject({ total: 3, unread: 2, action: 1, actionUnread: 1, important: 1 });
    expect(summary.categories.tasks).toBe(1);
    expect(summary.categories.messaging).toBe(1);
    expect(groups.filter((group) => notificationGroupMatches(group, 'action'))).toHaveLength(1);
    expect(groups.filter((group) => notificationGroupMatches(group, 'unread', 'messaging'))).toHaveLength(1);
  });
});

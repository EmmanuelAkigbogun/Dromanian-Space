export type NotificationPriority = 'action' | 'important' | 'normal';
export type NotificationFilter = 'action' | 'unread' | 'all';
export type NotificationCategory = 'messaging' | 'workspace' | 'channels' | 'projects' | 'tasks' | 'calendar';
export type NotificationEntityType = 'message' | 'channel' | 'workspace' | 'user' | 'file' | 'invitation' | 'project' | 'task' | 'event';

export interface PresentableNotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  link: string | null;
  created_at: string;
  category: NotificationCategory | null;
  entity_type: NotificationEntityType | null;
  entity_id: string | null;
  actor_id: string | null;
  workspace_id: string | null;
}

export interface NotificationPresentation {
  priority: NotificationPriority;
  priorityLabel: 'Action required' | 'Important' | null;
  actionLabel: string | null;
  category: NotificationCategory;
  categoryLabel: string;
}

export interface NotificationGroup {
  key: string;
  primary: PresentableNotification;
  items: PresentableNotification[];
  count: number;
  unreadCount: number;
  presentation: NotificationPresentation;
}

export interface NotificationSummary {
  total: number;
  unread: number;
  action: number;
  actionUnread: number;
  important: number;
  categories: Record<NotificationCategory, number>;
}

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  messaging: 'Messaging',
  workspace: 'Workspace',
  channels: 'Channels',
  projects: 'Projects',
  tasks: 'Tasks',
  calendar: 'Calendar',
};

export const NOTIFICATION_CATEGORIES = Object.keys(
  NOTIFICATION_CATEGORY_LABELS,
) as NotificationCategory[];

const ACTION_PATTERN = /\b(approval|approve|access request|permission request|invitation|invited|failed|failure|error|unable|cannot|could not|rejected|blocked|overdue|past due|incoming (?:voice |video )?call)\b/i;
const IMPORTANT_PATTERN = /\b(mentioned|mention|assigned|assignment|due soon|starts? (?:soon|in)|upcoming|announcement)\b/i;
const APPROVAL_PATTERN = /\b(approval|approve|review request)\b/i;
const ACCESS_PATTERN = /\b(access request|permission request)\b/i;
const FAILURE_PATTERN = /\b(failed|failure|error|unable|cannot|could not|rejected|blocked)\b/i;
const OVERDUE_PATTERN = /\b(overdue|past due)\b/i;
const CALL_PATTERN = /\bincoming (?:voice |video )?call\b/i;

const PRIORITY_WEIGHT: Record<NotificationPriority, number> = {
  normal: 0,
  important: 1,
  action: 2,
};

export function normalizeNotificationCategory(notification: PresentableNotification): NotificationCategory {
  if (notification.category && NOTIFICATION_CATEGORIES.includes(notification.category)) {
    return notification.category;
  }

  if (notification.entity_type === 'event') return 'calendar';
  if (notification.entity_type === 'task') return 'tasks';
  if (notification.entity_type === 'project') return 'projects';
  if (notification.entity_type === 'channel') return 'channels';
  if (notification.type === 'mention' || notification.type === 'message') return 'messaging';
  return 'workspace';
}

export function getNotificationPresentation(notification: PresentableNotification): NotificationPresentation {
  const category = normalizeNotificationCategory(notification);
  const text = `${notification.title} ${notification.message}`;
  const requiresAction = notification.type === 'invitation'
    || notification.type === 'task_approval'
    || ACTION_PATTERN.test(text);
  const isImportant = notification.type === 'mention'
    || notification.type === 'task_assigned'
    || notification.type === 'announcement'
    || category === 'calendar'
    || IMPORTANT_PATTERN.test(text);
  const priority: NotificationPriority = requiresAction
    ? 'action'
    : isImportant
      ? 'important'
      : 'normal';

  let actionLabel: string | null = null;
  if (notification.link) {
    if (notification.type === 'invitation' || /\b(invitation|invited)\b/i.test(text)) {
      actionLabel = 'Review invitation';
    } else if (notification.type === 'task_approval' || APPROVAL_PATTERN.test(text)) {
      actionLabel = 'Review request';
    } else if (ACCESS_PATTERN.test(text)) {
      actionLabel = 'Review access';
    } else if (FAILURE_PATTERN.test(text)) {
      actionLabel = 'Resolve issue';
    } else if (OVERDUE_PATTERN.test(text)) {
      actionLabel = 'Open overdue item';
    } else if (CALL_PATTERN.test(text)) {
      actionLabel = 'Open call';
    } else if (notification.type === 'mention') {
      actionLabel = 'View mention';
    } else if (notification.type === 'task_assigned' || /\b(assigned|assignment)\b/i.test(text)) {
      actionLabel = 'Open assignment';
    } else if (category === 'calendar') {
      actionLabel = 'View event';
    } else if (notification.entity_type === 'task') {
      actionLabel = 'Open task';
    } else if (notification.entity_type === 'file') {
      actionLabel = 'Open file';
    } else if (category === 'messaging') {
      actionLabel = 'Open conversation';
    } else {
      actionLabel = 'Open';
    }
  }

  return {
    priority,
    priorityLabel: priority === 'action' ? 'Action required' : priority === 'important' ? 'Important' : null,
    actionLabel,
    category,
    categoryLabel: NOTIFICATION_CATEGORY_LABELS[category],
  };
}

function notificationGroupKey(notification: PresentableNotification): string {
  const type = notification.type || 'system';
  if (notification.entity_id) {
    return `${type}:${notification.entity_type || 'entity'}:${notification.entity_id}`;
  }

  if (notification.link) {
    return `${type}:link:${notification.link}:${notification.title.trim().toLocaleLowerCase()}`;
  }

  return `notification:${notification.id}`;
}

export function groupNotifications(notifications: PresentableNotification[]): NotificationGroup[] {
  const grouped = new Map<string, PresentableNotification[]>();

  for (const notification of notifications) {
    const key = notificationGroupKey(notification);
    const existing = grouped.get(key);
    if (existing) existing.push(notification);
    else grouped.set(key, [notification]);
  }

  return Array.from(grouped, ([key, items]) => {
    const presentations = items.map(getNotificationPresentation);
    const strongest = presentations.reduce((current, candidate) => (
      PRIORITY_WEIGHT[candidate.priority] > PRIORITY_WEIGHT[current.priority] ? candidate : current
    ));
    const primaryPresentation = presentations[0];

    return {
      key,
      primary: items[0],
      items,
      count: items.length,
      unreadCount: items.reduce((count, item) => count + (item.read ? 0 : 1), 0),
      presentation: {
        ...primaryPresentation,
        priority: strongest.priority,
        priorityLabel: strongest.priorityLabel,
      },
    };
  });
}

export function notificationGroupMatches(
  group: NotificationGroup,
  filter: NotificationFilter,
  category: NotificationCategory | 'all' = 'all',
): boolean {
  if (category !== 'all' && group.presentation.category !== category) return false;
  if (filter === 'action') return group.presentation.priority === 'action';
  if (filter === 'unread') return group.unreadCount > 0;
  return true;
}

export function summarizeNotificationGroups(groups: NotificationGroup[]): NotificationSummary {
  const categories: Record<NotificationCategory, number> = {
    messaging: 0,
    workspace: 0,
    channels: 0,
    projects: 0,
    tasks: 0,
    calendar: 0,
  };

  let unread = 0;
  let action = 0;
  let actionUnread = 0;
  let important = 0;

  for (const group of groups) {
    categories[group.presentation.category] += 1;
    if (group.unreadCount > 0) unread += 1;
    if (group.presentation.priority === 'action') {
      action += 1;
      if (group.unreadCount > 0) actionUnread += 1;
    } else if (group.presentation.priority === 'important') {
      important += 1;
    }
  }

  return { total: groups.length, unread, action, actionUnread, important, categories };
}

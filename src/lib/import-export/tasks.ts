import { TASK_STATUS_OPTIONS } from '@/types/task';

export interface ParsedTaskRow {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  due_date?: string;
  start_date?: string;
  project_name?: string;
  assignee_emails: string[];
}

export interface RawTaskRow {
  [key: string]: unknown;
}

const STATUS_ALIASES: Record<string, string> = {
  backlog: 'backlog',
  todo: 'todo',
  'to do': 'todo',
  'to-do': 'todo',
  in_progress: 'in_progress',
  'in progress': 'in_progress',
  'in-progress': 'in_progress',
  review: 'review',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  closed: 'cancelled',
};

const PRIORITY_ALIASES: Record<string, string> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  normal: 'medium',
  high: 'high',
  important: 'high',
  urgent: 'urgent',
  critical: 'urgent',
  highest: 'urgent',
};

const VALID_PRIORITIES = new Set(['none', 'low', 'medium', 'high', 'urgent']);

export function toOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

export function normalizeStatus(value: unknown): string | undefined {
  const s = toOptionalString(value);
  if (!s) return undefined;
  const key = s.toLowerCase();
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  if (TASK_STATUS_OPTIONS.some((o) => o.value === s)) return s;
  return undefined;
}

export function normalizePriority(value: unknown): string | undefined {
  const s = toOptionalString(value);
  if (!s) return undefined;
  const key = s.toLowerCase();
  if (PRIORITY_ALIASES[key]) return PRIORITY_ALIASES[key];
  if (VALID_PRIORITIES.has(s)) return s;
  return undefined;
}

function toEmailSet(value: unknown): string[] {
  const out = new Set<string>();
  if (typeof value === 'string' && value.trim()) {
    value.split(/[;,|\n]+/).forEach((e) => {
      const t = e.trim();
      if (t) out.add(t.toLowerCase());
    });
  } else if (Array.isArray(value)) {
    value.forEach((item) => {
      if (typeof item === 'string' && item.trim()) {
        out.add(item.trim().toLowerCase());
      } else if (
        item &&
        typeof item === 'object' &&
        typeof (item as { email?: unknown }).email === 'string' &&
        String((item as { email: unknown }).email).trim()
      ) {
        out.add(String((item as { email: unknown }).email).trim().toLowerCase());
      }
    });
  }
  return [...out];
}

export function normalizeTaskRow(
  row: RawTaskRow,
): { task: ParsedTaskRow; warning?: string } {
  const title = toOptionalString(row.title);
  if (!title) {
    return { task: { title: '', assignee_emails: [] }, warning: 'Skipped a task row without a title.' };
  }

  const emails = new Set<string>();
  toEmailSet(row.assignee_email).forEach((e) => emails.add(e));
  toEmailSet(row.assignee_emails).forEach((e) => emails.add(e));
  toEmailSet(row.assignees).forEach((e) => emails.add(e));

  const status = normalizeStatus(row.status);
  if (row.status !== undefined && row.status !== null && row.status !== '' && !status) {
    return {
      task: {
        title,
        description: toOptionalString(row.description),
        priority: normalizePriority(row.priority),
        status: undefined,
        due_date: toOptionalString(row.due_date),
        start_date: toOptionalString(row.start_date),
        project_name: toOptionalString(row.project_name ?? row.project),
        assignee_emails: [...emails],
      },
      warning: `Status "${String(row.status)}" is not a standard status and was left as To Do for "${title}".`,
    };
  }

  const priority = normalizePriority(row.priority);
  if (row.priority !== undefined && row.priority !== null && row.priority !== '' && !priority) {
    return {
      task: {
        title,
        description: toOptionalString(row.description),
        priority: undefined,
        status,
        due_date: toOptionalString(row.due_date),
        start_date: toOptionalString(row.start_date),
        project_name: toOptionalString(row.project_name ?? row.project),
        assignee_emails: [...emails],
      },
      warning: `Priority "${String(row.priority)}" is not recognized and was set to None for "${title}".`,
    };
  }

  return {
    task: {
      title,
      description: toOptionalString(row.description),
      priority,
      status,
      due_date: toOptionalString(row.due_date),
      start_date: toOptionalString(row.start_date),
      project_name: toOptionalString(row.project_name ?? row.project),
      assignee_emails: [...emails],
    },
  };
}

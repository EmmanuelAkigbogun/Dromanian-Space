import { supabase } from '@/lib/supabase';
import type { AutomationRule, AutomationTrigger, AutomationCondition, AutomationAction, UUID } from '@/types';

export const AUTOMATION_EXPORT_FORMAT = 'automation-export';
export const AUTOMATION_EXPORT_VERSION = 1;

export interface AutomationExportItem {
  name: string;
  description: string | null;
  enabled: boolean;
  triggers: Array<{ event_type: string; config?: Record<string, unknown> }>;
  conditions: Array<{ field: string; operator: string; value: string; logic?: string }>;
  actions: Array<{ action_type: string; config: Record<string, unknown>; position: number }>;
}

export interface AutomationsExportDocument {
  format: string;
  version: number;
  exported_at: string;
  automations: AutomationExportItem[];
}

export interface AutomationImportContext {
  memberIdByEmail: Map<string, string>;
  memberIds: Set<string>;
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(config));
  } catch {
    return { ...config };
  }
}

export function isAutomationsExportDocument(data: unknown): data is AutomationsExportDocument {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).format === 'string' &&
    (data as Record<string, unknown>).format !== '' &&
    Array.isArray((data as Record<string, unknown>).automations)
  );
}

export function isAutomationItem(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as Record<string, unknown>).name === 'string' &&
    ((item as Record<string, unknown>).triggers !== undefined ||
      (item as Record<string, unknown>).actions !== undefined)
  );
}

// Builds the export document for a set of automation rules. The document is
// tagged with the workspace name instead of an app brand, so it reads as the
// workspace's own export. Member references in action configs (assignees,
// reminder targets) are enriched with the member's email so the same people
// can be matched again when the rules are imported into another workspace;
// everything else is carried over verbatim.
export async function buildAutomationsExport(
  rules: AutomationRule[],
  workspaceName?: string,
): Promise<AutomationsExportDocument> {
  const automations: AutomationExportItem[] = rules.map((rule) => ({
    name: rule.name,
    description: rule.description ?? null,
    enabled: rule.enabled,
    triggers: (rule.triggers ?? []).map((t) => ({
      event_type: t.event_type,
      ...(t.config && Object.keys(t.config).length > 0 ? { config: t.config } : {}),
    })),
    conditions: (rule.conditions ?? []).map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value ?? '',
      ...(c.logic ? { logic: c.logic } : {}),
    })),
    actions: (rule.actions ?? []).map((a) => ({
      action_type: a.action_type,
      config: cloneConfig(a.config ?? {}),
      position: a.position ?? 0,
    })),
  }));

  const memberIds = new Set<string>();
  for (const item of automations) {
    for (const action of item.actions) {
      const cfg = action.config;
      if (cfg.assignee === 'specific_user') {
        if (Array.isArray(cfg.assignee_ids)) {
          cfg.assignee_ids.forEach((id) => {
            if (typeof id === 'string' && id) memberIds.add(id);
          });
        } else if (typeof cfg.assignee_id === 'string' && cfg.assignee_id) {
          memberIds.add(cfg.assignee_id);
        }
      }
      if (
        action.action_type === 'send_reminder' &&
        cfg.target_type === 'user' &&
        typeof cfg.target_id === 'string' &&
        cfg.target_id
      ) {
        memberIds.add(cfg.target_id);
      }
    }
  }

  if (memberIds.size > 0) {
    const { data } = await supabase
      .from('profiles' as never)
      .select('id, email')
      .in('id', [...memberIds]);
    const emailById = new Map<string, string>();
    for (const p of (data ?? []) as Array<{ id: string; email: string | null }>) {
      if (p.email) emailById.set(p.id, p.email);
    }

    for (const item of automations) {
      for (const action of item.actions) {
        const cfg = action.config;
        if (cfg.assignee === 'specific_user') {
          const uuids: string[] = Array.isArray(cfg.assignee_ids)
            ? cfg.assignee_ids.filter((id): id is string => typeof id === 'string' && !!id)
            : typeof cfg.assignee_id === 'string' && cfg.assignee_id
              ? [cfg.assignee_id]
              : [];
          const emails = uuids.map((id) => emailById.get(id)).filter((e): e is string => !!e);
          if (emails.length > 0) cfg.assignee_emails = emails;
        }
        if (
          action.action_type === 'send_reminder' &&
          cfg.target_type === 'user' &&
          typeof cfg.target_id === 'string'
        ) {
          const email = emailById.get(cfg.target_id);
          if (email) cfg.target_email = email;
        }
      }
    }
  }

  return {
    format: workspaceName?.trim() || AUTOMATION_EXPORT_FORMAT,
    version: AUTOMATION_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    automations,
  };
}

// Prepares exported rules for the current workspace. General references
// (trigger creator, all members, task creator, statuses, text fields) are kept
// as-is. References that are exclusive to the source workspace are adapted:
// members are matched by email (or id) and dropped with a warning when they are
// not members here; channels/DM groups and specific tasks fall back to a
// generic behavior so the rule stays functional.
export function sanitizeAutomationItems(
  items: AutomationExportItem[],
  ctx: AutomationImportContext,
): { items: AutomationExportItem[]; warnings: string[] } {
  const warnings: string[] = [];

  const out = items.map((item) => {
    const name = item.name || 'Untitled rule';
    const actions = (item.actions ?? []).map((action) => {
      const config = cloneConfig(action.config ?? {});
      const warns: string[] = [];

      switch (action.action_type) {
        case 'create_task':
        case 'assign_task': {
          if (config.assignee === 'specific_user') {
            const emails = Array.isArray(config.assignee_emails) ? config.assignee_emails : [];
            const uuids = Array.isArray(config.assignee_ids) ? config.assignee_ids : [];
            const single = typeof config.assignee_id === 'string' ? config.assignee_id : '';

            const resolved: string[] = [];
            const unmatched: string[] = [];
            const seen = new Set<string>();
            for (const e of emails) {
              const id = typeof e === 'string' ? ctx.memberIdByEmail.get(e.trim().toLowerCase()) : undefined;
              if (id) {
                if (!seen.has(id)) {
                  seen.add(id);
                  resolved.push(id);
                }
              } else if (typeof e === 'string' && e.trim()) {
                unmatched.push(e.trim());
              }
            }
            for (const u of uuids) {
              if (typeof u === 'string' && ctx.memberIds.has(u) && !seen.has(u)) {
                seen.add(u);
                resolved.push(u);
              }
            }
            if (single && ctx.memberIds.has(single) && !seen.has(single)) resolved.push(single);

            if (resolved.length > 0) {
              config.assignee_ids = resolved;
              config.assignee_id = '';
              delete config.assignee_emails;
            } else {
              if (action.action_type === 'create_task') {
                config.assignee = 'none';
                warns.push(
                  `"${name}" (create task): no assigned member is in this workspace, so the task will not be assigned.`,
                );
              } else {
                config.assignee = 'trigger_creator';
                warns.push(
                  `"${name}" (assign task): no assigned member is in this workspace, so the task will be assigned to the trigger creator instead.`,
                );
              }
              delete config.assignee_ids;
              delete config.assignee_id;
              delete config.assignee_emails;
            }
          } else {
            delete config.assignee_ids;
            delete config.assignee_id;
            delete config.assignee_emails;
          }

          if (config.task_id) {
            delete config.task_id;
            warns.push(
              `"${name}" (${action.action_type}): the referenced task belongs to the source workspace and was removed; the action will apply to the triggering task instead.`,
            );
          }
          break;
        }

        case 'update_status': {
          if (config.task_id) {
            delete config.task_id;
            warns.push(
              `"${name}" (update status): the referenced task belongs to the source workspace and was removed; the status will update the triggering task instead.`,
            );
          }
          break;
        }

        case 'post_message':
        case 'schedule_message': {
          const channel = config.channel;
          if (channel && channel !== '__trigger_creator__') {
            config.channel = '__trigger_creator__';
            warns.push(
              `"${name}" (${action.action_type}): the target channel belongs to the source workspace; the message will be sent to the trigger creator instead.`,
            );
          }
          break;
        }

        case 'send_reminder': {
          const targetType = String(config.target_type || '');
          if (targetType === 'user') {
            const email = typeof config.target_email === 'string' ? config.target_email : '';
            const targetId = typeof config.target_id === 'string' ? config.target_id : '';
            let id = email ? ctx.memberIdByEmail.get(email.trim().toLowerCase()) : undefined;
            if (!id && targetId && ctx.memberIds.has(targetId)) id = targetId;
            if (id) {
              config.target_id = id;
              delete config.target_email;
            } else {
              config.target_type = 'self';
              delete config.target_id;
              delete config.target_email;
              warns.push(
                `"${name}" (send reminder): the assigned member is not in this workspace, so the reminder will go to the rule creator instead.`,
              );
            }
          } else if (targetType === 'channel' || targetType === 'dm') {
            config.target_type = 'self';
            delete config.target_id;
            warns.push(
              `"${name}" (send reminder): the ${targetType === 'dm' ? 'DM group' : 'channel'} belongs to the source workspace, so the reminder will go to the rule creator instead.`,
            );
          } else {
            delete config.target_id;
            delete config.target_email;
          }
          break;
        }

        default:
          break;
      }

      if (warns.length > 0) warnings.push(...warns);
      return { ...action, config };
    });

    return { ...item, actions };
  });

  return { items: out, warnings };
}

// Converts an export item into the shape createRule expects. Imported rules
// are always created disabled so they can be reviewed before being enabled.
export function toRuleDraft(
  item: AutomationExportItem,
  workspaceId: UUID,
): Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'> {
  const triggers: AutomationTrigger[] = (item.triggers ?? []).map((t) => ({
    event_type: t.event_type,
    ...(t.config ? { config: t.config } : {}),
  }));
  const conditions: AutomationCondition[] = (item.conditions ?? []).map((c) => ({
    field: c.field,
    operator: c.operator as AutomationCondition['operator'],
    value: c.value ?? '',
    ...(c.logic ? { logic: c.logic as 'and' | 'or' } : {}),
  }));
  const actions: AutomationAction[] = (item.actions ?? []).map((a) => ({
    action_type: a.action_type,
    config: cloneConfig(a.config ?? {}),
    position: a.position ?? 0,
  }));
  return {
    workspace_id: workspaceId,
    name: item.name,
    description: item.description ?? null,
    enabled: false,
    triggers,
    conditions,
    actions,
  };
}

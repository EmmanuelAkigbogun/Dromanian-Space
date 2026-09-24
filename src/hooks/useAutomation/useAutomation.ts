import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { deleteAutomationAttachmentFiles } from '@/lib/message/attachment';
import { useAuth } from '@/hooks/useAuth';
import { useWorkspace } from '@/hooks/useWorkspace';
import type { AutomationRule, AutomationExecutionLog, AutomationTrigger, AutomationCondition, AutomationAction, AutomationVisibility, AutomationEditRequest, UUID } from '@/types';
type ConditionOperator = AutomationCondition['operator'];

// useAutomation is used by the automation settings page. After any rule
// mutation we broadcast an event so every instance refetches immediately
// instead of waiting for a page reload.
const RULES_CHANGED_EVENT = 'automation-rules-changed';
function notifyRulesChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
  }
}

// Module-level singleton realtime subscription for edit requests so multiple
// useAutomation instances share a single channel. RLS scopes the events to
// requests the current user can see (own requests + requests on their rules).
type EditRequestRealtimeListener = () => void;
const editRequestRealtimeListeners = new Set<EditRequestRealtimeListener>();
let editRequestRealtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let editRequestRealtimeCount = 0;

function acquireEditRequestRealtime() {
  editRequestRealtimeCount += 1;
  if (editRequestRealtimeChannel) return;
  editRequestRealtimeChannel = supabase
    .channel('automation-edit-requests-realtime')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'automation_edit_requests' },
      () => {
        editRequestRealtimeListeners.forEach((fn) => fn());
      },
    )
    .subscribe();
}

function releaseEditRequestRealtime() {
  editRequestRealtimeCount = Math.max(0, editRequestRealtimeCount - 1);
  if (editRequestRealtimeCount === 0 && editRequestRealtimeChannel) {
    supabase.removeChannel(editRequestRealtimeChannel);
    editRequestRealtimeChannel = null;
  }
}

interface UseAutomationReturn {
  rules: AutomationRule[];
  isLoading: boolean;
  createRule: (rule: Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'>) => Promise<AutomationRule | null>;
  updateRule: (id: string, updates: Partial<AutomationRule>) => Promise<boolean>;
  duplicateRule: (rule: AutomationRule) => Promise<AutomationRule | null>;
  toggleRule: (id: string, enabled: boolean) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  getExecutionLogs: (ruleId?: string) => Promise<AutomationExecutionLog[]>;
  deleteExecutionLog: (logId: string) => Promise<boolean>;
  refetch: () => Promise<void>;
  visibility: AutomationVisibility;
  visibleMembers: UUID[];
  setVisibility: (visibility: AutomationVisibility, visibleMembers?: UUID[]) => Promise<boolean>;
  editorRuleIds: Set<string>;
  editRequests: AutomationEditRequest[];
  requestEditAccess: (ruleId: string) => Promise<boolean>;
  respondToEditRequest: (requestId: string, accept: boolean) => Promise<boolean>;
  cancelEditRequest: (requestId: string) => Promise<boolean>;
  revokeEditAccess: (ruleId: string, userId: string) => Promise<boolean>;
}

interface TriggerRow { event_type: string; }
interface ConditionRow { field: string; operator: string; value: string; logic: string; }
interface ActionRow { action_type: string; config: Record<string, unknown>; sort_order: number; }
interface RuleRow {
  id: UUID; workspace_id: UUID; created_by: UUID; name: string; description: string | null;
  enabled: boolean; created_at: string; updated_at: string;
  automation_triggers: TriggerRow[] | null;
  automation_conditions: ConditionRow[] | null;
  automation_actions: ActionRow[] | null;
}

function mapRule(row: RuleRow): AutomationRule {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    created_by: row.created_by,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    last_executed_at: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    triggers: (row.automation_triggers ?? []).map((t) => ({ event_type: t.event_type })),
    conditions: (row.automation_conditions ?? []).map((c) => ({
      field: c.field, operator: c.operator as ConditionOperator, value: c.value, logic: c.logic as 'and' | 'or',
    })),
    actions: (row.automation_actions ?? []).map((a) => ({
      action_type: a.action_type, config: a.config, position: a.sort_order,
    })),
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, delayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export function useAutomation(): UseAutomationReturn {
  const { userId } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [visibility, setVisibilityState] = useState<AutomationVisibility>('own');
  const [visibleMembers, setVisibleMembers] = useState<UUID[]>([]);
  const [editorRuleIds, setEditorRuleIds] = useState<Set<string>>(new Set());
  const [editRequests, setEditRequests] = useState<AutomationEditRequest[]>([]);

  const fetchVisibility = useCallback(async () => {
    if (!currentWorkspace?.id || !userId) return;
    const { data, error } = await supabase.rpc('get_automation_visibility' as never, {
      p_workspace_id: currentWorkspace.id,
    } as never);
    if (error || !data) return;
    const result = data as { success: boolean; visibility: AutomationVisibility; visible_members: UUID[] };
    if (result.success) {
      setVisibilityState(result.visibility);
      setVisibleMembers(result.visible_members ?? []);
    }
  }, [currentWorkspace?.id, userId]);

  const fetchEditAccess = useCallback(async () => {
    if (!currentWorkspace?.id || !userId) return;
    const { data, error } = await supabase.rpc('get_my_automation_edit_access' as never, {
      p_workspace_id: currentWorkspace.id,
    } as never);
    if (error || !data) return;
    setEditorRuleIds(new Set((data as { rule_id: UUID }[]).map((r) => String(r.rule_id))));
  }, [currentWorkspace?.id, userId]);

  const fetchEditRequests = useCallback(async () => {
    if (!currentWorkspace?.id || !userId) return;
    const { data, error } = await supabase.rpc('get_automation_edit_requests' as never, {
      p_workspace_id: currentWorkspace.id,
    } as never);
    if (error || !data) return;
    setEditRequests((data as unknown as AutomationEditRequest[]));
  }, [currentWorkspace?.id, userId]);

  useEffect(() => {
    fetchVisibility();
    fetchEditAccess();
    fetchEditRequests();
  }, [fetchVisibility, fetchEditAccess, fetchEditRequests]);

  const fetchRules = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    setIsLoading(true);
    const { data, error } = await supabase
      .from('automation_rules' as never)
      .select('*, automation_triggers(event_type), automation_conditions(field, operator, value, logic), automation_actions(action_type, config, sort_order)')
      .eq('workspace_id', currentWorkspace.id)
      .order('created_at', { ascending: false });
    if (!error && data) setRules((data as unknown as RuleRow[]).map(mapRule));
    setIsLoading(false);
  }, [currentWorkspace?.id]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    const onRulesChanged = () => {
      fetchRules();
      fetchEditAccess();
      fetchEditRequests();
    };
    window.addEventListener(RULES_CHANGED_EVENT, onRulesChanged);
    return () => window.removeEventListener(RULES_CHANGED_EVENT, onRulesChanged);
  }, [fetchRules, fetchEditAccess, fetchEditRequests]);

  useEffect(() => {
    if (!currentWorkspace?.id || !userId) return;
    acquireEditRequestRealtime();
    const listener: EditRequestRealtimeListener = () => {
      fetchEditRequests();
      fetchEditAccess();
    };
    editRequestRealtimeListeners.add(listener);
    return () => {
      editRequestRealtimeListeners.delete(listener);
      releaseEditRequestRealtime();
    };
  }, [currentWorkspace?.id, userId, fetchEditRequests, fetchEditAccess]);

  const refetch = useCallback(async () => {
    await fetchRules();
    await fetchEditAccess();
    await fetchEditRequests();
  }, [fetchRules, fetchEditAccess, fetchEditRequests]);

  const setVisibility = useCallback(
    async (nextVisibility: AutomationVisibility, nextVisibleMembers?: UUID[]) => {
      if (!currentWorkspace?.id) return false;
      const { data, error } = await supabase.rpc('set_automation_visibility' as never, {
        p_workspace_id: currentWorkspace.id,
        p_visibility: nextVisibility,
        p_visible_members: nextVisibleMembers && nextVisibleMembers.length > 0 ? nextVisibleMembers : null,
      } as never);
      if (error || !data) return false;
      const result = data as { success: boolean };
      if (!result.success) return false;
      setVisibilityState(nextVisibility);
      setVisibleMembers(nextVisibleMembers ?? []);
      await fetchRules();
      return true;
    },
    [currentWorkspace?.id, fetchRules],
  );

  const requestEditAccess = useCallback(
    async (ruleId: string) => {
      if (!currentWorkspace?.id || !userId) return false;
      const { data, error } = await supabase.rpc('request_automation_edit' as never, {
        p_rule_id: ruleId,
      } as never);
      if (error || !data) return false;
      const result = data as { success: boolean };
      if (!result.success) return false;
      await fetchEditRequests();
      return true;
    },
    [currentWorkspace?.id, userId, fetchEditRequests],
  );

  const respondToEditRequest = useCallback(
    async (requestId: string, accept: boolean) => {
      if (!currentWorkspace?.id) return false;
      const { data, error } = await supabase.rpc('respond_automation_edit_request' as never, {
        p_request_id: requestId,
        p_accept: accept,
      } as never);
      if (error || !data) return false;
      const result = data as { success: boolean };
      if (!result.success) return false;
      await fetchEditRequests();
      await fetchEditAccess();
      await fetchRules();
      return true;
    },
    [currentWorkspace?.id, fetchEditRequests, fetchEditAccess, fetchRules],
  );

  const revokeEditAccess = useCallback(
    async (ruleId: string, userIdToRevoke: string) => {
      if (!currentWorkspace?.id) return false;
      const { data, error } = await supabase.rpc('revoke_automation_editor' as never, {
        p_rule_id: ruleId,
        p_user_id: userIdToRevoke,
      } as never);
      if (error || !data) return false;
      const result = data as { success: boolean };
      if (!result.success) return false;
      await fetchEditRequests();
      await fetchEditAccess();
      return true;
    },
    [currentWorkspace?.id, fetchEditRequests, fetchEditAccess],
  );

  const cancelEditRequest = useCallback(
    async (requestId: string) => {
      if (!currentWorkspace?.id) return false;
      const { data, error } = await supabase.rpc('cancel_automation_edit_request' as never, {
        p_request_id: requestId,
      } as never);
      if (error || !data) return false;
      const result = data as { success: boolean };
      if (!result.success) return false;
      await fetchEditRequests();
      return true;
    },
    [currentWorkspace?.id, fetchEditRequests],
  );

  const createRule = useCallback(
    async (ruleData: Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'>) => {
      if (!currentWorkspace?.id || !userId) return null;

      try {
        const { data: ruleId, error: ruleError } = await withRetry(async () => {
          return supabase.rpc('create_automation_rule' as any, {
            p_workspace_id: currentWorkspace.id,
            p_name: ruleData.name,
            p_description: ruleData.description || null,
            p_enabled: ruleData.enabled ?? true,
            p_triggers: (ruleData.triggers || []).map((t) => ({ event_type: t.event_type })),
            p_conditions: (ruleData.conditions || []).map((c, i) => ({
              field: c.field,
              operator: c.operator,
              value: c.value || '',
              logic: c.logic || (i > 0 ? 'and' : 'and'),
            })),
            p_actions: (ruleData.actions || []).map((a, i) => ({
              action_type: a.action_type,
              config: a.config || {},
              sort_order: a.position ?? i,
            })),
          });
        });

        if (ruleError || !ruleId) {
          console.error('Failed to create automation rule:', ruleError);
          return null;
        }

        const created: AutomationRule = {
          id: ruleId,
          workspace_id: currentWorkspace.id,
          created_by: userId,
          name: ruleData.name,
          description: ruleData.description,
          triggers: ruleData.triggers || [],
          conditions: ruleData.conditions || [],
          actions: ruleData.actions || [],
          enabled: ruleData.enabled ?? true,
          last_executed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await fetchRules();
        notifyRulesChanged();
        return created;
      } catch (err) {
        console.error('Failed to create automation rule:', err);
        await fetchRules();
        notifyRulesChanged();
        return null;
      }
    },
    [currentWorkspace?.id, userId, fetchRules, rules]
  );

  const updateRule = useCallback(async (id: string, updates: Partial<AutomationRule>) => {
    try {
      const ruleUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (updates.name !== undefined) ruleUpdate.name = updates.name;
      if (updates.description !== undefined) ruleUpdate.description = updates.description || null;
      if (updates.enabled !== undefined) ruleUpdate.enabled = updates.enabled;

      await withRetry(async () => {
        const { error } = await supabase
          .from('automation_rules' as never)
          .update(ruleUpdate as never)
          .eq('id', id);
        if (error) throw error;
      });

      if (updates.triggers !== undefined) {
        await withRetry(async () => {
          const { error } = await supabase.from('automation_triggers' as never).delete().eq('rule_id', id);
          if (error) throw error;
        });
        if (updates.triggers!.length > 0) {
          const triggers = updates.triggers!.map((t) => ({ rule_id: id, event_type: t.event_type }));
          await withRetry(async () => {
            const { error } = await supabase.from('automation_triggers' as never).insert(triggers as never);
            if (error) throw error;
          });
        }
      }

      if (updates.conditions !== undefined) {
        await withRetry(async () => {
          const { error } = await supabase.from('automation_conditions' as never).delete().eq('rule_id', id);
          if (error) throw error;
        });
        if (updates.conditions!.length > 0) {
          const conditions = updates.conditions!.map((c, i) => ({
            rule_id: id,
            field: c.field,
            operator: c.operator,
            value: c.value || '',
            logic: c.logic || 'and',
          }));
          await withRetry(async () => {
            const { error } = await supabase.from('automation_conditions' as never).insert(conditions as never);
            if (error) throw error;
          });
        }
      }

      if (updates.actions !== undefined) {
        await withRetry(async () => {
          const { error } = await supabase.from('automation_actions' as never).delete().eq('rule_id', id);
          if (error) throw error;
        });
        if (updates.actions!.length > 0) {
          const actions = updates.actions!.map((a, i) => ({
            rule_id: id,
            action_type: a.action_type,
            config: a.config || {},
            sort_order: a.position ?? i,
          }));
          await withRetry(async () => {
            const { error } = await supabase.from('automation_actions' as never).insert(actions as never);
            if (error) throw error;
          });
        }
      }

      await fetchRules();
      notifyRulesChanged();
      return true;
    } catch (err) {
      console.error('Failed to update automation rule:', err);
      await fetchRules();
      notifyRulesChanged();
      return false;
    }
  }, [fetchRules]);

  const toggleRule = useCallback(async (id: string, enabled: boolean) => {
    return updateRule(id, { enabled });
  }, [updateRule]);

  const duplicateRule = useCallback(
    async (rule: AutomationRule): Promise<AutomationRule | null> => {
      const data: Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'> = {
        workspace_id: rule.workspace_id,
        name: `${rule.name} (copy)`,
        description: rule.description,
        enabled: false,
        triggers: rule.triggers || [],
        conditions: rule.conditions || [],
        actions: rule.actions || [],
      };
      return createRule(data);
    },
    [createRule],
  );

  const deleteRule = useCallback(async (id: string) => {
    try {
      // Collect the rule's attachment files first so they can be removed from
      // storage only when the rule itself is deleted. Automation files are
      // never touched by message deletes/forwards.
      let attachmentUrls: string[] = [];
      await withRetry(async () => {
        const { data, error } = await supabase
          .from('automation_actions' as never)
          .select('config')
          .eq('rule_id', id);
        if (error) throw error;
        (data as { config: Record<string, unknown> }[] | null)?.forEach((row) => {
          const attachments = Array.isArray(row.config?.attachments) ? row.config.attachments : [];
          (attachments as { file_url?: unknown }[]).forEach((att) => {
            if (typeof att.file_url === 'string' && att.file_url) attachmentUrls.push(att.file_url);
          });
        });
      });
      await withRetry(async () => {
        const { error } = await supabase.from('automation_rules' as never).delete().eq('id', id);
        if (error) throw error;
      });
      if (attachmentUrls.length > 0) {
        deleteAutomationAttachmentFiles(attachmentUrls).catch((err) =>
          console.error('Failed to delete automation attachment files:', err),
        );
      }
      await fetchRules();
      notifyRulesChanged();
      return true;
    } catch (err) {
      console.error('Failed to delete automation rule:', err);
      await fetchRules();
      notifyRulesChanged();
      return false;
    }
  }, [fetchRules]);

  const getExecutionLogs = useCallback(async (ruleId?: string) => {
    if (!currentWorkspace?.id) return [];
    const { data, error } = await supabase.rpc('get_execution_logs' as any, {
      p_workspace_id: currentWorkspace.id,
      p_rule_id: ruleId || null,
    });
    if (error || !data) return [];
    return data as unknown as AutomationExecutionLog[];
  }, [currentWorkspace?.id]);

  const deleteExecutionLog = useCallback(async (logId: string) => {
    try {
      await withRetry(async () => {
        const { error } = await supabase.from('automation_execution_logs' as never).delete().eq('id', logId);
        if (error) throw error;
      });
      return true;
    } catch (err) {
      console.error('Failed to delete execution log:', err);
      return false;
    }
  }, []);

  return {
    rules,
    isLoading,
    createRule,
    updateRule,
    duplicateRule,
    toggleRule,
    deleteRule,
    getExecutionLogs,
    deleteExecutionLog,
    refetch,
    visibility,
    visibleMembers,
    setVisibility,
    editorRuleIds,
    editRequests,
    requestEditAccess,
    respondToEditRequest,
    cancelEditRequest,
    revokeEditAccess,
  };
}

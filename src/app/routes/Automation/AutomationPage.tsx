import { useState, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs/Tabs';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog/ConfirmDialog';
import { AutomationRuleCard } from '@/components/automation/AutomationRuleCard/AutomationRuleCard';
import { AutomationRuleDialog } from '@/components/automation/AutomationRuleDialog/AutomationRuleDialog';
import { ExecutionLog } from '@/components/automation/ExecutionLog/ExecutionLog';
import { ExportAutomationsDialog } from '@/components/automation/ExportAutomationsDialog/ExportAutomationsDialog';
import { AutomationVisibilityDialog } from '@/components/automation/AutomationVisibilityDialog/AutomationVisibilityDialog';
import { AutomationEditRequestsDialog } from '@/components/automation/AutomationEditRequestsDialog/AutomationEditRequestsDialog';
import { useAutomation } from '@/hooks/useAutomation';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/Toast';
import { downloadJson, exportFileName, logDataExport } from '@/lib/workspace/export';
import { buildAutomationsExport } from '@/lib/import-export/automations';
import type { AutomationRule } from '@/types';
import styles from './AutomationPage.module.css';

export function AutomationPage() {
  const {
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
  } = useAutomation();

  const { userId } = useAuth();
  const [showDialog, setShowDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showVisibility, setShowVisibility] = useState(false);
  const [showEditRequests, setShowEditRequests] = useState(false);
  const { currentWorkspace, isAdmin } = useWorkspace();
  const { toast } = useToast();

  const pendingIncoming = editRequests.filter(
    (r) => r.status === 'pending' && r.requester_id !== userId,
  ).length;

  const handleExportOne = useCallback(
    async (rule: AutomationRule) => {
      if (!currentWorkspace) return;
      try {
        const data = await buildAutomationsExport([rule], currentWorkspace.name);
        downloadJson(exportFileName(currentWorkspace, 'automations'), data);
        logDataExport(currentWorkspace.id, 'automations', currentWorkspace.id).catch(() => {});
        toast({
          variant: 'success',
          title: 'Export ready',
          description: `Rule "${rule.name}" exported.`,
        });
      } catch {
        toast({ variant: 'error', description: 'Failed to export automation rule.' });
      }
    },
    [currentWorkspace, toast],
  );

  const handleCreate = useCallback(() => {
    setEditingRule(null);
    setShowDialog(true);
  }, []);

  const handleEdit = useCallback((rule: AutomationRule) => {
    setEditingRule(rule);
    setShowDialog(true);
  }, []);

  const handleDelete = useCallback((id: string) => {
    setDeletingRuleId(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (deletingRuleId) {
      await deleteRule(deletingRuleId);
      setDeletingRuleId(null);
    }
  }, [deletingRuleId, deleteRule]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    await toggleRule(id, enabled);
  }, [toggleRule]);

  const handleDuplicate = useCallback(async (rule: AutomationRule) => {
    await duplicateRule(rule);
  }, [duplicateRule]);

  const handleRequestEdit = useCallback(async (rule: AutomationRule) => {
    const ok = await requestEditAccess(rule.id);
    if (ok) {
      toast({ variant: 'success', description: `Edit request sent for "${rule.name}".` });
    } else {
      toast({ variant: 'error', description: 'Could not request edit access.' });
    }
  }, [requestEditAccess, toast]);

  const handleSave = useCallback(async (data: Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'>) => {
    if (editingRule) {
      await updateRule(editingRule.id, data);
    } else {
      await createRule(data);
    }
    setShowDialog(false);
    setEditingRule(null);
  }, [editingRule, createRule, updateRule]);

  const handleCloseDialog = useCallback(() => {
    setShowDialog(false);
    setEditingRule(null);
  }, []);

  const fetchLogsCallback = useCallback(async (ruleId?: string) => {
    return getExecutionLogs(ruleId);
  }, [getExecutionLogs]);

  const handleDeleteLog = useCallback(async (logId: string) => {
    await deleteExecutionLog(logId);
  }, [deleteExecutionLog]);

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading automation rules...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <h1 className={styles.title}>Workflow Automation</h1>
          <p className={styles.subtitle}>
            Create rules to automate tasks and workflows.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.exportButton}
            onClick={() => setShowExport(true)}
            disabled={rules.length === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            Export rules
          </button>
          <button type="button" className={styles.createButton} onClick={handleCreate}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Rule
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => setShowVisibility(true)}
          title="Choose which automations you see"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Showing: {visibility === 'own' ? 'Mine' : visibility === 'all' ? "Everyone's" : 'Selected'}
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => setShowEditRequests(true)}
          title="Incoming and outgoing edit-access requests"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Edit requests
          {pendingIncoming > 0 && <span className={styles.requestBadge}>{pendingIncoming}</span>}
        </button>
      </div>

      <Tabs defaultTab="rules">
        <TabsList>
          <TabsTrigger id="rules">
            Rules
            {rules.length > 0 && <span className={styles.tabBadge}>{rules.length}</span>}
          </TabsTrigger>
          <TabsTrigger id="history">Execution History</TabsTrigger>
        </TabsList>

        <TabsContent id="rules">
          {rules.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </div>
              <h3 className={styles.emptyTitle}>No automation rules</h3>
              <p className={styles.emptyDescription}>
                Create your first automation rule to streamline your workflow.
              </p>
              <button type="button" className={styles.emptyCreateButton} onClick={handleCreate}>
                Create Rule
              </button>
            </div>
          ) : (
            <div className={styles.rulesGrid}>
              {rules.map((rule) => {
                const ownRequest = editRequests.find(
                  (r) => r.rule_id === rule.id && r.requester_id === userId,
                );
                const canManage = rule.created_by === userId || isAdmin || editorRuleIds.has(rule.id);
                const canRequestEdit = !canManage && ownRequest?.status !== 'pending';
                return (
                  <AutomationRuleCard
                    key={rule.id}
                    rule={rule}
                    canManage={canManage}
                    canRequestEdit={canRequestEdit}
                    onRequestEdit={() => handleRequestEdit(rule)}
                    onToggle={handleToggle}
                    onEdit={handleEdit}
                    onDuplicate={handleDuplicate}
                    onDelete={handleDelete}
                    onExport={handleExportOne}
                  />
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent id="history">
          <ExecutionLog fetchLogs={fetchLogsCallback} onDelete={handleDeleteLog} />
        </TabsContent>
      </Tabs>

      {showDialog && (
        <AutomationRuleDialog
          rule={editingRule}
          onSave={handleSave}
          onClose={handleCloseDialog}
        />
      )}

      <ExportAutomationsDialog
        open={showExport}
        rules={rules}
        onClose={() => setShowExport(false)}
      />

      <AutomationVisibilityDialog
        open={showVisibility}
        visibility={visibility}
        visibleMembers={visibleMembers}
        onSave={setVisibility}
        onClose={() => setShowVisibility(false)}
      />

      <AutomationEditRequestsDialog
        open={showEditRequests}
        requests={editRequests}
        currentUserId={userId}
        onRespond={respondToEditRequest}
        onCancel={cancelEditRequest}
        onRevoke={revokeEditAccess}
        onClose={() => setShowEditRequests(false)}
      />

      <ConfirmDialog
        open={deletingRuleId !== null}
        title="Delete automation rule"
        message="This action cannot be undone. The rule and its execution history will be permanently removed."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onClose={() => setDeletingRuleId(null)}
      />
    </div>
  );
}

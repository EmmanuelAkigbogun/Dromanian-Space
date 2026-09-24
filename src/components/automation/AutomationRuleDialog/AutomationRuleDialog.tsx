import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { Input } from '@/components/ui/Input/Input';
import { Textarea } from '@/components/ui/Textarea/Textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs/Tabs';
import { TriggerBuilder } from '../TriggerBuilder/TriggerBuilder';
import { ConditionBuilder } from '../ConditionBuilder/ConditionBuilder';
import { ActionBuilder } from '../ActionBuilder/ActionBuilder';
import type { AutomationRule, AutomationTrigger, AutomationCondition, AutomationAction } from '@/types';
import styles from './AutomationRuleDialog.module.css';

interface AutomationRuleDialogProps {
  rule: AutomationRule | null;
  onSave: (data: Omit<AutomationRule, 'id' | 'created_at' | 'updated_at' | 'created_by' | 'last_executed_at'>) => Promise<void>;
  onClose: () => void;
}

export function AutomationRuleDialog({ rule, onSave, onClose }: AutomationRuleDialogProps) {
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [triggers, setTriggers] = useState<AutomationTrigger[]>(rule?.triggers || []);
  const [conditions, setConditions] = useState<AutomationCondition[]>(rule?.conditions || []);
  const [actions, setActions] = useState<AutomationAction[]>(rule?.actions || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = name.trim() && triggers.length > 0 && actions.length > 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        workspace_id: rule?.workspace_id || '',
        name: name.trim(),
        description: description.trim() || null,
        triggers,
        conditions,
        actions,
        enabled: rule?.enabled ?? true,
      });
    } catch {
      setError('Failed to save automation rule');
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className={styles.footer}>
      <button type="button" className={styles.cancelButton} onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className={styles.saveButton}
        onClick={handleSubmit}
        disabled={saving || !isValid}
      >
        {saving ? 'Saving...' : rule ? 'Update Rule' : 'Create Rule'}
      </button>
    </div>
  );

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={rule ? 'Edit Automation Rule' : 'Create Automation Rule'}
      size="lg"
      footer={footer}
    >
      <div className={styles.form}>
        {error && <div className={styles.error}>{error}</div>}

        <Input
          label="Rule Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Auto-assign new tasks"
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what this rule does..."
          rows={2}
        />

        <Tabs defaultTab="triggers">
          <TabsList>
            <TabsTrigger id="triggers">
              Triggers
              {triggers.length > 0 && <span className={styles.tabBadge}>{triggers.length}</span>}
            </TabsTrigger>
            <TabsTrigger id="conditions">
              Conditions
              {conditions.length > 0 && <span className={styles.tabBadge}>{conditions.length}</span>}
            </TabsTrigger>
            <TabsTrigger id="actions">
              Actions
              {actions.length > 0 && <span className={styles.tabBadge}>{actions.length}</span>}
            </TabsTrigger>
          </TabsList>

          <TabsContent id="triggers">
            <TriggerBuilder triggers={triggers} onChange={setTriggers} />
          </TabsContent>

          <TabsContent id="conditions">
            <ConditionBuilder
              conditions={conditions}
              onChange={setConditions}
              triggerTypes={triggers.map((t) => t.event_type)}
            />
          </TabsContent>

          <TabsContent id="actions">
            <ActionBuilder actions={actions} onChange={setActions} />
          </TabsContent>
        </Tabs>

        <div className={styles.validationHints}>
          {!name.trim() && <span className={styles.hint}>Enter a rule name</span>}
          {triggers.length === 0 && <span className={styles.hint}>Select at least one trigger</span>}
          {actions.length === 0 && <span className={styles.hint}>Add at least one action</span>}
        </div>
      </div>
    </Dialog>
  );
}

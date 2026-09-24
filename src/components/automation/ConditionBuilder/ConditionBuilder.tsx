import { Select } from '@/components/ui/Select/Select';
import { Input } from '@/components/ui/Input/Input';
import type { AutomationCondition, ConditionOperator } from '@/types';
import styles from './ConditionBuilder.module.css';

interface ConditionBuilderProps {
  conditions: AutomationCondition[];
  onChange: (conditions: AutomationCondition[]) => void;
  triggerTypes?: string[];
}

const FIELD_PLACEHOLDERS: Record<string, string> = {
  title: 'e.g. Fix login bug',
  description: 'e.g. urgent production issue',
  content: 'e.g. hello world',
  status: 'e.g. todo, in_progress, completed',
  priority: 'e.g. low, medium, high, urgent',
  assignee: 'e.g. john@example.com',
  assignee_names: 'e.g. John, Jane',
  assignee_emails: 'e.g. john@example.com, jane@example.com',
  channel: 'e.g. 550e8400-e29b-41d4-a716-446655440000',
  channel_name: 'e.g. general',
  creator: 'e.g. John Doe',
  creator_email: 'e.g. john@example.com',
  project_name: 'e.g. Website Redesign',
  due_date: 'e.g. 2026-12-31',
  has_due_date: 'e.g. true',
  is_overdue: 'e.g. true',
  message_length: 'e.g. 100',
  message_content: 'e.g. deploy to production',
  created_at: 'e.g. 2026-01-01',
  updated_at: 'e.g. 2026-01-01',
};

const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does Not Contain' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'gte', label: 'Greater or Equal' },
  { value: 'lte', label: 'Less or Equal' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
];

const FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'content', label: 'Message Content' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'assignee_names', label: 'Assignee Names' },
  { value: 'assignee_emails', label: 'Assignee Emails' },
  { value: 'channel', label: 'Channel ID' },
  { value: 'channel_name', label: 'Channel Name' },
  { value: 'creator', label: 'Creator Name' },
  { value: 'creator_email', label: 'Creator Email' },
  { value: 'project_name', label: 'Project Name' },
  { value: 'due_date', label: 'Due Date' },
  { value: 'has_due_date', label: 'Has Due Date' },
  { value: 'is_overdue', label: 'Is Overdue' },
  { value: 'message_length', label: 'Message Length' },
  { value: 'message_content', label: 'Source Message' },
  { value: 'created_at', label: 'Created At' },
  { value: 'updated_at', label: 'Updated At' },
];

export function ConditionBuilder({ conditions, onChange, triggerTypes }: ConditionBuilderProps) {
  const addCondition = () => {
    onChange([
      ...conditions,
      { field: 'title', operator: 'equals', value: '', logic: conditions.length > 0 ? 'and' : undefined },
    ]);
  };

  const updateCondition = (index: number, updates: Partial<AutomationCondition>) => {
    onChange(
      conditions.map((c, i) => (i === index ? { ...c, ...updates } : c))
    );
  };

  const removeCondition = (index: number) => {
    const newConditions = conditions.filter((_, i) => i !== index);
    if (newConditions.length > 0 && newConditions[0].logic) {
      newConditions[0] = { ...newConditions[0], logic: undefined };
    }
    onChange(newConditions);
  };

  const toggleLogic = (index: number) => {
    if (index === 0) return;
    updateCondition(index, {
      logic: conditions[index].logic === 'and' ? 'or' : 'and',
    });
  };

  const needsValue = (op: ConditionOperator) => op !== 'is_empty' && op !== 'is_not_empty';

  return (
    <div className={styles.conditionBuilder}>
      <span className={styles.sectionLabel}>Conditions (Optional)</span>
      <p className={styles.sectionHint}>Add conditions to filter when the automation runs.</p>

      <div className={styles.conditionList}>
        {conditions.map((condition, index) => (
          <div key={index} className={styles.conditionRow}>
            {index > 0 && (
              <button
                type="button"
                className={styles.logicToggle}
                onClick={() => toggleLogic(index)}
              >
                {condition.logic || 'and'}
              </button>
            )}
            <div className={styles.conditionFields}>
              <Select
                options={FIELD_OPTIONS}
                value={condition.field}
                onChange={(e) => updateCondition(index, { field: e.target.value })}
                placeholder="Field"
                className={styles.fieldSelect}
              />
              <Select
                options={OPERATORS}
                value={condition.operator}
                onChange={(e) => updateCondition(index, { operator: e.target.value as ConditionOperator })}
                placeholder="Operator"
                className={styles.operatorSelect}
              />
              {needsValue(condition.operator) && (
                <Input
                  value={condition.value}
                  onChange={(e) => updateCondition(index, { value: e.target.value })}
                  placeholder={FIELD_PLACEHOLDERS[condition.field] || 'Value'}
                  className={styles.valueInput}
                />
              )}
              <button
                type="button"
                className={styles.removeButton}
                onClick={() => removeCondition(index)}
                aria-label="Remove condition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className={styles.addButton} onClick={addCondition}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add Condition
      </button>
    </div>
  );
}

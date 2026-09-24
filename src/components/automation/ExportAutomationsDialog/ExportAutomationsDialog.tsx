import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useToast } from '@/components/ui/Toast';
import { downloadJson, exportFileName, logDataExport } from '@/lib/workspace/export';
import { buildAutomationsExport } from '@/lib/import-export/automations';
import type { AutomationRule } from '@/types';
import styles from './ExportAutomationsDialog.module.css';

interface ExportAutomationsDialogProps {
  open: boolean;
  rules: AutomationRule[];
  onClose: () => void;
}

export function ExportAutomationsDialog({ open, rules, onClose }: ExportAutomationsDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(new Set(rules.map((r) => r.id)));
      setExporting(false);
    }
  }, [open, rules]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === rules.length ? new Set() : new Set(rules.map((r) => r.id)),
    );
  };

  const selectedCount = selected.size;

  const handleExport = async () => {
    if (!currentWorkspace || selectedCount === 0) return;
    setExporting(true);
    try {
      const chosen = rules.filter((r) => selected.has(r.id));
      const data = await buildAutomationsExport(chosen, currentWorkspace.name);
      downloadJson(exportFileName(currentWorkspace, 'automations'), data);
      logDataExport(currentWorkspace.id, 'automations', currentWorkspace.id).catch(() => {});
      toast({
        variant: 'success',
        title: 'Export ready',
        description: `${chosen.length} rule${chosen.length === 1 ? '' : 's'} exported.`,
      });
      onClose();
    } catch {
      toast({ variant: 'error', description: 'Failed to export automation rules.' });
    } finally {
      setExporting(false);
    }
  };

  const footer = (
    <div className={styles.footer}>
      <button type="button" className={styles.cancelButton} onClick={onClose} disabled={exporting}>
        Cancel
      </button>
      <button
        type="button"
        className={styles.exportButton}
        onClick={handleExport}
        disabled={exporting || selectedCount === 0}
      >
        {exporting ? 'Exporting...' : `Export selected (${selectedCount})`}
      </button>
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Export automations" footer={footer}>
      <div className={styles.selectAllRow}>
        <label className={styles.selectAll}>
          <input
            type="checkbox"
            checked={rules.length > 0 && selectedCount === rules.length}
            onChange={toggleAll}
          />
          <span>Select all ({rules.length})</span>
        </label>
      </div>
      <div className={styles.list}>
        {rules.map((rule) => (
          <label key={rule.id} className={styles.row}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={selected.has(rule.id)}
              onChange={() => toggle(rule.id)}
            />
            <span className={styles.rowInfo}>
              <span className={styles.rowName}>{rule.name}</span>
              <span className={styles.rowMeta}>
                {(rule.triggers ?? []).length} trigger(s) · {(rule.actions ?? []).length} action(s)
                {rule.enabled ? ' · enabled' : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className={styles.hint}>
        Downloads the chosen rules as a JSON file you can import into another workspace&apos;s
        Import Data tab.
      </p>
    </Dialog>
  );
}

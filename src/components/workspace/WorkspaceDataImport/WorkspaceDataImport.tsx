import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { useProjects } from '@/hooks/useProjects';
import { useTasks } from '@/hooks/useTasks';
import { useAutomation } from '@/hooks/useAutomation';
import { useToast } from '@/components/ui/Toast';
import { supabase } from '@/lib/supabase';
import { parseImportContent, type ParsedImport } from '@/lib/import-export/import';
import { toRuleDraft, sanitizeAutomationItems } from '@/lib/import-export/automations';
import type { ParsedTaskRow } from '@/lib/import-export/tasks';
import type { TaskPriority, TaskStatus } from '@/types/task';
import styles from './WorkspaceDataImport.module.css';

interface ImportResult {
  projectsCreated: number;
  projectsSkipped: number;
  tasksCreated: number;
  automationsCreated: number;
  automationsSkipped: number;
  assigneesSkipped: number;
  warnings: string[];
}

interface WorkspaceMemberMaps {
  memberIdByEmail: Map<string, string>;
  memberIds: Set<string>;
}

async function buildMemberMaps(workspaceId: string): Promise<WorkspaceMemberMaps> {
  const memberIdByEmail = new Map<string, string>();
  const memberIds = new Set<string>();
  const { data: members } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  const ids = ((members ?? []) as unknown as Array<{ user_id: string }>)
    .map((m) => m.user_id)
    .filter(Boolean);
  ids.forEach((id) => memberIds.add(id));
  if (ids.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles' as never)
      .select('id, email')
      .in('id', ids);
    for (const p of (profiles ?? []) as Array<{ id: string; email: string | null }>) {
      memberIds.add(p.id);
      if (p.email) memberIdByEmail.set(p.email.trim().toLowerCase(), p.id);
    }
  }
  return { memberIdByEmail, memberIds };
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

export function WorkspaceDataImport() {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const { createProject } = useProjects();
  const { createTask } = useTasks();
  const { createRule } = useAutomation();
  const { toast } = useToast();

  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [selectedAutomations, setSelectedAutomations] = useState<Set<string>>(new Set());

  const reset = useCallback(() => {
    setFileName('');
    setParsed(null);
    setParseError(null);
    setResult(null);
    setSelectedAutomations(new Set());
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      reset();
      if (!/\.(json|csv)$/i.test(file.name)) {
        setParseError('Unsupported file type. Please upload a .json or .csv file.');
        return;
      }
      setFileName(file.name);
      try {
        const content = await file.text();
        const p = await parseImportContent(content);
        setParsed(p);
        setSelectedAutomations(new Set(p.automations.map((_, i) => String(i))));
      } catch (err) {
        setParsed(null);
        setParseError(err instanceof Error ? err.message : 'Failed to parse the file.');
      }
    },
    [reset],
  );

  const toggleAutomation = useCallback((index: number) => {
    setSelectedAutomations((prev) => {
      const next = new Set(prev);
      const key = String(index);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllAutomations = useCallback((count: number) => {
    setSelectedAutomations((prev) =>
      prev.size === count ? new Set() : new Set(Array.from({ length: count }, (_, i) => String(i))),
    );
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const createImportedTask = useCallback(
    async (
      task: ParsedTaskRow,
      projectId: string | null,
      memberMaps: WorkspaceMemberMaps,
      r: ImportResult,
    ) => {
      const assigneeIds: string[] = [];
      for (const email of task.assignee_emails) {
        const id = memberMaps.memberIdByEmail.get(email);
        if (id) assigneeIds.push(id);
        else r.assigneesSkipped++;
      }
      const created = await createTask({
        title: task.title,
        description: task.description,
        status: (task.status as TaskStatus | undefined) ?? 'todo',
        priority: (task.priority as TaskPriority | undefined) ?? 'none',
        due_date: task.due_date,
        start_date: task.start_date,
        project_id: projectId ?? undefined,
        assigneeIds,
      });
      if (created) r.tasksCreated++;
    },
    [createTask],
  );

  const performImport = useCallback(
    async (
      p: ParsedImport,
      workspaceId: string,
      selectedAutomationIndices: Set<string>,
    ): Promise<ImportResult> => {
      const r: ImportResult = {
        projectsCreated: 0,
        projectsSkipped: 0,
        tasksCreated: 0,
        automationsCreated: 0,
        automationsSkipped: 0,
        assigneesSkipped: 0,
        warnings: [...p.warnings],
      };

      const memberMaps = await buildMemberMaps(workspaceId);

      const [existingProjectsResult, existingRulesResult] = await Promise.all([
        supabase.from('projects').select('id, name').eq('workspace_id', workspaceId),
        supabase
          .from('automation_rules' as never)
          .select('name')
          .eq('workspace_id', workspaceId),
      ]);

      const projectIdByName = new Map<string, string>();
      for (const pr of (existingProjectsResult.data ?? []) as Array<{ id: string; name: string }>) {
        projectIdByName.set(pr.name.toLowerCase(), pr.id);
      }
      const ruleNames = new Set(
        ((existingRulesResult.data ?? []) as Array<{ name: string }>).map((x) =>
          x.name.toLowerCase(),
        ),
      );

      const selectedAutomationsForImport = p.automations.filter((_, i) =>
        selectedAutomationIndices.has(String(i)),
      );
      const { items: sanitizedAutomations, warnings: automationWarnings } = sanitizeAutomationItems(
        selectedAutomationsForImport,
        memberMaps,
      );
      r.warnings.push(...automationWarnings);

      for (const item of sanitizedAutomations) {
        if (ruleNames.has(item.name.toLowerCase())) {
          r.automationsSkipped++;
          continue;
        }
        const created = await createRule(toRuleDraft(item, workspaceId));
        if (created) {
          r.automationsCreated++;
          ruleNames.add(item.name.toLowerCase());
        }
      }

      for (const project of p.projects) {
        const existingId = projectIdByName.get(project.name.toLowerCase());
        if (existingId) {
          r.projectsSkipped++;
          for (const task of project.tasks) {
            await createImportedTask(task, existingId, memberMaps, r);
          }
          continue;
        }
        const created = await createProject({
          name: project.name,
          description: project.description,
          color: project.color,
          icon: project.icon,
          due_date: project.due_date,
        });
        if (!created) {
          r.warnings.push(`Failed to create project "${project.name}".`);
          continue;
        }
        r.projectsCreated++;
        projectIdByName.set(project.name.toLowerCase(), created.id);
        for (const task of project.tasks) {
          await createImportedTask(task, created.id, memberMaps, r);
        }
      }

      const grouped = new Map<string, ParsedTaskRow[]>();
      for (const task of p.tasks) {
        if (!task.project_name) {
          await createImportedTask(task, null, memberMaps, r);
          continue;
        }
        const list = grouped.get(task.project_name) ?? [];
        list.push(task);
        grouped.set(task.project_name, list);
      }
      for (const [name, tasks] of grouped) {
        let projectId = projectIdByName.get(name.toLowerCase());
        if (!projectId) {
          const created = await createProject({ name });
          if (!created) {
            r.warnings.push(`Failed to create project "${name}" for its tasks.`);
            continue;
          }
          r.projectsCreated++;
          projectId = created.id;
          projectIdByName.set(name.toLowerCase(), projectId);
        }
        for (const task of tasks) {
          await createImportedTask(task, projectId, memberMaps, r);
        }
      }

      return r;
    },
    [createProject, createRule, createImportedTask],
  );

  const runImport = useCallback(async () => {
    if (!parsed || !currentWorkspace || !userId) return;
    setImporting(true);
    setResult(null);
    try {
      const r = await performImport(parsed, currentWorkspace.id, selectedAutomations);
      setResult(r);
      const created = r.projectsCreated + r.tasksCreated + r.automationsCreated;
      toast({
        variant: 'success',
        title: 'Import complete',
        description: `Created ${created} item${created === 1 ? '' : 's'} in ${currentWorkspace.name}.`,
      });
    } catch (err) {
      console.error('[import]', err);
      toast({ variant: 'error', description: 'Import failed. No changes were committed.' });
    } finally {
      setImporting(false);
    }
  }, [parsed, currentWorkspace, userId, performImport, selectedAutomations, toast]);

  if (!currentWorkspace) return null;

  const totalCount = parsed
    ? parsed.projects.length + parsed.tasks.length + parsed.automations.length
    : 0;

  const selectableCount = parsed
    ? parsed.projects.length + parsed.tasks.length + selectedAutomations.size
    : 0;

  const hasWarnings = parsed && parsed.warnings.length > 0;

  return (
    <div className={styles.container}>
      <p className={styles.text}>
        Import projects, tasks, and workflow automations from a JSON or CSV file. Everything is
        parsed in your browser and created as new records in{' '}
        <strong>{currentWorkspace.name}</strong>. Projects and automations with a matching name are
        skipped; task assignees are matched by email and skipped when the member isn&apos;t in this
        workspace.
      </p>

      <div
        className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('import-file-input')?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            document.getElementById('import-file-input')?.click();
          }
        }}
      >
        <svg
          className={styles.dropzoneIcon}
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <span className={styles.dropzoneTitle}>Drop a JSON or CSV file here, or click to browse</span>
        <span className={styles.dropzoneHint}>
          Workspace exports, automation exports, or task lists with title/description/priority/status
          columns.
        </span>
        <input
          id="import-file-input"
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className={styles.hiddenInput}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
      </div>

      {fileName && !parseError && (
        <div className={styles.fileInfo}>
          <span className={styles.fileName}>{fileName}</span>
          <button type="button" className={styles.removeFile} onClick={reset}>
            Remove
          </button>
        </div>
      )}

      {parseError && (
        <div className={styles.errorBox}>
          <span className={styles.error}>{parseError}</span>
          <button type="button" className={styles.removeFile} onClick={reset}>
            Remove file
          </button>
        </div>
      )}

      {parsed && totalCount === 0 && (
        <div className={styles.preview}>
          <span className={styles.previewTitle}>Nothing to import</span>
          <span className={styles.text}>
            The file didn&apos;t contain any recognizable projects, tasks, or automations.
          </span>
        </div>
      )}

      {parsed && totalCount > 0 && (
        <div className={styles.preview}>
          <span className={styles.previewTitle}>Preview</span>
          <div className={styles.stats}>
            {parsed.projects.length > 0 && <Stat value={parsed.projects.length} label="Projects" />}
            {parsed.tasks.length > 0 && <Stat value={parsed.tasks.length} label="Tasks" />}
            {parsed.automations.length > 0 && (
              <Stat value={parsed.automations.length} label="Automations" />
            )}
          </div>
          <p className={styles.text}>
            Imported automations are created disabled so you can review them before enabling. The
            task and channel references from the source workspace won&apos;t carry over.
          </p>
          {parsed.automations.length > 0 && (
            <div className={styles.importSection}>
              <div className={styles.selectAllRow}>
                <label className={styles.selectAll}>
                  <input
                    type="checkbox"
                    checked={selectedAutomations.size === parsed.automations.length}
                    onChange={() => toggleAllAutomations(parsed.automations.length)}
                  />
                  <span>Select all automations ({parsed.automations.length})</span>
                </label>
              </div>
              <div className={styles.selectList}>
                {parsed.automations.map((automation, i) => (
                  <label key={i} className={styles.selectRow}>
                    <input
                      type="checkbox"
                      className={styles.selectCheckbox}
                      checked={selectedAutomations.has(String(i))}
                      onChange={() => toggleAutomation(i)}
                    />
                    <span className={styles.selectRowInfo}>
                      <span className={styles.selectRowName}>{automation.name}</span>
                      <span className={styles.selectRowMeta}>
                        {(automation.triggers ?? []).length} trigger(s) ·{' '}
                        {(automation.actions ?? []).length} action(s)
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {hasWarnings && (
            <div className={styles.warnings}>
              {parsed.warnings.slice(0, 8).map((w, i) => (
                <span key={i} className={styles.warning}>
                  {w}
                </span>
              ))}
              {parsed.warnings.length > 8 && (
                <span className={styles.warning}>…and {parsed.warnings.length - 8} more.</span>
              )}
            </div>
          )}
          <div className={styles.actions}>
            <Button onClick={runImport} loading={importing} disabled={selectableCount === 0}>
              {importing ? 'Importing...' : `Import into workspace (${selectableCount})`}
            </Button>
            <Button variant="secondary" onClick={reset} disabled={importing}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div className={`${styles.result} ${styles.resultSuccess}`}>
          <span className={styles.resultTitle}>Import complete</span>
          <span className={styles.resultLine}>
            {result.projectsCreated} project(s) created, {result.tasksCreated} task(s) created,{' '}
            {result.automationsCreated} automation(s) created.
          </span>
          {(result.projectsSkipped > 0 ||
            result.automationsSkipped > 0 ||
            result.assigneesSkipped > 0 ||
            result.warnings.length > 0) && (
            <div className={styles.warnings}>
              {result.projectsSkipped > 0 && (
                <span className={styles.warning}>
                  {result.projectsSkipped} project(s) skipped because they already exist.
                </span>
              )}
              {result.automationsSkipped > 0 && (
                <span className={styles.warning}>
                  {result.automationsSkipped} automation(s) skipped because they already exist.
                </span>
              )}
              {result.assigneesSkipped > 0 && (
                <span className={styles.warning}>
                  {result.assigneesSkipped} task assignee(s) skipped (email not in this workspace).
                </span>
              )}
              {result.warnings.slice(0, 8).map((w, i) => (
                <span key={i} className={styles.warning}>
                  {w}
                </span>
              ))}
              {result.warnings.length > 8 && (
                <span className={styles.warning}>…and {result.warnings.length - 8} more.</span>
              )}
            </div>
          )}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}


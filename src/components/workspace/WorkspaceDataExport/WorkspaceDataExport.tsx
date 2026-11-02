import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAutomation } from '@/hooks/useAutomation';
import { useToast } from '@/components/ui/Toast';
import { platform } from '@/lib/platform';
import {
  collectWorkspaceExport,
  collectTasksExport,
  collectProjectsExport,
  collectEventsExport,
  downloadJson,
  downloadCsvExport,
  exportFileName,
  logDataExport,
} from '@/lib/workspace/export';
import { ExportAutomationsDialog } from '@/components/automation/ExportAutomationsDialog/ExportAutomationsDialog';
import { Floating, isInFloatingLayer } from '@/lib/overlay/Floating';
import styles from './WorkspaceDataExport.module.css';

interface ProjectOption {
  id: string;
  name: string;
}

interface ExportSectionProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

function ExportSection({ title, description, children }: ExportSectionProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionInfo}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionDescription}>{description}</span>
      </div>
      <div className={styles.sectionActions}>{children}</div>
    </div>
  );
}

export function WorkspaceDataExport() {
  const { currentWorkspace } = useWorkspace();
  const { rules } = useAutomation();
  const { toast } = useToast();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [exporting, setExporting] = useState<string | null>(null);
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [showAutomationExport, setShowAutomationExport] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showProjectDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node) && !isInFloatingLayer(e.target)) {
        setShowProjectDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showProjectDropdown]);

  useEffect(() => {
    if (!currentWorkspace) return;
    platform
      .from('projects')
      .select('id, name')
      .eq('workspace_id', currentWorkspace.id)
      .is('archived_at', null)
      .order('name')
      .then(({ data }) => {
        setProjects((data ?? []) as ProjectOption[]);
      });
  }, [currentWorkspace]);

  if (!currentWorkspace) return null;

  const runExport = async (label: string, producer: () => Promise<unknown>, scope = 'workspace', entityId: string | null = null) => {
    setExporting(label);
    try {
      const data = await producer();
      if (format === 'csv') {
        downloadCsvExport(exportFileName(currentWorkspace, label, undefined, 'csv').replace(/\.csv$/, ''), data);
      } else {
        downloadJson(exportFileName(currentWorkspace, label), data);
      }
      await logDataExport(currentWorkspace.id, scope, entityId);
      toast({ variant: 'success', title: 'Export ready', description: `Your ${label} export has been downloaded.` });
    } catch {
      toast({ variant: 'error', description: 'Failed to export data.' });
    } finally {
      setExporting(null);
    }
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className={styles.container}>
      <div className={styles.formatRow}>
        <p className={styles.text}>
          Download workspace data as JSON or CSV files. Every export is generated in your browser
          from data you already have access to, and nothing is uploaded. CSV exports produce one
          file per collection (e.g. messages.csv, tasks.csv).
        </p>
        <div className={styles.formatToggle} role="group" aria-label="Export format">
          <button
            type="button"
            className={`${styles.formatButton} ${format === 'json' ? styles.formatButtonActive : ''}`}
            onClick={() => setFormat('json')}
          >
            JSON
          </button>
          <button
            type="button"
            className={`${styles.formatButton} ${format === 'csv' ? styles.formatButtonActive : ''}`}
            onClick={() => setFormat('csv')}
          >
            CSV
          </button>
        </div>
      </div>

      <ExportSection title="Full workspace" description="Channels, messages, files, tasks, projects, members, and invitations.">
        <Button
          onClick={() =>
            runExport('workspace', async () => collectWorkspaceExport(currentWorkspace.id), 'workspace', currentWorkspace.id)
          }
          loading={exporting === 'workspace'}
        >
          {exporting === 'workspace' ? 'Preparing...' : 'Export'}
        </Button>
      </ExportSection>

      <ExportSection
        title="Tasks"
        description={selectedProject ? `All tasks in "${selectedProject.name}".` : 'All tasks in this workspace.'}
      >
        <div ref={projectDropdownRef}>
          <button
            type="button"
            className={styles.projectSelect}
            onClick={() => {
              if (showProjectDropdown) {
                setShowProjectDropdown(false);
                return;
              }
              setShowProjectDropdown(true);
            }}
            title="Filter by project"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Floating open={showProjectDropdown} anchor={projectDropdownRef} placement="bottom-end" offset={4} className={styles.projectDropdown}>
              <button
                type="button"
                className={`${styles.projectOption} ${!selectedProjectId ? styles.projectOptionActive : ''}`}
                onClick={() => {
                  setSelectedProjectId('');
                  setShowProjectDropdown(false);
                }}
              >
                All projects
              </button>
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.projectOption} ${selectedProjectId === p.id ? styles.projectOptionActive : ''}`}
                  onClick={() => {
                    setSelectedProjectId(p.id);
                    setShowProjectDropdown(false);
                  }}
                >
                  {p.name}
                </button>
              ))}
          </Floating>
        </div>
        <Button
          onClick={() =>
            runExport(
              selectedProject ? `tasks-${selectedProject.name}` : 'tasks',
              () => collectTasksExport(currentWorkspace.id, selectedProject?.id ?? null),
              'tasks',
              selectedProject?.id ?? null,
            )
          }
          loading={exporting === 'tasks'}
        >
          {exporting === 'tasks' ? 'Preparing...' : 'Export'}
        </Button>
      </ExportSection>

      <ExportSection title="Projects" description="All projects with their members and milestones.">
        <Button
          onClick={() => runExport('projects', () => collectProjectsExport(currentWorkspace.id), 'projects', currentWorkspace.id)}
          loading={exporting === 'projects'}
        >
          {exporting === 'projects' ? 'Preparing...' : 'Export'}
        </Button>
      </ExportSection>

      <ExportSection title="Events" description="All calendar events and their participants.">
        <Button
          onClick={() => runExport('events', () => collectEventsExport(currentWorkspace.id), 'events', currentWorkspace.id)}
          loading={exporting === 'events'}
        >
          {exporting === 'events' ? 'Preparing...' : 'Export'}
        </Button>
      </ExportSection>

      {format === 'json' && (
        <ExportSection
          title="Automations"
          description="Rules with their triggers, conditions, and actions."
        >
          <Button
            onClick={() => setShowAutomationExport(true)}
            loading={exporting === 'automations'}
            disabled={rules.length === 0}
          >
            {exporting === 'automations' ? 'Preparing...' : 'Export'}
          </Button>
        </ExportSection>
      )}

      <ExportAutomationsDialog
        open={showAutomationExport}
        rules={rules}
        onClose={() => setShowAutomationExport(false)}
      />
    </div>
  );
}

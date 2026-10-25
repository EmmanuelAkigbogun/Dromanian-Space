import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { MemberMultiSelect } from '@/components/automation/MemberMultiSelect/MemberMultiSelect';
import { workspacePeople } from '@/features/platform/client';
import { platform } from '@/lib/platform';
import {
  decideTaskRequest,
  listTaskRequests,
  subscribeToTaskRequests,
  type TaskRequest,
  type TaskRequestChanges,
} from '@/lib/tasks/approvals';
import { TASK_PRIORITY_OPTIONS } from '@/types/task';
import { formatRelativeTime } from '@/utils';
import styles from './TaskApprovals.module.css';

const PRIORITIES = TASK_PRIORITY_OPTIONS.filter((p) => p.value !== 'none').map((p) => ({ value: p.value, label: p.label }));

interface Lookups {
  people: Map<string, string>;
  projects: Array<{ value: string; label: string }>;
  agents: Map<string, string>;
}

interface TaskApprovalsProps {
  workspaceId: string;
  /** Project managers (or owners/admins when none are chosen) can decide. */
  isApprover: boolean;
  onPendingCountChange?: (count: number) => void;
}

const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export function TaskApprovals({ workspaceId, isApprover, onPendingCountChange }: TaskApprovalsProps) {
  const { toast } = useToast();
  const [requests, setRequests] = useState<TaskRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [lookups, setLookups] = useState<Lookups>({ people: new Map(), projects: [], agents: new Map() });

  const load = useCallback(async () => {
    try {
      setRequests(await listTaskRequests(workspaceId));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Task requests could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    return subscribeToTaskRequests(workspaceId, () => void load());
  }, [workspaceId, load]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [people, projects, agents] = await Promise.all([
        workspacePeople(workspaceId).catch(() => []),
        platform.from<Array<{ id: string; name: string; status: string }>>('projects').select('id, name, status').eq('workspace_id', workspaceId),
        platform.rpc<Array<{ id: string; name: string }>>('agent_directory', { p_workspace_id: workspaceId }),
      ]);
      if (cancelled) return;
      setLookups({
        people: new Map((people as Array<{ id: string; display_name: string | null; username: string | null }>).map((p) => [p.id, p.display_name || p.username || 'Member'])),
        projects: (projects.data ?? [])
          .filter((p) => p.status === 'active')
          .map((p) => ({ value: p.id, label: p.name })),
        agents: new Map(((agents.data as Array<{ id: string; name: string }>) ?? []).map((a) => [a.id, a.name])),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const pending = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);
  const decided = useMemo(() => requests.filter((r) => r.status !== 'pending'), [requests]);

  useEffect(() => {
    onPendingCountChange?.(pending.length);
  }, [pending.length, onPendingCountChange]);

  const decide = useCallback(
    async (request: TaskRequest, approve: boolean, changes?: TaskRequestChanges, note?: string) => {
      try {
        await decideTaskRequest(request.id, approve, changes, note);
        toast({ variant: 'success', description: approve ? `Created “${changes?.title ?? request.title}”.` : 'Request declined.' });
        await load();
        return true;
      } catch (err) {
        toast({ variant: 'error', description: err instanceof Error ? err.message : 'The request could not be updated.' });
        return false;
      }
    },
    [load, toast],
  );

  async function approveAll() {
    setBulkBusy(true);
    let failed = 0;
    for (const r of pending) {
      try {
        await decideTaskRequest(r.id, true);
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    await load();
    toast(
      failed
        ? { variant: 'error', description: `${failed} of ${pending.length} requests could not be approved. Open them to see why.` }
        : { variant: 'success', description: `Created ${pending.length} tasks.` },
    );
  }

  if (loading) {
    return (
      <div className={styles.centered}>
        <Spinner size="lg" label="Loading task requests..." />
      </div>
    );
  }

  return (
    <section className={styles.approvals} aria-label="Task approvals">
      <div className={styles.intro}>
        <div>
          <h3 className={styles.heading}>Waiting for approval{pending.length ? ` (${pending.length})` : ''}</h3>
          <p className={styles.muted}>
            {isApprover
              ? 'Scribe prepares these from conversations and pasted lists. Edit anything before approving; nothing is created until you approve.'
              : 'Tasks you asked Scribe to prepare wait here until a project manager approves them.'}
          </p>
        </div>
        {isApprover && pending.length > 1 && (
          <Button variant="secondary" onClick={() => void approveAll()} loading={bulkBusy}>
            Approve all
          </Button>
        )}
      </div>

      {error && <p role="alert" className={styles.error}>{error}</p>}

      {pending.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing to review</p>
          <p className={styles.muted}>
            Ask Scribe to take notes on a channel (the <strong>Take notes</strong> button in a channel), paste a list into a chat with Scribe, or
            invite it into a direct message.
          </p>
        </div>
      ) : (
        <ul className={styles.list}>
          {pending.map((r) => (
            <RequestCard key={r.id} request={r} lookups={lookups} canDecide={isApprover} onDecide={decide} />
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <>
          <h3 className={styles.subheading}>Recently decided</h3>
          <ul className={styles.decidedList}>
            {decided.map((r) => (
              <li key={r.id} className={styles.decided}>
                <span className={r.status === 'approved' ? styles.approvedBadge : styles.rejectedBadge}>{r.status}</span>
                {r.task_id ? <Link to={`/tasks/${r.task_id}`}>{r.title}</Link> : <span>{r.title}</span>}
                <span className={styles.muted}>
                  {r.decided_by ? `by ${lookups.people.get(r.decided_by) ?? 'a project manager'}` : ''}
                  {r.decided_at ? ` · ${formatRelativeTime(r.decided_at)}` : ''}
                  {r.decision_note ? ` · “${r.decision_note}”` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RequestCard({
  request: r,
  lookups,
  canDecide,
  onDecide,
}: {
  request: TaskRequest;
  lookups: Lookups;
  canDecide: boolean;
  onDecide: (r: TaskRequest, approve: boolean, changes?: TaskRequestChanges, note?: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [description, setDescription] = useState(r.description ?? '');
  const [assignees, setAssignees] = useState<string[]>(r.assignee_ids);
  const [priority, setPriority] = useState<string>(r.priority);
  const [due, setDue] = useState(dateOnly(r.due_date));
  const [project, setProject] = useState(r.project_id ?? '');
  const [note, setNote] = useState('');

  const names = r.assignee_ids.map((id) => lookups.people.get(id) ?? 'Member');
  const projectName = lookups.projects.find((p) => p.value === r.project_id)?.label;
  const via = r.agent_id ? lookups.agents.get(r.agent_id) ?? 'an agent' : null;

  async function run(approve: boolean, changes?: TaskRequestChanges, reason?: string) {
    setBusy(true);
    const ok = await onDecide(r, approve, changes, reason);
    setBusy(false);
    if (ok) setMode('view');
  }

  function saveAndApprove() {
    void run(true, {
      title: title.trim(),
      description,
      assignee_ids: assignees,
      priority,
      // Noon UTC keeps the calendar date stable across time zones.
      due_date: due ? `${due}T12:00:00.000Z` : null,
      project_id: project || null,
    });
  }

  return (
    <li className={styles.card}>
      {mode === 'edit' ? (
        <div className={styles.form}>
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required />
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          <MemberMultiSelect label="Assignees" value={assignees} onChange={setAssignees} />
          <div className={styles.row}>
            <Select label="Priority" options={PRIORITIES} value={priority} onChange={(e) => setPriority(e.target.value)} />
            <Input label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            <Select label="Project" options={[{ value: '', label: 'No project' }, ...lookups.projects]} value={project} onChange={(e) => setProject(e.target.value)} />
          </div>
          <div className={styles.actions}>
            <Button onClick={saveAndApprove} loading={busy} disabled={!title.trim()}>
              Save &amp; approve
            </Button>
            <Button variant="ghost" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.cardHeader}>
            <h4 className={styles.title}>{r.title}</h4>
            <span className={styles.priority} data-priority={r.priority}>{r.priority}</span>
          </div>
          {r.description && <p className={styles.description}>{r.description}</p>}
          <div className={styles.meta}>
            <span>{names.length ? `For ${names.join(', ')}` : 'Unassigned'}</span>
            {r.due_date && <span>Due {new Date(r.due_date).toLocaleDateString()}</span>}
            {projectName && <span>{projectName}</span>}
          </div>
          <p className={styles.source}>
            Requested by {lookups.people.get(r.submitted_by) ?? 'a member'}
            {via ? ` via ${via}` : ''}
            {r.source_label ? ` from ${r.source_label}` : ''} · {formatRelativeTime(r.created_at)}
          </p>
          {mode === 'reject' ? (
            <div className={styles.form}>
              <Input label="Reason (optional, shared with the requester)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
              <div className={styles.actions}>
                <Button variant="danger" onClick={() => void run(false, undefined, note)} loading={busy}>
                  Decline
                </Button>
                <Button variant="ghost" onClick={() => setMode('view')} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            canDecide && (
              <div className={styles.actions}>
                <Button onClick={() => void run(true)} loading={busy}>
                  Approve
                </Button>
                <Button variant="secondary" onClick={() => setMode('edit')} disabled={busy}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => setMode('reject')} disabled={busy}>
                  Decline
                </Button>
              </div>
            )
          )}
        </>
      )}
    </li>
  );
}

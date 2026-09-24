import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { supabase } from '@/lib/supabase';
import { getStatusLabel } from '@/types/task';
import styles from './TaskSelect.module.css';

interface Task {
  id: string;
  title: string;
  status: string | null;
}

interface TaskSelectProps {
  label?: string;
  value: string;
  onChange: (taskId: string, taskTitle?: string, taskStatus?: string) => void;
  placeholder?: string;
}

export function TaskSelect({ label, value, onChange, placeholder = 'Search tasks...' }: TaskSelectProps) {
  const { currentWorkspace } = useWorkspace();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [customStatuses, setCustomStatuses] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const getStatusText = (status: string | null): string => {
    if (!status) return '';
    return customStatuses[status] || getStatusLabel(status as never) || status;
  };

  useEffect(() => {
    if (!currentWorkspace) return;
    (async () => {
      let q = supabase
        .from('tasks' as never)
        .select('id, title, status')
        .eq('workspace_id', currentWorkspace.id)
        .order('created_at', { ascending: false })
        .limit(25);
      const trimmed = query.trim();
      if (trimmed) {
        q = q.ilike('title', `%${trimmed}%`);
      }
      const { data } = await q;
      const rows = (data ?? []) as unknown as Task[];
      setTasks(rows);

      const taskIds = rows.map((t) => t.id);
      if (taskIds.length === 0) return;
      const { data: customs } = await supabase
        .from('task_custom_statuses' as never)
        .select('id, name, task_id')
        .in('task_id', taskIds);
      const map: Record<string, string> = {};
      for (const cs of (customs ?? []) as unknown as Array<{ id: string; name: string }>) {
        if (!cs.name.startsWith('__hidden__:')) map[cs.id] = cs.name;
      }
      setCustomStatuses((prev) => ({ ...prev, ...map }));
    })();
  }, [currentWorkspace, query]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    (async () => {
      const { data } = await supabase
        .from('tasks' as never)
        .select('id, title, status')
        .eq('id', value)
        .maybeSingle();
      if (data) setSelected(data as unknown as Task);
    })();
  }, [value, selected?.id]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selectTask = (task: Task) => {
    setSelected(task);
    onChange(task.id, task.title, task.status ?? '');
    setQuery('');
    setOpen(false);
  };

  return (
    <div className={styles.container} ref={rootRef}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.control} onClick={() => setOpen(true)}>
        {selected ? (
          <>
            <span className={styles.chip}>{selected.title}</span>
            <button
              type="button"
              className={styles.clearButton}
              onClick={(e) => {
                e.stopPropagation();
                setSelected(null);
                onChange('', '');
              }}
              aria-label="Clear task"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        ) : (
          <input
            type="text"
            className={styles.input}
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
          />
        )}
      </div>

      {open && !selected && (
        <div className={styles.dropdown}>
          {tasks.length === 0 && <span className={styles.empty}>No matching tasks</span>}
          {tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className={styles.option}
              onClick={() => selectTask(task)}
            >
              <span className={styles.optionTitle}>{task.title}</span>
              <span className={styles.optionStatus}>{getStatusText(task.status)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

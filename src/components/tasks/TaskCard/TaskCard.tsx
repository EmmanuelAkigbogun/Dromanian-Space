import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Tooltip } from '@/components/ui/Tooltip';
import type { Task, TaskStatus } from '@/types/task';
import { getStatusColor, getStatusLabel, getPriorityColor, TASK_STATUS_OPTIONS } from '@/types/task';
import { formatRelativeTime } from '@/utils';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => void;
  onEdit?: (task: Task) => void;
  onRestore?: (task: Task) => void;
  onDuplicate?: (task: Task) => void;
  assigneeNames?: Record<string, { name: string; avatar_url: string | null; email?: string | null }>;
  labels?: { id: string; name: string; color: string }[];
  customStatuses?: { id: string; name: string }[];
  statusOrder?: { id: string; name: string }[] | null;
  hiddenStatuses?: string[];
  isDragging?: boolean;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onStatusChange,
  onEdit,
  onRestore,
  onDuplicate,
  assigneeNames = {},
  labels = [],
  customStatuses = [],
  statusOrder = null,
  hiddenStatuses = [],
  isDragging,
}: TaskCardProps) {
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const visibleStatusOptions = (() => {
    if (statusOrder) {
      return statusOrder.filter((o) => !hiddenStatuses.includes(o.id)).map((o) => ({ id: o.id, label: o.name }));
    }
    const defaults = TASK_STATUS_OPTIONS.filter((o) => !hiddenStatuses.includes(o.value)).map((o) => ({ id: o.value, label: o.label }));
    const customs = customStatuses.filter((cs) => !cs.name.startsWith('__hidden__:')).map((cs) => ({ id: cs.id, label: cs.name }));
    const allOptions = [...defaults, ...customs];
    if (task.status_order && task.status_order.length > 0) {
      const optionMap = new Map(allOptions.map((o) => [o.id, o]));
      const ordered = task.status_order.map((id) => optionMap.get(id)).filter(Boolean) as { id: string; label: string }[];
      const missing = allOptions.filter((o) => !ordered.some((r) => r.id === o.id));
      return [...ordered, ...missing];
    }
    return allOptions;
  })();

  useEffect(() => {
    setShowStatusDropdown(false);
    setActiveIndex(-1);
    setDropdownPos(null);
  }, [task]);

  useEffect(() => {
    if (!showStatusDropdown) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowStatusDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showStatusDropdown]);

  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => {
        const next = Math.min(prev + 1, visibleStatusOptions.length - 1);
        optionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => {
        const next = Math.max(prev - 1, 0);
        optionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const opt = visibleStatusOptions[activeIndex];
      if (opt) {
        onStatusChange?.(task.id, opt.id as TaskStatus);
        setShowStatusDropdown(false);
      }
    } else if (e.key === 'Escape') {
      setShowStatusDropdown(false);
    }
  }, [showStatusDropdown, activeIndex, visibleStatusOptions, onStatusChange, task.id]);

  const handleCardClick = useCallback(() => {
    setShowStatusDropdown(false);
    onClick?.(task);
  }, [onClick, task]);

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onEdit?.(task);
    },
    [onEdit, task],
  );

  const handleRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRestore?.(task);
    },
    [onRestore, task],
  );

  const handleDuplicate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDuplicate?.(task);
    },
    [onDuplicate, task],
  );

  const isOverdue = task.due_date && new Date(task.due_date) < new Date() && task.status !== 'completed';
  const isDueSoon =
    task.due_date &&
    !isOverdue &&
    new Date(task.due_date).getTime() - new Date().getTime() < 3 * 24 * 60 * 60 * 1000;

  const assigneeEntries = Object.entries(assigneeNames).slice(0, 3);
  const extraCount = Object.keys(assigneeNames).length - 3;

  return (
    <div
      className={`${styles.card} ${isDragging ? styles.dragging : ''}`}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      <div className={styles.dragHandle} aria-label="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="2" />
          <circle cx="16" cy="6" r="2" />
          <circle cx="8" cy="12" r="2" />
          <circle cx="16" cy="12" r="2" />
          <circle cx="8" cy="18" r="2" />
          <circle cx="16" cy="18" r="2" />
        </svg>
      </div>

      <div className={styles.mainContent}>
        <div className={styles.titleRow}>
          <span
            className={styles.priorityDot}
            style={{ backgroundColor: getPriorityColor(task.priority) }}
            title={`Priority: ${task.priority}`}
          />
          <span className={styles.title}>{task.title}</span>
        </div>

        <div className={styles.metaRow}>
          <span
            className={styles.statusBadge}
            style={{
              backgroundColor: `${getStatusColor(task.status)}18`,
              color: getStatusColor(task.status),
            }}
          >
            <span className={styles.statusDot} style={{ backgroundColor: getStatusColor(task.status) }} />
            {statusOrder?.find((o) => o.id === task.status)?.name
              ?? customStatuses.find((cs) => cs.id === task.status)?.name
              ?? getStatusLabel(task.status as TaskStatus)}
          </span>

          {task.due_date && (
            <span
              className={`${styles.dueDate} ${isOverdue ? styles.dueDateOverdue : ''} ${isDueSoon ? styles.dueDateSoon : ''}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              {formatRelativeTime(task.due_date)}
            </span>
          )}

          {labels.length > 0 && (
            <div className={styles.labels}>
              {labels.map((label) => (
                <Tooltip key={label.id} content={label.name}>
                  <span className={styles.labelDot} style={{ backgroundColor: label.color }} />
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.rightSection}>
        {assigneeEntries.length > 0 && (
          <div className={styles.avatarStack}>
            {assigneeEntries.map(([id, member]) => (
              <Tooltip key={id} content={member.email || member.name}>
                <Avatar
                  src={member.avatar_url ?? undefined}
                  name={member.name}
                  size="xs"
                />
              </Tooltip>
            ))}
            {extraCount > 0 && (
              <span className={styles.overflowCount}>+{extraCount}</span>
            )}
          </div>
        )}

        <div className={styles.quickActions}>
          {onRestore && (
            <button
              type="button"
              className={styles.quickAction}
              onClick={handleRestore}
              title="Restore task"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              className={styles.quickAction}
              onClick={handleEdit}
              title="Edit task"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          {onDuplicate && (
            <button
              type="button"
              className={`${styles.quickAction} ${styles.quickActionSpaced}`}
              onClick={handleDuplicate}
              title="Duplicate task"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
          )}
          {onStatusChange && (
            <div ref={dropdownRef}>
              <button
                type="button"
                className={styles.quickAction}
                onClick={(e) => {
                  e.stopPropagation();
                  if (showStatusDropdown) {
                    setShowStatusDropdown(false);
                  } else {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const spaceBelow = window.innerHeight - rect.bottom;
                    const dropdownHeight = Math.min(visibleStatusOptions.length * 36, 280);
                    setDropdownPos({
                      top: spaceBelow < dropdownHeight ? rect.top - dropdownHeight - 4 : rect.bottom + 4,
                      left: rect.right - 160,
                    });
                    setActiveIndex(-1);
                    setShowStatusDropdown(true);
                  }
                }}
                title="Change status"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showStatusDropdown && dropdownPos && (
                <div className={styles.statusDropdown} style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left }} tabIndex={0} onKeyDown={handleDropdownKeyDown} ref={(el) => { if (el) el.focus(); }}>
                  {visibleStatusOptions.map((opt, i) => (
                    <button
                      key={opt.id}
                      ref={(el) => { optionRefs.current[i] = el; }}
                      type="button"
                      className={`${styles.statusOption} ${task.status === opt.id ? styles.statusOptionActive : ''} ${i === activeIndex ? styles.statusOptionActive : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusChange?.(task.id, opt.id as TaskStatus);
                        setShowStatusDropdown(false);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <span
                        className={styles.statusDot}
                        style={{ backgroundColor: getStatusColor(opt.id as TaskStatus) }}
                      />
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

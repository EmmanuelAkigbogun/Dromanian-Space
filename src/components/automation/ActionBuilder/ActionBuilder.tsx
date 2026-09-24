import { useCallback, useEffect, useRef, useState } from 'react';
import { Select } from '@/components/ui/Select/Select';
import { Input } from '@/components/ui/Input/Input';
import { Textarea } from '@/components/ui/Textarea/Textarea';
import { MemberSelect } from '@/components/automation/MemberSelect/MemberSelect';
import { MemberMultiSelect } from '@/components/automation/MemberMultiSelect/MemberMultiSelect';
import { TaskSelect } from '@/components/automation/TaskSelect/TaskSelect';
import { UploadProgress } from '@/components/message/UploadProgress';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { uploadFile, isFileSizeValid, formatFileSize } from '@/lib/message';
import { TASK_STATUS_OPTIONS } from '@/types/task';
import type { AutomationAction } from '@/types';
import styles from './ActionBuilder.module.css';

interface AutomationAttachment {
  file_url: string;
  file_name: string;
  file_size: number;
  file_type: string;
}

interface UploadingFile {
  id: string;
  index: number;
  file: File;
  progress: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
}

interface ActionBuilderProps {
  actions: AutomationAction[];
  onChange: (actions: AutomationAction[]) => void;
}

interface ActionType {
  value: string;
  label: string;
  configFields: Array<{ key: string; label: string; type: 'text' | 'textarea' | 'select' | 'task' | 'datetime'; options?: Array<{ value: string; label: string }> }>;
}

const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const ACTION_TYPES: ActionType[] = [
  {
    value: 'send_notification',
    label: 'Send Notification',
    configFields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'message', label: 'Message', type: 'textarea' },
      { key: 'recipients', label: 'Recipients', type: 'select', options: [
        { value: 'all_members', label: 'All Members' },
        { value: 'assignee', label: 'Assignee' },
        { value: 'trigger_creator', label: 'Trigger Creator' },
        { value: 'self', label: 'Myself' },
      ]},
    ],
  },
  {
    value: 'create_task',
    label: 'Create Task',
    configFields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'priority', label: 'Priority', type: 'select', options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ]},
      { key: 'status', label: 'Status', type: 'select', options: [
        { value: 'backlog', label: 'Backlog' },
        { value: 'todo', label: 'To Do' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'review', label: 'Review' },
        { value: 'completed', label: 'Completed' },
      ]},
      { key: 'assignee', label: 'Assign To', type: 'select', options: [
        { value: 'trigger_creator', label: 'Trigger Creator' },
        { value: 'specific_user', label: 'A Member' },
        { value: 'none', label: 'No One' },
      ]},
    ],
  },
  {
    value: 'assign_task',
    label: 'Assign Task',
    configFields: [
      { key: 'task', label: 'Task', type: 'task' },
      { key: 'assignee', label: 'Assign To', type: 'select', options: [
        { value: 'trigger_creator', label: 'Trigger Creator' },
        { value: 'self', label: 'Myself' },
        { value: 'trigger_assignee', label: 'Trigger Task Assignee' },
        { value: 'specific_user', label: 'A Member' },
      ]},
    ],
  },
  {
    value: 'update_status',
    label: 'Update Status',
    configFields: [
      { key: 'task', label: 'Task', type: 'task' },
      { key: 'status', label: 'New Status', type: 'select', options: [
        { value: 'next', label: 'Next status (flow order)' },
        { value: 'backlog', label: 'Backlog' },
        { value: 'todo', label: 'To Do' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'review', label: 'Review' },
        { value: 'completed', label: 'Completed' },
        { value: 'cancelled', label: 'Cancelled' },
      ]},
    ],
  },
  {
    value: 'post_message',
    label: 'Post Message',
    configFields: [
      { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'content', label: 'Message Content', type: 'textarea' },
    ],
  },
  {
    value: 'auto_reply',
    label: 'Auto-Reply to Message',
    configFields: [
      { key: 'content', label: 'Reply Content', type: 'textarea' },
      { key: 'reply_mode', label: 'Reply As', type: 'select', options: [
        { value: 'inline', label: 'Reply in the channel' },
        { value: 'thread', label: 'Reply in thread' },
      ]},
    ],
  },
  {
    value: 'schedule_message',
    label: 'Schedule Message',
    configFields: [
      { key: 'channel', label: 'Channel', type: 'text' },
      { key: 'content', label: 'Message Content', type: 'textarea' },
      { key: 'scheduled_at', label: 'Date & Time', type: 'datetime' },
    ],
  },
  {
    value: 'send_reminder',
    label: 'Send Reminder',
    configFields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'message', label: 'Message', type: 'textarea' },
      { key: 'target_type', label: 'Assign To', type: 'select', options: [
        { value: 'self', label: 'Myself' },
        { value: 'trigger_creator', label: 'Trigger Creator' },
        { value: 'user', label: 'A Member' },
        { value: 'channel', label: 'A Channel' },
        { value: 'dm', label: 'A DM Group' },
      ]},
      { key: 'delay_type', label: 'When', type: 'select', options: [
        { value: 'minutes', label: 'After a delay' },
        { value: 'specific_time', label: 'At a specific time' },
        { value: 'specific_day', label: 'On a specific day' },
      ]},
    ],
  },
];

export function ActionBuilder({ actions, onChange }: ActionBuilderProps) {
  const { currentWorkspace } = useWorkspace();
  const { userId } = useAuth();
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [dms, setDms] = useState<Array<{ id: string; label: string }>>([]);
  const [dmChannels, setDmChannels] = useState<Array<{ id: string; label: string }>>([]);
  const [taskStatusOptions, setTaskStatusOptions] = useState<Record<string, Array<{ value: string; label: string }>>>({});
  const [statusLabelMap, setStatusLabelMap] = useState<Record<string, string>>({});
  const [pendingUploads, setPendingUploads] = useState<UploadingFile[]>([]);
  const cancelledUploads = useRef<Set<string>>(new Set());
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!currentWorkspace) return;
    (async () => {
      // DM conversations are backed by a channels row named "Direct Message";
      // drop those so only real channels appear in the channel dropdowns.
      const [chRes, dcRes] = await Promise.all([
        supabase
          .from('channels')
          .select('id, name')
          .eq('workspace_id', currentWorkspace.id)
          .is('archived_at', null)
          .order('name'),
        supabase
          .from('direct_conversations' as never)
          .select('channel_id')
          .eq('workspace_id', currentWorkspace.id),
      ]);
      const dmChannelIds = new Set(
        (((dcRes.data ?? []) as unknown as Array<{ channel_id: string | null }>)
          .map((c) => c.channel_id)
          .filter((id): id is string => Boolean(id))),
      );
      setChannels(
        ((chRes.data ?? []) as Array<{ id: string; name: string }>).filter((c) => !dmChannelIds.has(c.id)),
      );
    })();
  }, [currentWorkspace]);

  useEffect(() => {
    if (!currentWorkspace || !userId) return;
    (async () => {
      const { data: participations } = await supabase
        .from('direct_conversation_participants' as never)
        .select('conversation_id')
        .eq('user_id', userId);
      const conversationIds = ((participations ?? []) as unknown as Array<{ conversation_id: string }>).map(
        (p) => p.conversation_id,
      );
      if (conversationIds.length === 0) return;

      const { data: conversations } = await supabase
        .from('direct_conversations' as never)
        .select('id, type, name, channel_id')
        .eq('workspace_id', currentWorkspace.id)
        .in('id', conversationIds);

      const convRows = (conversations ?? []) as unknown as Array<{ id: string; type: string; name: string | null; channel_id: string | null }>;
      if (convRows.length === 0) return;

      const rows = await Promise.all(
        convRows.map(async (conv) => {
          let label: string;
          if (conv.type === 'group') {
            label = `Group${conv.name ? ` · ${conv.name}` : ''}`;
          } else {
            const { data: others } = await supabase
              .from('direct_conversation_participants' as never)
              .select('user_id')
              .eq('conversation_id', conv.id)
              .neq('user_id', userId);
            const otherIds = ((others ?? []) as unknown as Array<{ user_id: string }>).map((o) => o.user_id);
            if (otherIds.length === 0) {
              label = 'DM';
            } else {
              const { data: profiles } = await supabase
                .from('profiles' as never)
                .select('email, display_name, username')
                .in('id', otherIds);
              const names = ((profiles ?? []) as unknown as Array<{ email: string; display_name: string | null; username: string | null }>)
                .map((p) => p.display_name || p.username || p.email || '')
                .filter(Boolean);
              label = names.join(', ') || 'DM';
            }
          }
          return { id: conv.id, channelId: conv.channel_id ?? '', label };
        }),
      );

      setDms(rows.map(({ id, label }) => ({ id, label })));
      setDmChannels(
        rows
          .filter((r) => r.channelId)
          .map(({ channelId, label }) => ({ id: channelId, label })),
      );
    })();
  }, [currentWorkspace, userId]);

  const loadTaskStatusOptions = useCallback(async (taskId: string) => {
    if (!taskId) return;
    if (taskStatusOptions[taskId]) return;

    const { data: task } = await supabase
      .from('tasks' as never)
      .select('status_order')
      .eq('id', taskId)
      .maybeSingle();
    const { data: customs } = await supabase
      .from('task_custom_statuses' as never)
      .select('id, name')
      .eq('task_id', taskId)
      .order('sort_order');

    const csRows = (customs ?? []) as unknown as Array<{ id: string; name: string }>;
    const hiddenIds = csRows
      .filter((cs) => cs.name.startsWith('__hidden__:'))
      .map((cs) => cs.name.replace('__hidden__:', ''));
    const customOptions = csRows
      .filter((cs) => !cs.name.startsWith('__hidden__:'))
      .map((cs) => ({ value: cs.id, label: cs.name }));

    let all: Array<{ value: string; label: string }> = [
      ...TASK_STATUS_OPTIONS.filter((o) => !hiddenIds.includes(o.value)).map((o) => ({
        value: o.value,
        label: o.label,
      })),
      ...customOptions,
    ];

    const taskOrder = (task as { status_order?: string[] | null } | null)?.status_order;
    if (taskOrder && taskOrder.length > 0) {
      const optionMap = new Map(all.map((o) => [o.value, o]));
      const ordered = taskOrder
        .map((id) => optionMap.get(id))
        .filter((o): o is { value: string; label: string } => !!o);
      const missing = all.filter((o) => !ordered.some((r) => r.value === o.value));
      all = [...ordered, ...missing];
    }

    setTaskStatusOptions((prev) => ({ ...prev, [taskId]: all }));
    setStatusLabelMap((prev) => {
      const next = { ...prev };
      for (const cs of customOptions) next[cs.value] = cs.label;
      return next;
    });
  }, [taskStatusOptions]);

  useEffect(() => {
    actions.forEach((action) => {
      if (action.action_type === 'update_status' && action.config.task_id) {
        loadTaskStatusOptions(String(action.config.task_id));
      }
    });
  }, [actions, loadTaskStatusOptions]);

  const addAction = () => {
    onChange([
      ...actions,
      {
        action_type: ACTION_TYPES[0].value,
        config: {},
        position: actions.length,
      },
    ]);
  };

  const updateAction = (index: number, updates: Partial<AutomationAction>) => {
    onChange(
      actionsRef.current.map((a, i) => (i === index ? { ...a, ...updates } : a))
    );
  };

  const removeAction = (index: number) => {
    onChange(
      actions
        .filter((_, i) => i !== index)
        .map((a, i) => ({ ...a, position: i }))
    );
  };

  const moveAction = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= actions.length) return;
    const newActions = [...actions];
    [newActions[index], newActions[newIndex]] = [newActions[newIndex], newActions[index]];
    onChange(newActions.map((a, i) => ({ ...a, position: i })));
  };

  const getConfigFields = (actionType: string) => {
    return ACTION_TYPES.find((t) => t.value === actionType)?.configFields || [];
  };

  const getAttachments = (action: AutomationAction): AutomationAttachment[] =>
    Array.isArray(action.config.attachments) ? (action.config.attachments as AutomationAttachment[]) : [];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const action = actionsRef.current[index];
    if (!action) return;

    Array.from(files).forEach((file) => {
      if (!isFileSizeValid(file)) {
        alert(`File ${file.name} is too large (max 50MB)`);
        return;
      }
      const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPendingUploads((prev) => [
        ...prev,
        { id: uploadId, index, file, progress: 0, status: 'uploading' },
      ]);

      (async () => {
        try {
          const url = await uploadFile(file, 'automation', (p) => {
            setPendingUploads((prev) => prev.map((f) => (f.id === uploadId ? { ...f, progress: p } : f)));
          });
          if (cancelledUploads.current.has(uploadId)) return;
          if (!url) {
            console.error('[automation] attachment upload failed:', file.name);
            setPendingUploads((prev) =>
              prev.map((f) => (f.id === uploadId ? { ...f, status: 'error', error: 'Upload failed' } : f)),
            );
            return;
          }
          setPendingUploads((prev) =>
            prev.map((f) => (f.id === uploadId ? { ...f, progress: 100, status: 'complete' } : f)),
          );
          const attachment: AutomationAttachment = {
            file_url: url,
            file_name: file.name,
            file_size: file.size,
            file_type: file.type,
          };
          const latestAction = actionsRef.current[index];
          const latestConfig = latestAction?.config ?? {};
          const currentAttachments = Array.isArray(latestConfig.attachments)
            ? (latestConfig.attachments as AutomationAttachment[])
            : [];
          updateAction(index, {
            config: {
              ...latestConfig,
              attachments: [...currentAttachments, attachment],
            },
          });
          setTimeout(() => {
            setPendingUploads((prev) => prev.filter((f) => f.id !== uploadId));
          }, 2000);
        } catch (err) {
          console.error('[automation] attachment upload error:', err);
          setPendingUploads((prev) =>
            prev.map((f) => (f.id === uploadId ? { ...f, status: 'error', error: 'Upload error' } : f)),
          );
        }
      })();
    });

    if (e.target.value !== undefined) {
      e.target.value = '';
    }
  };

  const handleRemoveAttachment = (actionIndex: number, fileUrl: string) => {
    const action = actions[actionIndex];
    if (!action) return;
    const remaining = getAttachments(action).filter((a) => a.file_url !== fileUrl);
    updateAction(actionIndex, {
      config: { ...action.config, attachments: remaining },
    });
  };

  const handleRemoveUploading = (id: string) => {
    cancelledUploads.current.add(id);
    setPendingUploads((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <div className={styles.actionBuilder}>
      <span className={styles.sectionLabel}>Actions</span>
      <p className={styles.sectionHint}>Define what happens when the automation triggers.</p>

      <div className={styles.actionList}>
        {actions.map((action, index) => {
          const configFields = getConfigFields(action.action_type);
          return (
            <div key={index} className={styles.actionCard}>
              <div className={styles.actionHeader}>
                <div className={styles.actionOrder}>
                  <span className={styles.orderNumber}>{index + 1}</span>
                  <div className={styles.orderButtons}>
                    <button
                      type="button"
                      className={styles.orderButton}
                      onClick={() => moveAction(index, 'up')}
                      disabled={index === 0}
                      aria-label="Move up"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.orderButton}
                      onClick={() => moveAction(index, 'down')}
                      disabled={index === actions.length - 1}
                      aria-label="Move down"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                </div>
                <Select
                  options={ACTION_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                  value={action.action_type}
                  onChange={(e) => updateAction(index, { action_type: e.target.value, config: {} })}
                  className={styles.actionTypeSelect}
                />
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => removeAction(index)}
                  aria-label="Remove action"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              <div className={styles.configFields}>
                {configFields.map((field) => (
                  <div key={field.key} className={styles.configField}>
                    {field.type === 'text' && field.key === 'channel' && (action.action_type === 'post_message' || action.action_type === 'schedule_message') && (
                      <Select
                        id={`${action.action_type}-channel-${index}`}
                        label={field.label}
                        value={(action.config[field.key] as string) || ''}
                        onChange={(e) =>
                          updateAction(index, {
                            config: { ...action.config, [field.key]: e.target.value },
                          })
                        }
                        options={[
                          { value: '__trigger_creator__', label: 'Trigger Creator (DM)' },
                          ...channels.map((c) => ({ value: c.id, label: `# ${c.name}` })),
                          ...dmChannels.map((d) => ({ value: d.id, label: d.label })),
                        ]}
                        placeholder="Choose a channel..."
                      />
                    )}
                    {field.type === 'text' && !(field.key === 'channel' && (action.action_type === 'post_message' || action.action_type === 'schedule_message')) && (
                      <Input
                        id={`${action.action_type}-${field.key}-${index}`}
                        label={field.label}
                        value={(action.config[field.key] as string) || ''}
                        onChange={(e) =>
                          updateAction(index, {
                            config: { ...action.config, [field.key]: e.target.value },
                          })
                        }
                        placeholder={`Enter ${field.label.toLowerCase()}...`}
                      />
                    )}
                    {field.type === 'datetime' && (
                      <Input
                        id={`${action.action_type}-${field.key}-${index}`}
                        label={field.label}
                        type="datetime-local"
                        value={(action.config[field.key] as string) || ''}
                        onChange={(e) =>
                          updateAction(index, {
                            config: { ...action.config, [field.key]: e.target.value },
                          })
                        }
                      />
                    )}
                    {field.type === 'textarea' && (
                      <Textarea
                        id={`${action.action_type}-${field.key}-${index}`}
                        label={field.label}
                        value={(action.config[field.key] as string) || ''}
                        onChange={(e) =>
                          updateAction(index, {
                            config: { ...action.config, [field.key]: e.target.value },
                          })
                        }
                        placeholder={`Enter ${field.label.toLowerCase()}...`}
                        rows={2}
                      />
                    )}
                    {field.type === 'task' && (
                      <TaskSelect
                        label={field.label}
                        value={(action.config.task_id as string) || ''}
                        onChange={(taskId, taskTitle, taskStatus) => {
                          if (taskId) loadTaskStatusOptions(taskId);
                          const next: Record<string, unknown> = {
                            ...action.config,
                            task_id: taskId,
                            task_title: taskTitle || '',
                            task_status: taskStatus || '',
                          };
                          updateAction(index, { config: next });
                        }}
                      />
                    )}
                    {field.type === 'select' && field.options && (
                      <Select
                        id={`${action.action_type}-${field.key}-${index}`}
                        label={field.label}
                        options={
                          action.action_type === 'update_status'
                            ? action.config.task_id && taskStatusOptions[action.config.task_id as string]
                              ? [
                                  { value: 'next', label: 'Next status (flow order)' },
                                  ...taskStatusOptions[action.config.task_id as string],
                                ]
                              : field.options
                            : field.options
                        }
                        value={(action.config[field.key] as string) || ''}
                        onChange={(e) =>
                          updateAction(index, {
                            config: { ...action.config, [field.key]: e.target.value },
                          })
                        }
                        placeholder={`Select ${field.label.toLowerCase()}...`}
                      />
                    )}
                  </div>
                ))}

                {action.action_type === 'update_status' && (action.config.task_status as string) && (
                  <div className={styles.configField}>
                    <span className={styles.currentStatus}>
                      Current status:{' '}
                      {(() => {
                        const taskId = action.config.task_id as string;
                        const raw = action.config.task_status as string;
                        const opts = taskId ? taskStatusOptions[taskId] : null;
                        return opts?.find((o) => o.value === raw)?.label || STATUS_LABELS[raw] || statusLabelMap[raw] || raw;
                      })()}
                    </span>
                  </div>
                )}

                {action.config.assignee === 'specific_user' && (
                  <div className={styles.configField}>
                    <MemberMultiSelect
                      label="Assign To"
                      value={
                        Array.isArray(action.config.assignee_ids)
                          ? (action.config.assignee_ids as string[])
                          : action.config.assignee_id
                            ? [action.config.assignee_id as string]
                            : []
                      }
                      onChange={(ids) =>
                        updateAction(index, {
                          config: {
                            ...action.config,
                            assignee_ids: ids,
                            assignee_id: '',
                          },
                        })
                      }
                    />
                  </div>
                )}

                {action.action_type === 'send_reminder' && (
                  <div className={styles.configFields}>
                    {action.config.target_type === 'user' && (
                      <div className={styles.configField}>
                        <MemberSelect
                          label="Assign To"
                          value={(action.config.target_id as string) || ''}
                          onChange={(userId) =>
                            updateAction(index, {
                              config: { ...action.config, target_id: userId },
                            })
                          }
                        />
                      </div>
                    )}
                    {action.config.target_type === 'channel' && (
                      <div className={styles.configField}>
                        <Select
                          id={`send_reminder-target-channel-${index}`}
                          label="Channel"
                          value={(action.config.target_id as string) || ''}
                          onChange={(e) =>
                            updateAction(index, {
                              config: { ...action.config, target_id: e.target.value },
                            })
                          }
                          options={channels.map((c) => ({ value: c.id, label: `# ${c.name}` }))}
                          placeholder="Choose a channel..."
                        />
                      </div>
                    )}
                    {action.config.target_type === 'dm' && (
                      <div className={styles.configField}>
                        <Select
                          id={`send_reminder-target-dm-${index}`}
                          label="DM Group"
                          value={(action.config.target_id as string) || ''}
                          onChange={(e) =>
                            updateAction(index, {
                              config: { ...action.config, target_id: e.target.value },
                            })
                          }
                          options={dms.map((d) => ({ value: d.id, label: d.label }))}
                          placeholder="Choose a DM..."
                        />
                      </div>
                    )}
                    {(action.config.delay_type || 'minutes') === 'minutes' && (
                      <div className={styles.configField}>
                        <Input
                          label="Delay (minutes)"
                          type="number"
                          value={(action.config.delay_minutes as string) || ''}
                          onChange={(e) =>
                            updateAction(index, {
                              config: { ...action.config, delay_minutes: e.target.value },
                            })
                          }
                          placeholder="e.g., 30"
                        />
                      </div>
                    )}
                    {(action.config.delay_type || 'minutes') === 'specific_time' && (
                      <div className={styles.configField}>
                        <Input
                          label="Time"
                          type="time"
                          value={(action.config.scheduled_time as string) || ''}
                          onChange={(e) =>
                            updateAction(index, {
                              config: { ...action.config, scheduled_time: e.target.value },
                            })
                          }
                        />
                      </div>
                    )}
                    {(action.config.delay_type || 'minutes') === 'specific_day' && (
                      <>
                        <div className={styles.configField}>
                          <Select
                            label="Day of week"
                            value={(action.config.scheduled_day as string) || ''}
                            onChange={(e) =>
                              updateAction(index, {
                                config: { ...action.config, scheduled_day: e.target.value },
                              })
                            }
                            options={[
                              { value: '0', label: 'Sunday' },
                              { value: '1', label: 'Monday' },
                              { value: '2', label: 'Tuesday' },
                              { value: '3', label: 'Wednesday' },
                              { value: '4', label: 'Thursday' },
                              { value: '5', label: 'Friday' },
                              { value: '6', label: 'Saturday' },
                            ]}
                            placeholder="Select day..."
                          />
                        </div>
                        <div className={styles.configField}>
                          <Input
                            label="Time"
                            type="time"
                            value={(action.config.scheduled_time as string) || '09:00'}
                            onChange={(e) =>
                              updateAction(index, {
                                config: { ...action.config, scheduled_time: e.target.value },
                              })
                            }
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {['post_message', 'schedule_message', 'auto_reply'].includes(action.action_type) && (
                <div className={styles.configField}>
                  <div className={styles.attachmentHeader}>
                    <span className={styles.attachmentLabel}>Attachments</span>
                    <label className={styles.attachmentAdd} title="Add files">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                      </svg>
                      Add files
                      <input
                        type="file"
                        multiple
                        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
                        className={styles.fileInput}
                        onChange={(e) => handleFileChange(e, index)}
                      />
                    </label>
                  </div>
                  <UploadProgress
                    files={pendingUploads.filter((f) => f.index === index)}
                    onRemove={handleRemoveUploading}
                  />
                  {getAttachments(action).length > 0 && (
                    <div className={styles.attachmentList}>
                      {getAttachments(action).map((att) => (
                        <div key={att.file_url} className={styles.attachmentItem}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className={styles.attachmentName}>{att.file_name}</span>
                          <span className={styles.attachmentSize}>{formatFileSize(att.file_size)}</span>
                          <button
                            type="button"
                            className={styles.attachmentRemove}
                            onClick={() => handleRemoveAttachment(index, att.file_url)}
                            title="Remove"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button type="button" className={styles.addButton} onClick={addAction}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add Action
      </button>
    </div>
  );
}

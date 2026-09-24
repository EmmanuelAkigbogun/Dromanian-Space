export type UUID = string;

export interface Timestamps {
  created_at: string;
  updated_at: string;
}

export interface User {
  id: UUID;
  email: string;
  username: string;
  avatar_url: string | null;
  status: UserStatus;
}

export type UserStatus = 'online' | 'offline' | 'away' | 'busy';

export interface Workspace {
  id: UUID;
  name: string;
  slug: string;
  description: string | null;
  avatar_url: string | null;
  owner_id: UUID;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
  automation_visibility?: AutomationVisibility;
  automation_visible_members?: UUID[];
}

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type AutomationVisibility = 'own' | 'all' | 'selected';

export type AutomationEditRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface AutomationEditRequest {
  id: UUID;
  rule_id: UUID;
  requester_id: UUID;
  status: AutomationEditRequestStatus;
  created_at: string;
  responded_at: string | null;
  responded_by: UUID | null;
  rule_name: string;
  requester_name: string;
}

export interface Channel {
  id: UUID;
  workspace_id: UUID;
  name: string;
  slug: string;
  description: string | null;
  topic: string | null;
  type: ChannelType;
  is_private: boolean;
  created_by: UUID | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ChannelType = 'text' | 'voice' | 'announcement';

export interface ChannelMember {
  id: UUID;
  channel_id: UUID;
  user_id: UUID;
  role: ChannelRole;
  created_at: string;
}

export type ChannelRole = 'owner' | 'admin' | 'member';

export type LinkDisplayMode = 'text' | 'embed' | 'grid';

export interface Message {
  id: UUID;
  channel_id: UUID;
  user_id: UUID;
  content: string;
  edited_at: string | null;
  deleted_at: string | null;
  parent_id: UUID | null;
  forwarded_from_message_id?: UUID | null;
  created_at: string;
  attachments_layout: string | null;
  link_mode: string | null;
}

export interface FileAttachment {
  id: UUID;
  message_id: UUID;
  user_id: UUID;
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
  created_at: string;
  sort_order?: number;
  workspace_id?: string | null;
}

export interface Reaction {
  id: UUID;
  message_id: UUID;
  user_id: UUID;
  emoji: string;
  created_at: string;
}

export interface Notification {
  id: UUID;
  user_id: UUID;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  link: string | null;
  created_at: string;
}

export type NotificationType = 'mention' | 'message' | 'invitation' | 'system';

export interface PinnedMessage {
  id: UUID;
  channel_id: UUID;
  message_id: UUID;
  pinned_by: UUID;
  created_at: string;
}

export interface SavedMessage {
  id: UUID;
  user_id: UUID;
  message_id: UUID;
  created_at: string;
}

export interface Invitation {
  id: UUID;
  workspace_id: UUID;
  invited_by: UUID;
  email: string;
  user_id: UUID | null;
  role: InvitationRole;
  status: InvitationStatus;
  token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export type JoinRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface WorkspaceInviteLink {
  id: UUID;
  workspace_id: UUID;
  token: string;
  created_by: UUID | null;
  expires_at: string | null;
  created_at: string;
}

export interface WorkspaceJoinRequest {
  id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  status: JoinRequestStatus;
  decided_by: UUID | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  requester_name?: string | null;
  requester_username?: string | null;
  requester_avatar_url?: string | null;
}

export interface WorkspaceInviteLinkInfo {
  found: boolean;
  reason: 'ok' | 'not-found' | 'expired';
  workspace_id?: UUID;
  workspace_name?: string;
  workspace_slug?: string;
  workspace_description?: string | null;
  workspace_avatar_url?: string | null;
  expires_at?: string | null;
  is_member?: boolean;
  request_status?: JoinRequestStatus | null;
}

export type InvitationRole = 'admin' | 'member';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export type { Profile, ProfileRole, ProfileStatus, ProfileUpdate } from './profile';
export type { Task, TaskStatus, TaskPriority, TaskAssignee, TaskLabel, TaskLabelAssignment, TaskComment, TaskActivity, TaskAction } from './task';
export { TASK_STATUS_OPTIONS, TASK_PRIORITY_OPTIONS, getStatusColor, getStatusLabel, getPriorityColor } from './task';

export type ProjectVisibility = 'workspace' | 'members' | 'private';
export type ProjectMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Project {
  id: UUID;
  workspace_id: UUID;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  visibility: ProjectVisibility;
  due_date: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  owner_id: UUID;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectColumn {
  id: UUID;
  project_id: UUID;
  name: string;
  sort_order: number;
  color: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ProjectMember {
  id: UUID;
  project_id: UUID;
  user_id: UUID;
  role: ProjectMemberRole;
  created_at: string;
  updated_at: string;
}

export interface ProjectMilestone {
  id: UUID;
  project_id: UUID;
  created_by?: UUID;
  title: string;
  description: string | null;
  due_date: string | null;
  status: ProjectMilestoneStatus;
  created_at: string;
  updated_at: string;
}

export type ProjectMilestoneStatus = 'pending' | 'in_progress' | 'active' | 'completed' | 'cancelled';

export interface ProjectStats {
  total_tasks: number;
  completed_tasks: number;
  overdue_tasks: number;
  total_members: number;
  progress: number;
}

export interface CalendarEvent {
  id: UUID;
  workspace_id: UUID;
  user_id: UUID;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  color: string | null;
  project_id: UUID | null;
  task_id: UUID | null;
  created_at: string;
  updated_at: string;
}

export interface EventParticipant {
  id: UUID;
  event_id: UUID;
  user_id: UUID;
  status: ParticipantStatus;
  created_at: string;
}

export type ParticipantStatus = 'pending' | 'accepted' | 'declined' | 'tentative';

export interface CalendarReminder {
  id: UUID;
  entity_type: string | null;
  entity_id: UUID | null;
  user_id: UUID;
  title: string;
  message?: string;
  remind_at: string;
  dismissed: boolean;
  notified: boolean;
  completed?: boolean;
  target_type?: string | null;
  target_id?: UUID | null;
  recipients?: UUID[];
  created_at: string;
}

export interface ScheduledMessage {
  id: UUID;
  user_id: UUID;
  channel_id: UUID | null;
  conversation_id: UUID | null;
  content: string;
  scheduled_at: string;
  sent: boolean;
  parent_id?: UUID | null;
  link_mode?: string | null;
  created_at: string;
  attachments?: ScheduledMessageAttachment[];
}

export interface ScheduledMessageAttachment {
  id: UUID;
  scheduled_message_id: UUID;
  user_id: UUID;
  file_name: string;
  file_size: number;
  file_type: string;
  file_url: string;
  created_at: string;
}

export type CalendarViewType = 'day' | 'week' | 'month' | 'agenda';

export interface AutomationRule {
  id: UUID;
  workspace_id: UUID;
  created_by: UUID;
  name: string;
  description: string | null;
  triggers: AutomationTrigger[];
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  enabled: boolean;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationTrigger {
  event_type: string;
  config?: Record<string, unknown>;
}

export interface AutomationCondition {
  field: string;
  operator: ConditionOperator;
  value: string;
  logic?: 'and' | 'or';
}

export type ConditionOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'gte' | 'lte' | 'is_empty' | 'is_not_empty';

export interface AutomationAction {
  action_type: string;
  config: Record<string, unknown>;
  position: number;
}

export interface AutomationExecutionLog {
  id: UUID;
  rule_id: UUID;
  trigger_event: string;
  trigger_entity_id: UUID | null;
  conditions_met: boolean;
  actions_executed: number;
  success: boolean;
  error_message: string | null;
  executed_at: string;
}

export type CallType = 'direct' | 'group' | 'channel';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled';
export type CallParticipantStatus = 'invited' | 'ringing' | 'connected' | 'disconnected' | 'declined' | 'left';

export interface CallSession {
  id: UUID;
  workspace_id: UUID;
  channel_id: UUID | null;
  conversation_id: UUID | null;
  call_type: CallType;
  with_video: boolean;
  status: CallStatus;
  created_by: UUID;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration: number;
  created_at: string;
}

export interface CallParticipant {
  id: UUID;
  call_id: UUID;
  user_id: UUID;
  status: CallParticipantStatus;
  joined_at: string | null;
  left_at: string | null;
  is_muted: boolean;
  created_at: string;
}

export type CallScreen = 'none' | 'incoming' | 'outgoing' | 'active' | 'ended';

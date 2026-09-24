-- ==================== 000_EVERYTHING_RUN_ME.sql ====================
-- ============================================================
-- DARK-SPACE: COMPLETE CONSOLIDATED SQL
-- All tables, RLS, functions, indexes, triggers, RPCs
-- Run this ONCE on a fresh Supabase project
-- ============================================================

-- ============================================================
-- SECTION 1: ALL TABLES
-- Tables come first so functions/policies can reference them
-- ============================================================

-- PROFILES
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  username TEXT UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status TEXT DEFAULT 'active',
  onboarding_completed BOOLEAN DEFAULT false,
  last_active_at TIMESTAMPTZ DEFAULT now(),
  presence_status TEXT DEFAULT 'offline' CHECK (presence_status IN ('online', 'away', 'busy', 'invisible', 'offline')),
  manual_status TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- WORKSPACES
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

-- WORKSPACE_MEMBERS
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- INVITATIONS
CREATE TABLE IF NOT EXISTS invitations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, email)
);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- CHANNELS
CREATE TABLE IF NOT EXISTS channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  topic TEXT,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice', 'announcement')),
  is_private BOOLEAN DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, slug)
);
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

-- CHANNEL_MEMBERS
CREATE TABLE IF NOT EXISTS channel_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  last_read_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_id, user_id)
);
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;

-- MESSAGES
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  parent_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN DEFAULT false,
  category TEXT DEFAULT 'system',
  entity_type TEXT,
  entity_id UUID,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- PINNED_MESSAGES
CREATE TABLE IF NOT EXISTS pinned_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_id, message_id)
);
ALTER TABLE pinned_messages ENABLE ROW LEVEL SECURITY;

-- SAVED_MESSAGES
CREATE TABLE IF NOT EXISTS saved_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, message_id)
);
ALTER TABLE saved_messages ENABLE ROW LEVEL SECURITY;

-- REACTIONS
CREATE TABLE IF NOT EXISTS reactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(message_id, user_id, emoji)
);
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- FILE_ATTACHMENTS
CREATE TABLE IF NOT EXISTS file_attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  sort_order INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE file_attachments ENABLE ROW LEVEL SECURITY;

-- MESSAGE_VERSIONS
CREATE TABLE IF NOT EXISTS message_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE message_versions ENABLE ROW LEVEL SECURITY;

-- DIRECT_CONVERSATIONS
CREATE TABLE IF NOT EXISTS direct_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'dm' CHECK (type IN ('dm', 'group')),
  name TEXT,
  avatar_url TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, channel_id)
);
ALTER TABLE direct_conversations ENABLE ROW LEVEL SECURITY;

-- DIRECT_CONVERSATION_PARTICIPANTS
CREATE TABLE IF NOT EXISTS direct_conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, user_id)
);
ALTER TABLE direct_conversation_participants ENABLE ROW LEVEL SECURITY;

-- MESSAGE_READ_RECEIPTS
CREATE TABLE IF NOT EXISTS message_read_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(message_id, user_id)
);
ALTER TABLE message_read_receipts ENABLE ROW LEVEL SECURITY;

-- NOTIFICATION_PREFERENCES
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  in_app BOOLEAN DEFAULT true,
  browser BOOLEAN DEFAULT false,
  email BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, category)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- TASKS
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  project_id UUID,
  column_id UUID,
  milestone_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'completed', 'cancelled')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMPTZ,
  start_date TIMESTAMPTZ,
  sort_order INTEGER DEFAULT 0,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- TASK_ASSIGNEES
CREATE TABLE IF NOT EXISTS task_assignees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  assigned_by UUID REFERENCES auth.users(id),
  UNIQUE(task_id, user_id)
);
ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;

-- TASK_COMMENTS
CREATE TABLE IF NOT EXISTS task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES task_comments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;

-- TASK_LABELS
CREATE TABLE IF NOT EXISTS task_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, name)
);
ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;

-- TASK_LABEL_ASSIGNMENTS
CREATE TABLE IF NOT EXISTS task_label_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(task_id, label_id)
);
ALTER TABLE task_label_assignments ENABLE ROW LEVEL SECURITY;

-- TASK_ACTIVITY
CREATE TABLE IF NOT EXISTS task_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  description TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE task_activity ENABLE ROW LEVEL SECURITY;

-- PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '📋',
  color TEXT DEFAULT '#6366f1',
  owner_id UUID NOT NULL REFERENCES auth.users(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  due_date TIMESTAMPTZ,
  visibility TEXT DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'members', 'private')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- PROJECT_MEMBERS
CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, user_id)
);
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;

-- PROJECT_COLUMNS
CREATE TABLE IF NOT EXISTS project_columns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE project_columns ENABLE ROW LEVEL SECURITY;

-- PROJECT_MILESTONES
CREATE TABLE IF NOT EXISTS project_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  status TEXT DEFAULT 'active' CHECK (status IN ('pending', 'in_progress', 'active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;

-- FK constraints from tasks to projects (after both tables exist)
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT fk_tasks_column FOREIGN KEY (column_id) REFERENCES project_columns(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT fk_tasks_milestone FOREIGN KEY (milestone_id) REFERENCES project_milestones(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- FK: task_assignees.user_id -> profiles (needed for PostgREST nested joins)
DO $$ BEGIN
  ALTER TABLE task_assignees
    ADD CONSTRAINT fk_task_assignees_profile
    FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CALENDAR_EVENTS
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN DEFAULT false,
  location TEXT,
  color TEXT DEFAULT '#6366f1',
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- EVENT_PARTICIPANTS
CREATE TABLE IF NOT EXISTS event_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(event_id, user_id)
);
ALTER TABLE event_participants ENABLE ROW LEVEL SECURITY;

-- REMINDERS
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'event', 'milestone', 'message', 'custom')),
  entity_id UUID,
  title TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  notified BOOLEAN DEFAULT false,
  dismissed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

-- SCHEDULED_MESSAGES
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES direct_conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

-- AUTOMATION_RULES
CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

-- AUTOMATION_TRIGGERS
CREATE TABLE IF NOT EXISTS automation_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE automation_triggers ENABLE ROW LEVEL SECURITY;

-- AUTOMATION_CONDITIONS
CREATE TABLE IF NOT EXISTS automation_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('equals', 'not_equals', 'contains', 'not_contains', 'gt', 'lt', 'gte', 'lte', 'greater_than', 'less_than', 'is_empty', 'is_not_empty')),
  value TEXT NOT NULL DEFAULT '',
  logic TEXT DEFAULT 'and' CHECK (logic IN ('and', 'or')),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE automation_conditions ENABLE ROW LEVEL SECURITY;

-- AUTOMATION_ACTIONS
CREATE TABLE IF NOT EXISTS automation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('notification', 'send_notification', 'assign_task', 'update_status', 'move_task', 'add_label', 'post_message', 'send_reminder', 'create_task', 'create_event')),
  config JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE automation_actions ENABLE ROW LEVEL SECURITY;

-- AUTOMATION_EXECUTION_LOGS
CREATE TABLE IF NOT EXISTS automation_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL,
  trigger_entity_id UUID,
  conditions_met BOOLEAN NOT NULL DEFAULT false,
  actions_executed INTEGER DEFAULT 0,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  executed_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE automation_execution_logs ENABLE ROW LEVEL SECURITY;

-- USER_FAVORITES
CREATE TABLE IF NOT EXISTS user_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('channel', 'conversation', 'message')),
  entity_id UUID NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, entity_type, entity_id)
);
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;

-- USER_DRAFTS (with UNIQUE constraints for upsert)
CREATE TABLE IF NOT EXISTS user_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES direct_conversations(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, channel_id),
  UNIQUE(user_id, conversation_id),
  UNIQUE(user_id, thread_id)
);
ALTER TABLE user_drafts ENABLE ROW LEVEL SECURITY;

-- RECENT_ACTIVITY
CREATE TABLE IF NOT EXISTS recent_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  entity_name TEXT,
  entity_url TEXT,
  accessed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, entity_type, entity_id)
);
ALTER TABLE recent_activity ENABLE ROW LEVEL SECURITY;

-- USER_MENTIONS
CREATE TABLE IF NOT EXISTS user_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE user_mentions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- SECTION 2: ALL INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_presence ON profiles(presence_status);
CREATE INDEX IF NOT EXISTS idx_profiles_last_active ON profiles(last_active_at);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON workspaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace_id ON invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_user_id ON invitations(user_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token_status ON invitations(token, status);
CREATE INDEX IF NOT EXISTS idx_channels_workspace_id ON channels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_channels_slug ON channels(workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel_id ON channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_last_read ON channel_members(user_id, channel_id, last_read_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(category);
CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pinned_messages_channel ON pinned_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_saved_messages_user ON saved_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message_emoji ON reactions(message_id, emoji);
CREATE INDEX IF NOT EXISTS idx_file_attachments_message_id ON file_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_versions_message ON message_versions(message_id);
CREATE INDEX IF NOT EXISTS idx_direct_conv_workspace ON direct_conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_direct_conv_channel ON direct_conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_direct_conv_participants_conv ON direct_conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_direct_conv_participants_user ON direct_conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_read_receipts_message ON message_read_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_read_receipts_user ON message_read_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks(archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(project_id, sort_order) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_created ON task_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_labels_workspace ON task_labels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_project_columns_project ON project_columns(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_workspace ON automation_rules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_rule ON automation_triggers(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_conditions_rule ON automation_conditions(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_actions_rule ON automation_actions(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_rule ON automation_execution_logs(rule_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_workspace ON calendar_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(remind_at) WHERE notified = false AND dismissed = false;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending ON scheduled_messages(scheduled_at) WHERE sent = false;
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_recent_activity_user ON recent_activity(user_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_mentions_user ON user_mentions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_mentions_unread ON user_mentions(user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS idx_automation_triggers_event ON automation_triggers(event_type);
CREATE INDEX IF NOT EXISTS idx_automation_logs_executed ON automation_execution_logs(executed_at DESC);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_messages_content_fts ON messages USING gin(to_tsvector('english', coalesce(content, '')));
CREATE INDEX IF NOT EXISTS idx_channels_name_fts ON channels USING gin(to_tsvector('english', name));
CREATE INDEX IF NOT EXISTS idx_profiles_name_fts ON profiles USING gin(to_tsvector('english', coalesce(display_name, '') || ' ' || coalesce(username, '')));

-- ============================================================
-- SECTION 3: SECURITY DEFINER HELPER FUNCTIONS
-- All tables now exist, so these will create cleanly
-- ============================================================

-- Workspace membership checks
CREATE OR REPLACE FUNCTION public.user_is_workspace_member(p_workspace_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.user_is_workspace_admin(p_workspace_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_user_id AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Aliases used by task/project policies
CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT public.user_is_workspace_member(p_workspace_id, p_user_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_workspace_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT public.user_is_workspace_admin(p_workspace_id, p_user_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Channel membership check (breaks RLS recursion)
CREATE OR REPLACE FUNCTION public.user_is_channel_member(p_channel_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM channel_members
    WHERE channel_id = p_channel_id AND user_id = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Task helpers
CREATE OR REPLACE FUNCTION public.is_workspace_member_for_task(p_task_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = p_task_id
      AND EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = t.workspace_id AND wm.user_id = p_user_id
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_task_assignee(p_task_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_assignees WHERE task_id = p_task_id AND user_id = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_task_creator(p_task_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM tasks WHERE id = p_task_id AND created_by = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Project helpers
CREATE OR REPLACE FUNCTION public.get_project_workspace_id(p_project_id UUID)
RETURNS UUID AS $$
  SELECT workspace_id FROM projects WHERE id = p_project_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects WHERE id = p_project_id AND owner_id = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_project_admin(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = p_project_id AND user_id = p_user_id AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = p_project_id AND user_id = p_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Trigger helper
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SECTION 4: ALL RLS POLICIES
-- ============================================================

-- Profiles
DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

CREATE POLICY "profiles_select_scoped" ON profiles FOR SELECT TO authenticated
  USING (
    auth.uid() = id
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm1
      JOIN workspace_members wm2 ON wm2.workspace_id = wm1.workspace_id
      WHERE wm1.user_id = auth.uid()
        AND wm2.user_id = profiles.id
    )
  );
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Authenticated-only email -> id lookup used by the invite flow.
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email TEXT)
RETURNS TABLE (user_id UUID) AS $$
  SELECT id FROM profiles WHERE lower(email) = lower(p_email) LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) TO authenticated;

-- Workspaces
DROP POLICY IF EXISTS "workspaces_select" ON workspaces;
DROP POLICY IF EXISTS "workspaces_insert" ON workspaces;
DROP POLICY IF EXISTS "workspaces_update" ON workspaces;
DROP POLICY IF EXISTS "workspaces_delete" ON workspaces;
DROP POLICY IF EXISTS "ws_select" ON workspaces;
DROP POLICY IF EXISTS "ws_insert" ON workspaces;
DROP POLICY IF EXISTS "ws_update" ON workspaces;
DROP POLICY IF EXISTS "ws_delete" ON workspaces;

CREATE POLICY "ws_select" ON workspaces FOR SELECT USING (
  auth.uid() = owner_id OR public.user_is_workspace_member(id, auth.uid())
);
CREATE POLICY "ws_insert" ON workspaces FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "ws_update" ON workspaces FOR UPDATE USING (
  auth.uid() = owner_id OR public.user_is_workspace_admin(id, auth.uid())
);
CREATE POLICY "ws_delete" ON workspaces FOR DELETE USING (auth.uid() = owner_id);

-- Workspace members
DROP POLICY IF EXISTS "workspace_members_select_own" ON workspace_members;
DROP POLICY IF EXISTS "workspace_members_select" ON workspace_members;
DROP POLICY IF EXISTS "workspace_members_insert" ON workspace_members;
DROP POLICY IF EXISTS "workspace_members_delete_own" ON workspace_members;
DROP POLICY IF EXISTS "insert_workspace_admins" ON workspace_members;
DROP POLICY IF EXISTS "update_workspace_admins" ON workspace_members;
DROP POLICY IF EXISTS "delete_workspace_admins" ON workspace_members;
DROP POLICY IF EXISTS "wm_select" ON workspace_members;
DROP POLICY IF EXISTS "wm_insert" ON workspace_members;
DROP POLICY IF EXISTS "wm_update" ON workspace_members;
DROP POLICY IF EXISTS "wm_delete" ON workspace_members;

CREATE POLICY "wm_select" ON workspace_members FOR SELECT
  USING (public.user_is_workspace_member(workspace_members.workspace_id, auth.uid()));
CREATE POLICY "wm_insert" ON workspace_members FOR INSERT
  WITH CHECK (
    public.user_is_workspace_admin(workspace_members.workspace_id, auth.uid())
    OR (user_id = auth.uid() AND NOT EXISTS (
      SELECT 1 FROM workspace_members AS existing
      WHERE existing.workspace_id = workspace_members.workspace_id
    ))
  );
CREATE POLICY "wm_update" ON workspace_members FOR UPDATE
  USING (public.user_is_workspace_admin(workspace_members.workspace_id, auth.uid()));
CREATE POLICY "wm_delete" ON workspace_members FOR DELETE
  USING (
    public.user_is_workspace_admin(workspace_members.workspace_id, auth.uid())
    OR user_id = auth.uid()
  );

-- Invitations
DROP POLICY IF EXISTS "inv_select" ON invitations;
DROP POLICY IF EXISTS "inv_insert" ON invitations;
DROP POLICY IF EXISTS "inv_update" ON invitations;
DROP POLICY IF EXISTS "inv_delete" ON invitations;
DROP POLICY IF EXISTS "invitations_select_members" ON invitations;
DROP POLICY IF EXISTS "invitations_insert_admins" ON invitations;
DROP POLICY IF EXISTS "invitations_update_admins" ON invitations;
DROP POLICY IF EXISTS "invitations_delete_admins" ON invitations;
DROP POLICY IF EXISTS "invitations_select" ON invitations;

CREATE POLICY "inv_select" ON invitations FOR SELECT TO authenticated USING (
  public.user_is_workspace_member(invitations.workspace_id, auth.uid())
  OR lower(invitations.email) = lower(auth.email())
);
CREATE POLICY "inv_insert" ON invitations FOR INSERT TO authenticated
  WITH CHECK (public.user_is_workspace_admin(invitations.workspace_id, auth.uid()));
CREATE POLICY "inv_update" ON invitations FOR UPDATE TO authenticated
  USING (public.user_is_workspace_admin(invitations.workspace_id, auth.uid()));
CREATE POLICY "inv_delete" ON invitations FOR DELETE TO authenticated
  USING (public.user_is_workspace_admin(invitations.workspace_id, auth.uid()));

-- Channels
DROP POLICY IF EXISTS "channels_select_public" ON channels;
DROP POLICY IF EXISTS "channels_select_private" ON channels;
DROP POLICY IF EXISTS "channels_select_own_created" ON channels;
DROP POLICY IF EXISTS "channels_insert" ON channels;
DROP POLICY IF EXISTS "channels_update" ON channels;
DROP POLICY IF EXISTS "channels_delete" ON channels;

CREATE POLICY "channels_select_public" ON channels FOR SELECT USING (
  is_private = false
  AND public.user_is_workspace_member(channels.workspace_id, auth.uid())
);
CREATE POLICY "channels_select_private" ON channels FOR SELECT USING (
  is_private = true AND public.user_is_channel_member(channels.id, auth.uid())
);
CREATE POLICY "channels_select_own_created" ON channels FOR SELECT USING (created_by = auth.uid());
CREATE POLICY "channels_insert" ON channels FOR INSERT WITH CHECK (
  public.user_is_workspace_member(channels.workspace_id, auth.uid())
);
CREATE POLICY "channels_update" ON channels FOR UPDATE USING (
  created_by = auth.uid() OR public.user_is_workspace_admin(channels.workspace_id, auth.uid())
);
CREATE POLICY "channels_delete" ON channels FOR DELETE USING (
  created_by = auth.uid() OR public.user_is_workspace_admin(channels.workspace_id, auth.uid())
);

-- Channel members
DROP POLICY IF EXISTS "channel_members_select" ON channel_members;
DROP POLICY IF EXISTS "channel_members_insert" ON channel_members;
DROP POLICY IF EXISTS "channel_members_delete" ON channel_members;

CREATE POLICY "channel_members_select" ON channel_members FOR SELECT USING (
  public.user_is_channel_member(channel_members.channel_id, auth.uid())
  OR public.user_is_workspace_member(
    (SELECT workspace_id FROM channels WHERE id = channel_members.channel_id), auth.uid()
  )
);
CREATE POLICY "channel_members_insert" ON channel_members FOR INSERT WITH CHECK (
  (user_id = auth.uid() AND NOT EXISTS (SELECT 1 FROM channels WHERE id = channel_members.channel_id AND is_private = true))
  OR channel_members.channel_id IN (SELECT id FROM channels WHERE created_by = auth.uid())
  OR public.user_is_workspace_admin(
    (SELECT workspace_id FROM channels WHERE id = channel_members.channel_id), auth.uid()
  )
);
CREATE POLICY "channel_members_delete" ON channel_members FOR DELETE USING (
  user_id = auth.uid()
  OR channel_members.channel_id IN (SELECT id FROM channels WHERE created_by = auth.uid())
  OR public.user_is_workspace_admin(
    (SELECT workspace_id FROM channels WHERE id = channel_members.channel_id), auth.uid()
  )
);

-- Messages
DROP POLICY IF EXISTS "messages_select" ON messages;
DROP POLICY IF EXISTS "messages_insert" ON messages;
DROP POLICY IF EXISTS "messages_update" ON messages;
DROP POLICY IF EXISTS "messages_delete" ON messages;

CREATE POLICY "messages_select" ON messages FOR SELECT USING (
  public.user_is_channel_member(messages.channel_id, auth.uid())
);
CREATE POLICY "messages_insert" ON messages FOR INSERT WITH CHECK (
  auth.uid() = user_id AND public.user_is_channel_member(messages.channel_id, auth.uid())
);
CREATE POLICY "messages_update" ON messages FOR UPDATE USING (
  auth.uid() = user_id OR public.user_is_channel_member(messages.channel_id, auth.uid())
);
CREATE POLICY "messages_delete" ON messages FOR DELETE USING (auth.uid() = user_id);

-- Notifications
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON notifications;

CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "System can insert notifications" ON notifications FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own notifications" ON notifications FOR DELETE USING (auth.uid() = user_id);

-- Pinned messages
DROP POLICY IF EXISTS "pinned_messages_select" ON pinned_messages;
DROP POLICY IF EXISTS "pinned_messages_insert" ON pinned_messages;
DROP POLICY IF EXISTS "pinned_messages_delete" ON pinned_messages;

CREATE POLICY "pinned_messages_select" ON pinned_messages FOR SELECT TO authenticated USING (
  public.user_is_channel_member(pinned_messages.channel_id, auth.uid())
);
CREATE POLICY "pinned_messages_insert" ON pinned_messages FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = pinned_by AND public.user_is_channel_member(pinned_messages.channel_id, auth.uid())
);
CREATE POLICY "pinned_messages_delete" ON pinned_messages FOR DELETE TO authenticated USING (
  public.user_is_channel_member(pinned_messages.channel_id, auth.uid())
);

-- Saved messages
DROP POLICY IF EXISTS "saved_messages_select" ON saved_messages;
DROP POLICY IF EXISTS "saved_messages_insert" ON saved_messages;
DROP POLICY IF EXISTS "saved_messages_delete" ON saved_messages;

CREATE POLICY "saved_messages_select" ON saved_messages FOR SELECT TO authenticated USING (auth.uid() = saved_messages.user_id);
CREATE POLICY "saved_messages_insert" ON saved_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = saved_messages.user_id);
CREATE POLICY "saved_messages_delete" ON saved_messages FOR DELETE TO authenticated USING (auth.uid() = saved_messages.user_id);

-- Reactions
DROP POLICY IF EXISTS "reactions_select" ON reactions;
DROP POLICY IF EXISTS "reactions_insert" ON reactions;
DROP POLICY IF EXISTS "reactions_delete" ON reactions;

CREATE POLICY "reactions_select" ON reactions FOR SELECT TO authenticated USING (
  public.user_is_channel_member(
    (SELECT m.channel_id FROM messages m WHERE m.id = reactions.message_id), auth.uid()
  )
);
CREATE POLICY "reactions_insert" ON reactions FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = user_id AND public.user_is_channel_member(
    (SELECT m.channel_id FROM messages m WHERE m.id = reactions.message_id), auth.uid()
  )
);
CREATE POLICY "reactions_delete" ON reactions FOR DELETE USING (auth.uid() = user_id);

-- File attachments
DROP POLICY IF EXISTS "file_attachments_select" ON file_attachments;
DROP POLICY IF EXISTS "file_attachments_insert" ON file_attachments;
DROP POLICY IF EXISTS "file_attachments_delete" ON file_attachments;
DROP POLICY IF EXISTS "Channel members can view attachments" ON file_attachments;
DROP POLICY IF EXISTS "Channel members can insert attachments" ON file_attachments;
DROP POLICY IF EXISTS "Users can delete own attachments" ON file_attachments;

CREATE POLICY "file_attachments_select" ON file_attachments FOR SELECT USING (
  auth.uid() = user_id
  OR public.user_is_channel_member(
    (SELECT m.channel_id FROM messages m WHERE m.id = file_attachments.message_id), auth.uid()
  )
);
CREATE POLICY "file_attachments_insert" ON file_attachments FOR INSERT WITH CHECK (
  auth.uid() = user_id AND public.user_is_channel_member(
    (SELECT m.channel_id FROM messages m WHERE m.id = file_attachments.message_id), auth.uid()
  )
);
CREATE POLICY "file_attachments_delete" ON file_attachments FOR DELETE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own attachments" ON file_attachments;
CREATE POLICY "Users can update own attachments" ON file_attachments
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Message versions
DROP POLICY IF EXISTS "message_versions_select" ON message_versions;
CREATE POLICY "message_versions_select" ON message_versions FOR SELECT USING (
  public.user_is_channel_member(
    (SELECT m.channel_id FROM messages m WHERE m.id = message_versions.message_id), auth.uid()
  )
);

-- Direct conversations
DROP POLICY IF EXISTS "direct_conversations_select" ON direct_conversations;
DROP POLICY IF EXISTS "direct_conversations_insert" ON direct_conversations;
DROP POLICY IF EXISTS "direct_conversations_update" ON direct_conversations;
DROP POLICY IF EXISTS "direct_conversations_delete" ON direct_conversations;
CREATE POLICY "direct_conversations_select" ON direct_conversations FOR SELECT USING (
  public.user_is_workspace_member(direct_conversations.workspace_id, auth.uid())
);
CREATE POLICY "direct_conversations_insert" ON direct_conversations FOR INSERT WITH CHECK (
  public.user_is_workspace_member(direct_conversations.workspace_id, auth.uid())
);
CREATE POLICY "direct_conversations_update" ON direct_conversations FOR UPDATE USING (created_by = auth.uid());

-- Direct conversation participants
DROP POLICY IF EXISTS "direct_conv_participants_select" ON direct_conversation_participants;
DROP POLICY IF EXISTS "direct_conv_participants_insert" ON direct_conversation_participants;
DROP POLICY IF EXISTS "direct_conv_participants_delete" ON direct_conversation_participants;
CREATE POLICY "direct_conv_participants_select" ON direct_conversation_participants FOR SELECT USING (
  public.user_is_workspace_member(
    (SELECT workspace_id FROM direct_conversations WHERE id = direct_conversation_participants.conversation_id), auth.uid()
  )
);
CREATE POLICY "direct_conv_participants_insert" ON direct_conversation_participants FOR INSERT WITH CHECK (
  direct_conversation_participants.conversation_id IN (
    SELECT id FROM direct_conversations WHERE created_by = auth.uid()
  )
);
CREATE POLICY "direct_conv_participants_delete" ON direct_conversation_participants FOR DELETE USING (
  user_id = auth.uid() OR direct_conversation_participants.conversation_id IN (
    SELECT id FROM direct_conversations WHERE created_by = auth.uid()
  )
);

-- Read receipts
DROP POLICY IF EXISTS "Users can view read receipts for accessible messages" ON message_read_receipts;
DROP POLICY IF EXISTS "Users can insert own read receipts" ON message_read_receipts;
CREATE POLICY "Users can view read receipts for accessible messages" ON message_read_receipts FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = auth.uid()
    WHERE m.id = message_read_receipts.message_id
  )
);
CREATE POLICY "Users can insert own read receipts" ON message_read_receipts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Notification preferences
DROP POLICY IF EXISTS "Users can manage own notification preferences" ON notification_preferences;
CREATE POLICY "Users can manage own notification preferences" ON notification_preferences FOR ALL USING (auth.uid() = user_id);

-- Tasks
DROP POLICY IF EXISTS "tasks_select" ON tasks;
DROP POLICY IF EXISTS "tasks_insert" ON tasks;
DROP POLICY IF EXISTS "tasks_update" ON tasks;
DROP POLICY IF EXISTS "tasks_delete" ON tasks;
CREATE POLICY "tasks_select" ON tasks FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "tasks_insert" ON tasks FOR INSERT WITH CHECK (auth.uid() = created_by AND is_workspace_member(workspace_id));
CREATE POLICY "tasks_update" ON tasks FOR UPDATE USING (auth.uid() = created_by OR is_task_assignee(id) OR is_workspace_admin(workspace_id));
CREATE POLICY "tasks_delete" ON tasks FOR DELETE USING (auth.uid() = created_by OR is_workspace_admin(workspace_id));

-- Task assignees
DROP POLICY IF EXISTS "task_assignees_select" ON task_assignees;
DROP POLICY IF EXISTS "task_assignees_insert" ON task_assignees;
DROP POLICY IF EXISTS "task_assignees_delete" ON task_assignees;
CREATE POLICY "task_assignees_select" ON task_assignees FOR SELECT USING (is_workspace_member_for_task(task_id));
CREATE POLICY "task_assignees_insert" ON task_assignees FOR INSERT WITH CHECK (
  is_task_creator(task_id) OR is_workspace_admin((SELECT workspace_id FROM tasks WHERE id = task_id))
);
CREATE POLICY "task_assignees_delete" ON task_assignees FOR DELETE USING (
  is_task_creator(task_id) OR is_workspace_admin((SELECT workspace_id FROM tasks WHERE id = task_id))
);

-- Task comments
DROP POLICY IF EXISTS "task_comments_select" ON task_comments;
DROP POLICY IF EXISTS "task_comments_insert" ON task_comments;
DROP POLICY IF EXISTS "task_comments_update" ON task_comments;
DROP POLICY IF EXISTS "task_comments_delete" ON task_comments;
CREATE POLICY "task_comments_select" ON task_comments FOR SELECT USING (is_workspace_member_for_task(task_id));
CREATE POLICY "task_comments_insert" ON task_comments FOR INSERT WITH CHECK (auth.uid() = user_id AND is_workspace_member_for_task(task_id));
CREATE POLICY "task_comments_update" ON task_comments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "task_comments_delete" ON task_comments FOR DELETE USING (auth.uid() = user_id);

-- Task labels
DROP POLICY IF EXISTS "task_labels_select" ON task_labels;
DROP POLICY IF EXISTS "task_labels_all" ON task_labels;
CREATE POLICY "task_labels_select" ON task_labels FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "task_labels_all" ON task_labels FOR ALL USING (is_workspace_admin(workspace_id));

-- Task label assignments
DROP POLICY IF EXISTS "task_label_assignments_all" ON task_label_assignments;
CREATE POLICY "task_label_assignments_all" ON task_label_assignments FOR ALL USING (is_workspace_member_for_task(task_id));

-- Task activity
DROP POLICY IF EXISTS "task_activity_select" ON task_activity;
DROP POLICY IF EXISTS "task_activity_insert" ON task_activity;
CREATE POLICY "task_activity_select" ON task_activity FOR SELECT USING (is_workspace_member_for_task(task_id));
CREATE POLICY "task_activity_insert" ON task_activity FOR INSERT WITH CHECK (true);

-- Projects
DROP POLICY IF EXISTS "projects_select" ON projects;
DROP POLICY IF EXISTS "projects_insert" ON projects;
DROP POLICY IF EXISTS "projects_update" ON projects;
DROP POLICY IF EXISTS "projects_delete" ON projects;
CREATE POLICY "projects_select" ON projects FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "projects_insert" ON projects FOR INSERT WITH CHECK (auth.uid() = owner_id AND is_workspace_member(workspace_id));
CREATE POLICY "projects_update" ON projects FOR UPDATE USING (auth.uid() = owner_id OR is_project_admin(id) OR is_workspace_admin(workspace_id));
CREATE POLICY "projects_delete" ON projects FOR DELETE USING (auth.uid() = owner_id OR is_workspace_admin(workspace_id));

-- Project members
DROP POLICY IF EXISTS "project_members_select" ON project_members;
DROP POLICY IF EXISTS "project_members_all" ON project_members;
CREATE POLICY "project_members_select" ON project_members FOR SELECT USING (is_workspace_member(get_project_workspace_id(project_id)));
CREATE POLICY "project_members_all" ON project_members FOR ALL USING (is_project_owner(project_id) OR is_workspace_admin(get_project_workspace_id(project_id)));

-- Project columns
DROP POLICY IF EXISTS "project_columns_select" ON project_columns;
DROP POLICY IF EXISTS "project_columns_all" ON project_columns;
CREATE POLICY "project_columns_select" ON project_columns FOR SELECT USING (is_workspace_member(get_project_workspace_id(project_id)));
CREATE POLICY "project_columns_all" ON project_columns FOR ALL USING (is_project_admin(project_id) OR is_workspace_admin(get_project_workspace_id(project_id)));

-- Project milestones
DROP POLICY IF EXISTS "project_milestones_select" ON project_milestones;
DROP POLICY IF EXISTS "project_milestones_all" ON project_milestones;
CREATE POLICY "project_milestones_select" ON project_milestones FOR SELECT USING (is_workspace_member(get_project_workspace_id(project_id)));
CREATE POLICY "project_milestones_all" ON project_milestones FOR ALL USING (is_project_member(project_id) OR is_workspace_admin(get_project_workspace_id(project_id)));

-- Calendar events
DROP POLICY IF EXISTS "calendar_events_select" ON calendar_events;
DROP POLICY IF EXISTS "calendar_events_insert" ON calendar_events;
DROP POLICY IF EXISTS "calendar_events_update" ON calendar_events;
DROP POLICY IF EXISTS "calendar_events_delete" ON calendar_events;
CREATE POLICY "calendar_events_select" ON calendar_events FOR SELECT USING (is_workspace_member(workspace_id));
CREATE POLICY "calendar_events_insert" ON calendar_events FOR INSERT WITH CHECK (auth.uid() = user_id AND is_workspace_member(workspace_id));
CREATE POLICY "calendar_events_update" ON calendar_events FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "calendar_events_delete" ON calendar_events FOR DELETE USING (auth.uid() = user_id);

-- Event participants
DROP POLICY IF EXISTS "event_participants_select" ON event_participants;
DROP POLICY IF EXISTS "event_participants_all" ON event_participants;
CREATE POLICY "event_participants_select" ON event_participants FOR SELECT USING (
  EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = event_participants.event_id AND ce.user_id = auth.uid())
  OR is_workspace_member((SELECT workspace_id FROM calendar_events WHERE id = event_participants.event_id))
);
CREATE POLICY "event_participants_all" ON event_participants FOR ALL USING (
  EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = event_participants.event_id AND ce.user_id = auth.uid())
);

-- Reminders
DROP POLICY IF EXISTS "Users can manage own reminders" ON reminders;
DROP POLICY IF EXISTS "users_manage_own_reminders" ON reminders;
CREATE POLICY "users_manage_own_reminders" ON reminders FOR ALL USING (auth.uid() = user_id);

-- Scheduled messages
DROP POLICY IF EXISTS "Users can manage own scheduled messages" ON scheduled_messages;
DROP POLICY IF EXISTS "users_manage_own_scheduled_messages" ON scheduled_messages;
CREATE POLICY "users_manage_own_scheduled_messages" ON scheduled_messages FOR ALL USING (auth.uid() = user_id);

-- Automation rules: workspace admin/owner only
DROP POLICY IF EXISTS "Admins can view automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can create automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can update automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can delete automation rules" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_select" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_insert" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_update" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_delete" ON automation_rules;

CREATE POLICY "automation_rules_select" ON automation_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
);
CREATE POLICY "automation_rules_insert" ON automation_rules FOR INSERT WITH CHECK (
  auth.uid() = created_by AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
);
CREATE POLICY "automation_rules_update" ON automation_rules FOR UPDATE USING (
  EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
);
CREATE POLICY "automation_rules_delete" ON automation_rules FOR DELETE USING (
  EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
);

-- Automation sub-tables
DROP POLICY IF EXISTS "Admins can manage triggers" ON automation_triggers;
DROP POLICY IF EXISTS "Admins can manage conditions" ON automation_conditions;
DROP POLICY IF EXISTS "Admins can manage actions" ON automation_actions;
DROP POLICY IF EXISTS "Admins can view execution logs" ON automation_execution_logs;
DROP POLICY IF EXISTS "System can insert execution logs" ON automation_execution_logs;
DROP POLICY IF EXISTS "automation_triggers_all" ON automation_triggers;
DROP POLICY IF EXISTS "automation_conditions_all" ON automation_conditions;
DROP POLICY IF EXISTS "automation_actions_all" ON automation_actions;
DROP POLICY IF EXISTS "automation_logs_select" ON automation_execution_logs;
DROP POLICY IF EXISTS "automation_logs_insert" ON automation_execution_logs;

CREATE POLICY "automation_triggers_all" ON automation_triggers FOR ALL USING (
  EXISTS (
    SELECT 1 FROM automation_rules ar
    JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    WHERE ar.id = automation_triggers.rule_id
  )
);
CREATE POLICY "automation_conditions_all" ON automation_conditions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM automation_rules ar
    JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    WHERE ar.id = automation_conditions.rule_id
  )
);
CREATE POLICY "automation_actions_all" ON automation_actions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM automation_rules ar
    JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    WHERE ar.id = automation_actions.rule_id
  )
);
CREATE POLICY "automation_logs_select" ON automation_execution_logs FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM automation_rules ar
    JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
    WHERE ar.id = automation_execution_logs.rule_id
  )
);
CREATE POLICY "automation_logs_insert" ON automation_execution_logs FOR INSERT WITH CHECK (true);

-- Productivity
DROP POLICY IF EXISTS "Users can manage own favorites" ON user_favorites;
DROP POLICY IF EXISTS "Users can manage own drafts" ON user_drafts;
DROP POLICY IF EXISTS "Users can manage own recent activity" ON recent_activity;
DROP POLICY IF EXISTS "Users can view own mentions" ON user_mentions;
DROP POLICY IF EXISTS "System can insert mentions" ON user_mentions;
DROP POLICY IF EXISTS "Users can update own mentions" ON user_mentions;
CREATE POLICY "Users can manage own favorites" ON user_favorites FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own drafts" ON user_drafts FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own recent activity" ON recent_activity FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can view own mentions" ON user_mentions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "System can insert mentions" ON user_mentions FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update own mentions" ON user_mentions FOR UPDATE USING (auth.uid() = user_id);

-- ============================================================
-- SECTION 5: TRIGGERS
-- ============================================================

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NULL)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Updated_at triggers
DROP TRIGGER IF EXISTS set_profiles_updated_at ON profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS set_workspaces_updated_at ON workspaces;
CREATE TRIGGER set_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS set_workspace_members_updated_at ON workspace_members;
CREATE TRIGGER set_workspace_members_updated_at
  BEFORE UPDATE ON workspace_members
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS set_invitations_updated_at ON invitations;
CREATE TRIGGER set_invitations_updated_at
  BEFORE UPDATE ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS set_channels_updated_at ON channels;
CREATE TRIGGER set_channels_updated_at
  BEFORE UPDATE ON channels
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS handle_direct_conversations_updated_at ON direct_conversations;
CREATE TRIGGER handle_direct_conversations_updated_at
  BEFORE UPDATE ON direct_conversations
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- ============================================================
-- SECTION 6: STORAGE BUCKETS + POLICIES
-- ============================================================

INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('message-attachments', 'message-attachments', false) ON CONFLICT (id) DO NOTHING;

-- Drop all existing storage policies to avoid conflicts
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage' LOOP
    EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON storage.objects';
  END LOOP;
END $$;

CREATE POLICY "avatars_read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "avatars_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'avatars' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.user_is_workspace_admin((storage.foldername(name))[1]::uuid, auth.uid())
  )
);
CREATE POLICY "avatars_update" ON storage.objects FOR UPDATE TO authenticated USING (
  bucket_id = 'avatars' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.user_is_workspace_admin((storage.foldername(name))[1]::uuid, auth.uid())
  )
);
CREATE POLICY "avatars_delete" ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'avatars' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.user_is_workspace_admin((storage.foldername(name))[1]::uuid, auth.uid())
  )
);
CREATE POLICY "attachments_upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'message-attachments');
CREATE POLICY "attachments_read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'message-attachments');
CREATE POLICY "attachments_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'message-attachments');

-- ============================================================
-- SECTION 7: REALTIME PUBLICATIONS
-- ============================================================

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE profiles; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE messages; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE reactions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE file_attachments; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE tasks; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE task_comments; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE projects; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE project_milestones; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE reminders; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE notifications; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- SECTION 8: RPC FUNCTIONS
-- ============================================================

-- Presence
CREATE OR REPLACE FUNCTION update_user_presence(p_status TEXT, p_manual BOOLEAN DEFAULT false) RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET presence_status = p_status, manual_status = CASE WHEN p_manual THEN p_status ELSE manual_status END, last_active_at = now(), updated_at = now() WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION touch_presence() RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET last_active_at = now(), updated_at = now() WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_user_offline() RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET presence_status = 'offline', updated_at = now() WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Read receipts
CREATE OR REPLACE FUNCTION mark_message_read(p_message_id UUID) RETURNS VOID AS $$
BEGIN
  INSERT INTO message_read_receipts (message_id, user_id, read_at) VALUES (p_message_id, auth.uid(), now()) ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_read_receipt_counts(p_message_ids UUID[]) RETURNS TABLE(message_id UUID, read_count BIGINT) AS $$
BEGIN
  RETURN QUERY SELECT mrr.message_id, COUNT(*) as read_count FROM message_read_receipts mrr WHERE mrr.message_id = ANY(p_message_ids) GROUP BY mrr.message_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unread counts
CREATE OR REPLACE FUNCTION mark_channel_read(p_channel_id UUID, p_user_id UUID) RETURNS VOID AS $$
BEGIN
  UPDATE channel_members SET last_read_at = NOW() WHERE channel_id = p_channel_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_unread_count(p_channel_id UUID, p_user_id UUID) RETURNS INTEGER AS $$
DECLARE v_last_read TIMESTAMPTZ; v_count INTEGER;
BEGIN
  SELECT last_read_at INTO v_last_read FROM channel_members WHERE channel_id = p_channel_id AND user_id = p_user_id;
  IF v_last_read IS NULL THEN v_last_read := NOW(); END IF;
  SELECT COUNT(*)::INTEGER INTO v_count FROM messages WHERE channel_id = p_channel_id AND parent_id IS NULL AND deleted_at IS NULL AND created_at > v_last_read AND user_id != p_user_id;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_unread_counts(p_user_id UUID, p_channel_ids UUID[]) RETURNS TABLE(channel_id UUID, unread_count INTEGER) AS $$
DECLARE v_ch_id UUID; v_last_read TIMESTAMPTZ; v_count INTEGER;
BEGIN
  FOREACH v_ch_id IN ARRAY p_channel_ids LOOP
    SELECT last_read_at INTO v_last_read FROM channel_members WHERE channel_id = v_ch_id AND user_id = p_user_id;
    IF v_last_read IS NULL THEN v_last_read := NOW(); END IF;
    SELECT COUNT(*)::INTEGER INTO v_count FROM messages WHERE messages.channel_id = v_ch_id AND parent_id IS NULL AND deleted_at IS NULL AND created_at > v_last_read AND user_id != p_user_id;
    channel_id := v_ch_id; unread_count := v_count; RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_conversation_read(p_conversation_id UUID, p_user_id UUID) RETURNS VOID AS $$
BEGIN
  UPDATE direct_conversation_participants SET last_read_at = NOW() WHERE conversation_id = p_conversation_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Direct conversations
CREATE OR REPLACE FUNCTION create_direct_conversation(p_workspace_id UUID, p_created_by UUID, p_other_user_id UUID, p_type TEXT DEFAULT 'dm', p_name TEXT DEFAULT NULL) RETURNS UUID AS $$
DECLARE v_channel_id UUID; v_conv_id UUID; v_slug TEXT;
BEGIN
  IF p_type = 'dm' THEN
    SELECT dc.id INTO v_conv_id FROM direct_conversations dc
    JOIN direct_conversation_participants dcp1 ON dcp1.conversation_id = dc.id AND dcp1.user_id = p_created_by
    JOIN direct_conversation_participants dcp2 ON dcp2.conversation_id = dc.id AND dcp2.user_id = p_other_user_id
    WHERE dc.workspace_id = p_workspace_id AND dc.type = 'dm' LIMIT 1;
    IF v_conv_id IS NOT NULL THEN RETURN v_conv_id; END IF;
  END IF;
  v_slug := 'dm-' || encode(gen_random_bytes(8), 'hex');
  INSERT INTO channels (workspace_id, name, slug, type, is_private, created_by) VALUES (p_workspace_id, COALESCE(p_name, 'Direct Message'), v_slug, 'text', true, p_created_by) RETURNING id INTO v_channel_id;
  INSERT INTO channel_members (channel_id, user_id, role) VALUES (v_channel_id, p_created_by, 'owner'), (v_channel_id, p_other_user_id, 'member');
  INSERT INTO direct_conversations (workspace_id, channel_id, type, name, created_by) VALUES (p_workspace_id, v_channel_id, p_type, p_name, p_created_by) RETURNING id INTO v_conv_id;
  INSERT INTO direct_conversation_participants (conversation_id, user_id) VALUES (v_conv_id, p_created_by), (v_conv_id, p_other_user_id);
  RETURN v_conv_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION create_group_conversation(p_workspace_id UUID, p_created_by UUID, p_participant_ids UUID[], p_name TEXT) RETURNS UUID AS $$
DECLARE v_channel_id UUID; v_conv_id UUID; v_slug TEXT; v_participant_id UUID;
BEGIN
  v_slug := 'group-' || encode(gen_random_bytes(8), 'hex');
  INSERT INTO channels (workspace_id, name, slug, type, is_private, created_by) VALUES (p_workspace_id, p_name, v_slug, 'text', true, p_created_by) RETURNING id INTO v_channel_id;
  INSERT INTO channel_members (channel_id, user_id, role) VALUES (v_channel_id, p_created_by, 'owner');
  FOREACH v_participant_id IN ARRAY p_participant_ids LOOP
    INSERT INTO channel_members (channel_id, user_id, role) VALUES (v_channel_id, v_participant_id, 'member') ON CONFLICT (channel_id, user_id) DO NOTHING;
  END LOOP;
  INSERT INTO direct_conversations (workspace_id, channel_id, type, name, created_by) VALUES (p_workspace_id, v_channel_id, 'group', p_name, p_created_by) RETURNING id INTO v_conv_id;
  INSERT INTO direct_conversation_participants (conversation_id, user_id) VALUES (v_conv_id, p_created_by);
  FOREACH v_participant_id IN ARRAY p_participant_ids LOOP
    INSERT INTO direct_conversation_participants (conversation_id, user_id) VALUES (v_conv_id, v_participant_id) ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END LOOP;
  RETURN v_conv_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Message versions
CREATE OR REPLACE FUNCTION record_message_version(p_message_id UUID, p_user_id UUID, p_content TEXT) RETURNS VOID AS $$
BEGIN
  INSERT INTO message_versions (message_id, user_id, content) VALUES (p_message_id, p_user_id, p_content);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Workspace management RPCs
CREATE OR REPLACE FUNCTION create_workspace_with_owner(p_name TEXT, p_slug TEXT, p_owner_id UUID, p_description TEXT DEFAULT NULL) RETURNS JSON AS $$
DECLARE v_workspace_id UUID; v_workspace JSON;
BEGIN
  INSERT INTO workspaces (name, slug, description, owner_id) VALUES (p_name, p_slug, p_description, p_owner_id) RETURNING id INTO v_workspace_id;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (v_workspace_id, p_owner_id, 'owner');
  SELECT row_to_json(w.*) INTO v_workspace FROM workspaces w WHERE w.id = v_workspace_id;
  RETURN v_workspace;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION accept_workspace_invitation(p_invitation_id UUID, p_user_id UUID, p_user_email TEXT DEFAULT NULL) RETURNS JSON AS $$
DECLARE v_invitation RECORD; v_existing_member UUID;
BEGIN
  SELECT * INTO v_invitation FROM invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN RETURN json_build_object('success', false, 'error', 'Invitation not found.'); END IF;
  IF v_invitation.status != 'pending' THEN RETURN json_build_object('success', false, 'error', 'This invitation is no longer valid.'); END IF;
  IF v_invitation.expires_at < NOW() THEN UPDATE invitations SET status = 'expired' WHERE id = p_invitation_id; RETURN json_build_object('success', false, 'error', 'This invitation has expired.'); END IF;
  IF p_user_email IS NOT NULL AND lower(v_invitation.email) != lower(p_user_email) THEN RETURN json_build_object('success', false, 'error', 'Email mismatch.'); END IF;
  SELECT user_id INTO v_existing_member FROM workspace_members WHERE workspace_id = v_invitation.workspace_id AND user_id = p_user_id;
  IF v_existing_member IS NOT NULL THEN UPDATE invitations SET status = 'accepted', user_id = p_user_id WHERE id = p_invitation_id; RETURN json_build_object('success', true); END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (v_invitation.workspace_id, p_user_id, v_invitation.role);
  UPDATE invitations SET status = 'accepted', user_id = p_user_id WHERE id = p_invitation_id;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION change_member_role(p_workspace_id UUID, p_target_user_id UUID, p_new_role TEXT, p_caller_id UUID) RETURNS JSON AS $$
DECLARE v_caller_role TEXT; v_target_role TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_caller_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN RETURN json_build_object('allowed', false, 'reason', 'No permission.'); END IF;
  SELECT role INTO v_target_role FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_target_role = 'owner' THEN RETURN json_build_object('allowed', false, 'reason', 'Cannot change owner.'); END IF;
  UPDATE workspace_members SET role = p_new_role WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  RETURN json_build_object('allowed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION remove_workspace_member(p_workspace_id UUID, p_target_user_id UUID, p_caller_id UUID) RETURNS JSON AS $$
DECLARE v_caller_role TEXT; v_target_role TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_caller_id;
  IF v_caller_role IS NULL THEN RETURN json_build_object('allowed', false, 'reason', 'Not a member.'); END IF;
  IF p_caller_id = p_target_user_id THEN RETURN json_build_object('allowed', false, 'reason', 'Use leave instead.'); END IF;
  SELECT role INTO v_target_role FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_target_role = 'owner' THEN RETURN json_build_object('allowed', false, 'reason', 'Cannot remove owner.'); END IF;
  DELETE FROM workspace_members WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  RETURN json_build_object('allowed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_profiles_by_ids(p_user_ids UUID[]) RETURNS JSON AS $$
BEGIN
  RETURN (SELECT COALESCE(json_agg(row_to_json(p.*)), '[]'::json) FROM profiles p WHERE p.id = ANY(p_user_ids));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Notification RPCs
CREATE OR REPLACE FUNCTION create_notification(p_user_id UUID, p_type TEXT, p_title TEXT, p_message TEXT, p_link TEXT DEFAULT NULL, p_category TEXT DEFAULT 'system', p_entity_type TEXT DEFAULT NULL, p_entity_id UUID DEFAULT NULL, p_actor_id UUID DEFAULT NULL, p_workspace_id UUID DEFAULT NULL) RETURNS UUID AS $$
DECLARE v_notif_id UUID;
BEGIN
  INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
  VALUES (p_user_id, p_type, p_title, p_message, p_link, p_category, p_entity_type, p_entity_id, p_actor_id, p_workspace_id) RETURNING id INTO v_notif_id;
  RETURN v_notif_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID) RETURNS VOID AS $$
BEGIN UPDATE notifications SET read = true WHERE id = p_notification_id AND user_id = auth.uid(); END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_all_notifications_read() RETURNS VOID AS $$
BEGIN UPDATE notifications SET read = true WHERE user_id = auth.uid() AND read = false; END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_notification_unread_count() RETURNS BIGINT AS $$
  SELECT COUNT(*) FROM notifications WHERE user_id = auth.uid() AND read = false;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Task RPCs
CREATE OR REPLACE FUNCTION create_task(p_workspace_id UUID, p_title TEXT, p_description TEXT DEFAULT NULL, p_status TEXT DEFAULT 'todo', p_priority TEXT DEFAULT 'medium', p_due_date TIMESTAMPTZ DEFAULT NULL, p_project_id UUID DEFAULT NULL, p_channel_id UUID DEFAULT NULL, p_message_id UUID DEFAULT NULL, p_assignee_ids UUID[] DEFAULT '{}', p_label_ids UUID[] DEFAULT '{}') RETURNS UUID AS $$
DECLARE v_task_id UUID; v_id UUID;
BEGIN
  INSERT INTO tasks (workspace_id, title, description, status, priority, due_date, project_id, channel_id, message_id, created_by) VALUES (p_workspace_id, p_title, p_description, p_status, p_priority, p_due_date, p_project_id, p_channel_id, p_message_id, auth.uid()) RETURNING id INTO v_task_id;
  FOREACH v_id IN ARRAY p_assignee_ids LOOP INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES (v_task_id, v_id, auth.uid()); END LOOP;
  FOREACH v_id IN ARRAY p_label_ids LOOP INSERT INTO task_label_assignments (task_id, label_id) VALUES (v_task_id, v_id); END LOOP;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (v_task_id, auth.uid(), 'created', jsonb_build_object('title', p_title));
  RETURN v_task_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_task_status(p_task_id UUID, p_status TEXT) RETURNS VOID AS $$
BEGIN UPDATE tasks SET status = p_status, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'status_changed', jsonb_build_object('status', p_status));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_task(p_task_id UUID, p_title TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL, p_status TEXT DEFAULT NULL, p_priority TEXT DEFAULT NULL, p_due_date TIMESTAMPTZ DEFAULT NULL, p_start_date TIMESTAMPTZ DEFAULT NULL, p_project_id UUID DEFAULT NULL) RETURNS VOID AS $$
BEGIN UPDATE tasks SET title = COALESCE(p_title, title), description = COALESCE(p_description, description), status = COALESCE(p_status, status), priority = COALESCE(p_priority, priority), due_date = COALESCE(p_due_date, due_date), start_date = COALESCE(p_start_date, start_date), project_id = COALESCE(p_project_id, project_id), updated_at = now() WHERE id = p_task_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION delete_task(p_task_id UUID) RETURNS VOID AS $$
BEGIN DELETE FROM tasks WHERE id = p_task_id; END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION archive_task(p_task_id UUID) RETURNS VOID AS $$
BEGIN UPDATE tasks SET archived_at = now(), updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'archived', '{}');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION restore_task(p_task_id UUID) RETURNS VOID AS $$
BEGIN UPDATE tasks SET archived_at = NULL, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'restored', '{}');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION message_to_task(p_message_id UUID, p_title TEXT DEFAULT NULL, p_workspace_id UUID DEFAULT NULL) RETURNS UUID AS $$
DECLARE v_msg RECORD; v_task_id UUID;
BEGIN
  SELECT m.*, c.workspace_id, c.id AS ch_id INTO v_msg FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = p_message_id;
  INSERT INTO tasks (workspace_id, channel_id, message_id, title, description, created_by) VALUES (COALESCE(p_workspace_id, v_msg.workspace_id), v_msg.ch_id, p_message_id, COALESCE(p_title, left(v_msg.content, 100)), v_msg.content, auth.uid()) RETURNING id INTO v_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (v_task_id, auth.uid(), 'created', jsonb_build_object('source', 'message', 'message_id', p_message_id));
  RETURN v_task_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_workspace_tasks(p_workspace_id UUID, p_status TEXT DEFAULT NULL, p_project_id UUID DEFAULT NULL, p_limit INT DEFAULT 50, p_offset INT DEFAULT 0) RETURNS TABLE(task_id UUID, title TEXT, description TEXT, status TEXT, priority TEXT, due_date TIMESTAMPTZ, project_id UUID, channel_id UUID, created_by UUID, creator_name TEXT, creator_avatar TEXT, assignee_names TEXT[], assignee_avatars TEXT[], label_names TEXT[], label_colors TEXT[], comment_count BIGINT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ) AS $$
BEGIN RETURN QUERY
  SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.project_id, t.channel_id, t.created_by, cp.display_name, cp.avatar_url,
    COALESCE(ARRAY(SELECT DISTINCT pr2.display_name FROM task_assignees ta2 JOIN profiles pr2 ON pr2.id = ta2.user_id WHERE ta2.task_id = t.id), '{}'),
    COALESCE(ARRAY(SELECT DISTINCT pr3.avatar_url FROM task_assignees ta3 JOIN profiles pr3 ON pr3.id = ta3.user_id WHERE ta3.task_id = t.id), '{}'),
    COALESCE(ARRAY(SELECT DISTINCT tl.name FROM task_label_assignments tla JOIN task_labels tl ON tl.id = tla.label_id WHERE tla.task_id = t.id), '{}'),
    COALESCE(ARRAY(SELECT DISTINCT tl2.color FROM task_label_assignments tla2 JOIN task_labels tl2 ON tl2.id = tla2.label_id WHERE tla2.task_id = t.id), '{}'),
    (SELECT COUNT(*) FROM task_comments tc WHERE tc.task_id = t.id AND tc.deleted_at IS NULL),
    t.created_at, t.updated_at
  FROM tasks t JOIN profiles cp ON cp.id = t.created_by
  WHERE t.workspace_id = p_workspace_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
    AND (p_status IS NULL OR t.status = p_status) AND (p_project_id IS NULL OR t.project_id = p_project_id)
  ORDER BY t.created_at DESC LIMIT p_limit OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Project RPCs
CREATE OR REPLACE FUNCTION create_project(p_workspace_id UUID, p_name TEXT, p_description TEXT DEFAULT NULL, p_icon TEXT DEFAULT '📋', p_color TEXT DEFAULT '#6366f1', p_due_date TIMESTAMPTZ DEFAULT NULL) RETURNS UUID AS $$
DECLARE v_project_id UUID;
BEGIN
  INSERT INTO projects (workspace_id, name, description, icon, color, owner_id, created_by, due_date)
  VALUES (p_workspace_id, p_name, p_description, p_icon, p_color, auth.uid(), auth.uid(), p_due_date)
  RETURNING id INTO v_project_id;

  INSERT INTO project_members (project_id, user_id, role) VALUES (v_project_id, auth.uid(), 'owner');

  INSERT INTO project_columns (project_id, name, sort_order, position) VALUES
    (v_project_id, 'Backlog', 0, 0),
    (v_project_id, 'To Do', 1, 1),
    (v_project_id, 'In Progress', 2, 2),
    (v_project_id, 'Done', 3, 3);

  RETURN v_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION move_task_to_column(p_task_id UUID, p_column_id UUID, p_sort_order INTEGER DEFAULT 0) RETURNS VOID AS $$
BEGIN UPDATE tasks SET column_id = p_column_id, sort_order = p_sort_order, updated_at = now() WHERE id = p_task_id;
  INSERT INTO task_activity (task_id, user_id, action, details) VALUES (p_task_id, auth.uid(), 'moved', jsonb_build_object('column_id', p_column_id, 'sort_order', p_sort_order));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_project_member_count(p_project_id UUID) RETURNS BIGINT AS $$
BEGIN RETURN (SELECT COUNT(*) FROM project_members WHERE project_id = p_project_id); END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_project_members(p_project_id UUID) RETURNS TABLE(id UUID, user_id UUID, role TEXT, created_at TIMESTAMPTZ, display_name TEXT, avatar_url TEXT, email TEXT) AS $$
BEGIN RETURN QUERY
  SELECT pm.id, pm.user_id, pm.role, pm.created_at, p.display_name, p.avatar_url, p.email
  FROM project_members pm LEFT JOIN profiles p ON p.id = pm.user_id WHERE pm.project_id = p_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION add_project_member(p_project_id UUID, p_user_id UUID, p_role TEXT DEFAULT 'member') RETURNS VOID AS $$
BEGIN INSERT INTO project_members (project_id, user_id, role) VALUES (p_project_id, p_user_id, p_role); END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION remove_project_member(p_member_id UUID) RETURNS VOID AS $$
BEGIN DELETE FROM project_members WHERE id = p_member_id; END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_project_member_ids(p_project_id UUID) RETURNS TABLE(user_id UUID, role TEXT) AS $$
BEGIN
  RETURN QUERY SELECT pm.user_id, pm.role FROM project_members pm WHERE pm.project_id = p_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_project_member_role(p_member_id UUID, p_role TEXT) RETURNS VOID AS $$
BEGIN
  UPDATE project_members SET role = p_role WHERE id = p_member_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Calendar RPCs
CREATE OR REPLACE FUNCTION get_pending_reminders() RETURNS TABLE(reminder_id UUID, entity_type TEXT, entity_id UUID, title TEXT, remind_at TIMESTAMPTZ) AS $$
BEGIN RETURN QUERY
  SELECT r.id, r.entity_type, r.entity_id, r.title, r.remind_at FROM reminders r
  WHERE r.user_id = auth.uid() AND r.notified = false AND r.dismissed = false AND r.remind_at <= now() + INTERVAL '5 minutes' ORDER BY r.remind_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_reminder_notified(p_reminder_id UUID) RETURNS VOID AS $$
BEGIN UPDATE reminders SET notified = true WHERE id = p_reminder_id AND user_id = auth.uid(); END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_personal_planner() RETURNS TABLE(entity_type TEXT, entity_id UUID, title TEXT, due_date TIMESTAMPTZ, status TEXT, priority TEXT, project_name TEXT) AS $$
BEGIN RETURN QUERY
  SELECT 'task'::TEXT, t.id, t.title, t.due_date, t.status, t.priority, p.name
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.created_by = auth.uid() AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')
    AND (t.due_date IS NOT NULL OR t.status IN ('in_progress', 'review'))
  ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, t.due_date NULLS LAST LIMIT 20;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Productivity RPCs
CREATE OR REPLACE FUNCTION toggle_favorite(p_entity_type TEXT, p_entity_id UUID) RETURNS BOOLEAN AS $$
DECLARE v_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM user_favorites WHERE user_id = auth.uid() AND entity_type = p_entity_type AND entity_id = p_entity_id) INTO v_exists;
  IF v_exists THEN DELETE FROM user_favorites WHERE user_id = auth.uid() AND entity_type = p_entity_type AND entity_id = p_entity_id; RETURN false;
  ELSE INSERT INTO user_favorites (user_id, entity_type, entity_id) VALUES (auth.uid(), p_entity_type, p_entity_id); RETURN true; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION upsert_draft(p_channel_id UUID DEFAULT NULL, p_conversation_id UUID DEFAULT NULL, p_thread_id UUID DEFAULT NULL, p_content TEXT DEFAULT '') RETURNS UUID AS $$
DECLARE v_draft_id UUID;
BEGIN
  IF p_content = '' OR p_content IS NULL THEN RETURN NULL; END IF;
  IF p_channel_id IS NOT NULL THEN
    INSERT INTO user_drafts (user_id, channel_id, content, updated_at) VALUES (auth.uid(), p_channel_id, p_content, now())
    ON CONFLICT (user_id, channel_id) DO UPDATE SET content = p_content, updated_at = now() RETURNING id INTO v_draft_id;
  ELSIF p_conversation_id IS NOT NULL THEN
    INSERT INTO user_drafts (user_id, conversation_id, content, updated_at) VALUES (auth.uid(), p_conversation_id, p_content, now())
    ON CONFLICT (user_id, conversation_id) DO UPDATE SET content = p_content, updated_at = now() RETURNING id INTO v_draft_id;
  ELSIF p_thread_id IS NOT NULL THEN
    INSERT INTO user_drafts (user_id, thread_id, content, updated_at) VALUES (auth.uid(), p_thread_id, p_content, now())
    ON CONFLICT (user_id, thread_id) DO UPDATE SET content = p_content, updated_at = now() RETURNING id INTO v_draft_id;
  END IF;
  RETURN v_draft_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION record_recent_activity(p_entity_type TEXT, p_entity_id UUID, p_entity_name TEXT DEFAULT NULL, p_entity_url TEXT DEFAULT NULL) RETURNS VOID AS $$
BEGIN
  INSERT INTO recent_activity (user_id, entity_type, entity_id, entity_name, entity_url, accessed_at) VALUES (auth.uid(), p_entity_type, p_entity_id, p_entity_name, p_entity_url, now())
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET accessed_at = now(), entity_name = coalesce(p_entity_name, recent_activity.entity_name), entity_url = coalesce(p_entity_url, recent_activity.entity_url);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Automation RPCs
CREATE OR REPLACE FUNCTION create_automation_rule(
  p_workspace_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_triggers JSONB DEFAULT '[]',
  p_conditions JSONB DEFAULT '[]',
  p_actions JSONB DEFAULT '[]',
  p_enabled BOOLEAN DEFAULT TRUE
)
RETURNS UUID AS $$
DECLARE
  v_rule_id UUID;
  v_trigger JSONB;
  v_condition JSONB;
  v_action JSONB;
BEGIN
  INSERT INTO automation_rules (workspace_id, name, description, enabled, created_by)
  VALUES (p_workspace_id, p_name, p_description, p_enabled, auth.uid())
  RETURNING id INTO v_rule_id;

  FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers)
  LOOP
    INSERT INTO automation_triggers (rule_id, event_type)
    VALUES (v_rule_id, COALESCE(v_trigger->>'event_type', ''));
  END LOOP;

  FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions)
  LOOP
    INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
    VALUES (v_rule_id, COALESCE(v_condition->>'field', ''), COALESCE(v_condition->>'operator', 'equals'), COALESCE(v_condition->>'value', ''), coalesce(v_condition->>'logic', 'and'));
  END LOOP;

  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
    VALUES (v_rule_id, COALESCE(v_action->>'action_type', 'post_message'), COALESCE(v_action->'config', '{}'::jsonb), coalesce((v_action->>'sort_order')::INTEGER, 0));
  END LOOP;

  RETURN v_rule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_automation_rules(p_workspace_id UUID)
RETURNS TABLE(
  rule_id UUID,
  name TEXT,
  description TEXT,
  enabled BOOLEAN,
  trigger_types TEXT[],
  action_count BIGINT,
  last_executed TIMESTAMPTZ,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ar.id AS rule_id,
    ar.name,
    ar.description,
    ar.enabled,
    COALESCE(ARRAY(SELECT at2.event_type FROM automation_triggers at2 WHERE at2.rule_id = ar.id), '{}') AS trigger_types,
    (SELECT COUNT(*) FROM automation_actions aa WHERE aa.rule_id = ar.id) AS action_count,
    (SELECT MAX(ael.executed_at) FROM automation_execution_logs ael WHERE ael.rule_id = ar.id) AS last_executed,
    ar.created_at
  FROM automation_rules ar
  WHERE ar.workspace_id = p_workspace_id
  ORDER BY ar.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_automation_rule(
  p_rule_id UUID,
  p_name TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_enabled BOOLEAN DEFAULT NULL,
  p_triggers JSONB DEFAULT NULL,
  p_conditions JSONB DEFAULT NULL,
  p_actions JSONB DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_trigger JSONB;
  v_condition JSONB;
  v_action JSONB;
BEGIN
  UPDATE automation_rules SET
    name = COALESCE(p_name, name),
    description = COALESCE(p_description, description),
    enabled = COALESCE(p_enabled, enabled),
    updated_at = now()
  WHERE id = p_rule_id;

  IF p_triggers IS NOT NULL THEN
    DELETE FROM automation_triggers WHERE rule_id = p_rule_id;
    FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers)
    LOOP
      INSERT INTO automation_triggers (rule_id, event_type)
      VALUES (p_rule_id, COALESCE(v_trigger->>'event_type', ''));
    END LOOP;
  END IF;

  IF p_conditions IS NOT NULL THEN
    DELETE FROM automation_conditions WHERE rule_id = p_rule_id;
    FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions)
    LOOP
      INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
      VALUES (p_rule_id, COALESCE(v_condition->>'field', ''), COALESCE(v_condition->>'operator', 'equals'), COALESCE(v_condition->>'value', ''), coalesce(v_condition->>'logic', 'and'));
    END LOOP;
  END IF;

  IF p_actions IS NOT NULL THEN
    DELETE FROM automation_actions WHERE rule_id = p_rule_id;
    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
    LOOP
      INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
      VALUES (p_rule_id, COALESCE(v_action->>'action_type', 'post_message'), COALESCE(v_action->'config', '{}'::jsonb), coalesce((v_action->>'sort_order')::INTEGER, 0));
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION toggle_automation_rule(p_rule_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_new_state BOOLEAN;
BEGIN
  UPDATE automation_rules SET enabled = NOT enabled, updated_at = now()
  WHERE id = p_rule_id
  RETURNING enabled INTO v_new_state;
  RETURN v_new_state;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION log_automation_execution(
  p_rule_id UUID,
  p_trigger_event TEXT,
  p_trigger_entity_id UUID DEFAULT NULL,
  p_conditions_met BOOLEAN DEFAULT false,
  p_actions_executed INTEGER DEFAULT 0,
  p_success BOOLEAN DEFAULT true,
  p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_log_id UUID;
BEGIN
  INSERT INTO automation_execution_logs (rule_id, trigger_event, trigger_entity_id, conditions_met, actions_executed, success, error_message)
  VALUES (p_rule_id, p_trigger_event, p_trigger_entity_id, p_conditions_met, p_actions_executed, p_success, p_error_message)
  RETURNING id INTO v_log_id;

  IF NOT p_success THEN
    IF (
      SELECT COUNT(*) FROM automation_execution_logs
      WHERE rule_id = p_rule_id AND success = false AND executed_at > now() - INTERVAL '1 hour'
    ) >= 5 THEN
      UPDATE automation_rules SET enabled = false, updated_at = now() WHERE id = p_rule_id;
    END IF;
  END IF;

  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_execution_logs(p_workspace_id UUID, p_rule_id UUID DEFAULT NULL)
RETURNS TABLE(
  id UUID,
  rule_id UUID,
  trigger_event TEXT,
  trigger_entity_id UUID,
  conditions_met BOOLEAN,
  actions_executed INTEGER,
  success BOOLEAN,
  error_message TEXT,
  executed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT ael.id, ael.rule_id, ael.trigger_event, ael.trigger_entity_id,
    ael.conditions_met, ael.actions_executed, ael.success, ael.error_message, ael.executed_at
  FROM automation_execution_logs ael
  JOIN automation_rules ar ON ar.id = ael.rule_id
  WHERE ar.workspace_id = p_workspace_id
    AND (p_rule_id IS NULL OR ael.rule_id = p_rule_id)
  ORDER BY ael.executed_at DESC
  LIMIT 100;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- AUTOMATION EXECUTION ENGINE
-- ============================================================

CREATE OR REPLACE FUNCTION evaluate_automation_rules(
  p_workspace_id UUID,
  p_event_type TEXT,
  p_entity_id UUID,
  p_entity_data JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
DECLARE
  v_rule RECORD;
  v_condition RECORD;
  v_action RECORD;
  v_conditions_met BOOLEAN;
  v_actions_executed INTEGER;
  v_field_value TEXT;
  v_message_user_id UUID;
  v_row_count INTEGER;
  v_num_field NUMERIC;
  v_num_value NUMERIC;
  v_is_numeric BOOLEAN;
  v_numeric_fields TEXT[] := ARRAY['message_length'];
BEGIN
  FOR v_rule IN
    SELECT DISTINCT ar.id AS rule_id
    FROM automation_rules ar
    JOIN automation_triggers at2 ON at2.rule_id = ar.id
    WHERE ar.workspace_id = p_workspace_id
      AND ar.enabled = true
      AND at2.event_type = p_event_type
  LOOP
    v_conditions_met := true;
    v_actions_executed := 0;

    FOR v_condition IN
      SELECT * FROM automation_conditions WHERE rule_id = v_rule.rule_id
    LOOP
      v_field_value := p_entity_data ->> v_condition.field;
      v_is_numeric := v_condition.field = ANY(v_numeric_fields);

      IF v_is_numeric AND v_field_value IS NOT NULL AND v_condition.value IS NOT NULL AND v_field_value != '' AND v_condition.value != '' THEN
        v_num_field := v_field_value::NUMERIC;
        v_num_value := v_condition.value::NUMERIC;
      ELSE
        v_num_field := NULL; v_num_value := NULL;
      END IF;

      CASE v_condition.operator
        WHEN 'equals', 'eq' THEN
          IF v_field_value IS DISTINCT FROM v_condition.value THEN v_conditions_met := false; END IF;
        WHEN 'not_equals', 'neq' THEN
          IF v_field_value = v_condition.value THEN v_conditions_met := false; END IF;
        WHEN 'contains' THEN
          IF v_field_value IS NULL OR v_field_value NOT LIKE '%' || v_condition.value || '%' THEN v_conditions_met := false; END IF;
        WHEN 'not_contains' THEN
          IF v_field_value LIKE '%' || v_condition.value || '%' THEN v_conditions_met := false; END IF;
        WHEN 'gt', 'greater_than' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field <= v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value <= v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'lt', 'less_than' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field >= v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value >= v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'gte' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field < v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value < v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'lte' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field > v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value > v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'is_empty' THEN
          IF v_field_value IS NOT NULL AND v_field_value != '' THEN v_conditions_met := false; END IF;
        WHEN 'is_not_empty' THEN
          IF v_field_value IS NULL OR v_field_value = '' THEN v_conditions_met := false; END IF;
        ELSE NULL;
      END CASE;

      EXIT WHEN NOT v_conditions_met;
    END LOOP;

    IF v_conditions_met THEN
      FOR v_action IN
        SELECT * FROM automation_actions WHERE rule_id = v_rule.rule_id ORDER BY sort_order
      LOOP
        IF v_action.action_type = 'post_message' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            IF (v_action.config ->> 'channel_id') IS NOT NULL AND (v_action.config ->> 'channel_id') != '' THEN
              INSERT INTO messages (channel_id, user_id, content)
              VALUES (
                (v_action.config ->> 'channel_id')::UUID,
                v_message_user_id,
                COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              );
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            ELSIF (v_action.config ->> 'channel') IS NOT NULL AND (v_action.config ->> 'channel') != '' THEN
              INSERT INTO messages (channel_id, user_id, content)
              SELECT c.id, v_message_user_id, COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              FROM channels c
              WHERE LOWER(TRIM(c.name)) = LOWER(TRIM(v_action.config ->> 'channel'))
                AND c.workspace_id = p_workspace_id
              LIMIT 1;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            ELSE
              INSERT INTO messages (channel_id, user_id, content)
              SELECT c.id, v_message_user_id, COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              FROM channels c WHERE c.workspace_id = p_workspace_id ORDER BY c.created_at ASC LIMIT 1;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          END IF;
        ELSIF v_action.action_type = 'send_notification' THEN
          IF (v_action.config ->> 'recipients') = 'all_members' THEN
            INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
            SELECT p.user_id,
              COALESCE(v_action.config ->> 'title', 'Automation Notification'),
              COALESCE(v_action.config ->> 'message', 'You have a new notification'),
              'automation', 'automation', p_workspace_id
            FROM workspace_members p WHERE p.workspace_id = p_workspace_id AND p.user_id != COALESCE((p_entity_data ->> 'user_id')::UUID, '00000000-0000-0000-0000-000000000000'::UUID);
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          ELSIF (v_action.config ->> 'recipients') = 'creator' THEN
            v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
            IF v_message_user_id IS NULL THEN SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id; END IF;
            IF v_message_user_id IS NOT NULL THEN
              INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
              VALUES (v_message_user_id,
                COALESCE(v_action.config ->> 'title', 'Automation Notification'),
                COALESCE(v_action.config ->> 'message', 'You have a new notification'),
                'automation', 'automation', p_workspace_id);
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          ELSIF (v_action.config ->> 'recipients') = 'assignee' THEN
            INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
            SELECT ta.user_id,
              COALESCE(v_action.config ->> 'title', 'Automation Notification'),
              COALESCE(v_action.config ->> 'message', 'You have a new notification'),
              'automation', 'automation', p_workspace_id
            FROM task_assignees ta WHERE ta.task_id = p_entity_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          ELSE
            v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
            IF v_message_user_id IS NULL THEN SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id; END IF;
            IF v_message_user_id IS NOT NULL THEN
              INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
              VALUES (v_message_user_id,
                COALESCE(v_action.config ->> 'title', 'Automation Notification'),
                COALESCE(v_action.config ->> 'message', 'You have a new notification'),
                'automation', 'automation', p_workspace_id);
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          END IF;
        ELSIF v_action.action_type = 'update_status' THEN
          IF p_event_type LIKE 'task.%' THEN
            UPDATE tasks SET status = COALESCE(v_action.config ->> 'status', 'todo'), updated_at = now() WHERE id = p_entity_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;
        ELSIF v_action.action_type = 'create_task' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            DECLARE v_new_task_id UUID;
            BEGIN
              INSERT INTO tasks (workspace_id, title, description, status, priority, created_by)
              VALUES (p_workspace_id,
                COALESCE(NULLIF(v_action.config ->> 'title', ''), 'New Task'),
                NULLIF(v_action.config ->> 'description', ''),
                COALESCE(v_action.config ->> 'status', 'todo'),
                COALESCE(v_action.config ->> 'priority', 'medium'),
                v_message_user_id)
              RETURNING id INTO v_new_task_id;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN
                v_actions_executed := v_actions_executed + 1;
                IF v_action.config ->> 'assignee' = 'trigger_creator' THEN
                  INSERT INTO task_assignees (task_id, user_id, assigned_by)
                  VALUES (v_new_task_id, v_message_user_id, v_message_user_id)
                  ON CONFLICT (task_id, user_id) DO NOTHING;
                ELSIF v_action.config ->> 'assignee' = 'assignee' THEN
                  INSERT INTO task_assignees (task_id, user_id, assigned_by)
                  SELECT v_new_task_id, v_message_user_id, v_message_user_id
                  WHERE (p_entity_data ->> 'user_id')::UUID IS NOT NULL
                    AND (p_entity_data ->> 'user_id')::UUID != v_message_user_id
                  ON CONFLICT (task_id, user_id) DO NOTHING;
                END IF;
              END IF;
            END;
          END IF;
        ELSIF v_action.action_type = 'send_reminder' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (v_message_user_id, COALESCE(v_action.config ->> 'title', 'Reminder'), COALESCE(v_action.config ->> 'message', 'You have a reminder'), 'reminder');
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;
        ELSIF v_action.action_type = 'assign_task' THEN
          DECLARE v_assign_to UUID; v_task_id UUID;
          BEGIN
            IF p_event_type LIKE 'task.%' THEN
              v_task_id := p_entity_id;
            ELSE
              SELECT t.id INTO v_task_id FROM tasks t WHERE t.message_id = p_entity_id LIMIT 1;
            END IF;
            IF v_task_id IS NULL THEN
              SELECT t.id INTO v_task_id FROM tasks t WHERE t.id = p_entity_id LIMIT 1;
            END IF;
            IF v_task_id IS NOT NULL THEN
              IF (v_action.config ->> 'assignee') = 'trigger_creator' THEN
                v_assign_to := (p_entity_data ->> 'user_id')::UUID;
                IF v_assign_to IS NULL THEN SELECT created_by INTO v_assign_to FROM automation_rules WHERE id = v_rule.rule_id; END IF;
              ELSIF (v_action.config ->> 'assignee') = 'trigger_assignee' THEN
                v_assign_to := (p_entity_data ->> 'user_id')::UUID;
              ELSIF (v_action.config ->> 'assignee') = 'specific_user' THEN
                SELECT id INTO v_assign_to FROM profiles WHERE LOWER(email) = LOWER(TRIM(v_action.config ->> 'assignee_email'));
              END IF;
              IF v_assign_to IS NOT NULL THEN
                INSERT INTO task_assignees (task_id, user_id, assigned_by)
                VALUES (v_task_id, v_assign_to, COALESCE((p_entity_data ->> 'user_id')::UUID, v_assign_to))
                ON CONFLICT (task_id, user_id) DO NOTHING;
                GET DIAGNOSTICS v_row_count = ROW_COUNT;
                IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
              END IF;
            END IF;
          END;
        END IF;
      END LOOP;

      PERFORM log_automation_execution(
        v_rule.rule_id, p_event_type, p_entity_id,
        true, v_actions_executed, true, NULL
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Automation table-level triggers
CREATE OR REPLACE FUNCTION fn_fire_message_posted()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_channel_name TEXT;
  v_creator_name TEXT;
  v_creator_email TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  SELECT workspace_id, name INTO v_workspace_id, v_channel_name FROM channels WHERE id = NEW.channel_id;
  IF v_workspace_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(display_name, username, split_part(email, '@', 1)), email
    INTO v_creator_name, v_creator_email
    FROM profiles WHERE id = NEW.user_id;
  PERFORM evaluate_automation_rules(
    v_workspace_id, 'message.posted', NEW.id,
    jsonb_build_object(
      'channel_id', NEW.channel_id::TEXT,
      'channel_name', COALESCE(v_channel_name, ''),
      'content', COALESCE(NEW.content, ''),
      'user_id', NEW.user_id::TEXT,
      'creator', COALESCE(v_creator_name, ''),
      'creator_email', COALESCE(v_creator_email, ''),
      'message_length', COALESCE(length(NEW.content), 0)::TEXT
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_message_posted ON messages;
CREATE TRIGGER trg_message_posted
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION fn_fire_message_posted();

CREATE OR REPLACE FUNCTION fn_fire_task_events()
RETURNS TRIGGER AS $$
DECLARE
  v_creator_name TEXT;
  v_creator_email TEXT;
  v_assignee_names TEXT;
  v_assignee_emails TEXT;
  v_project_name TEXT;
  v_message_content TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, username, split_part(email, '@', 1)), email
    INTO v_creator_name, v_creator_email
    FROM profiles WHERE id = NEW.created_by;

  SELECT string_agg(COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), ', ')
    INTO v_assignee_names
    FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
    WHERE ta.task_id = NEW.id;

  SELECT string_agg(p.email, ', ')
    INTO v_assignee_emails
    FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
    WHERE ta.task_id = NEW.id;

  SELECT name INTO v_project_name FROM projects WHERE id = NEW.project_id;

  SELECT m.content INTO v_message_content FROM messages m WHERE m.id = NEW.message_id;

  IF TG_OP = 'INSERT' THEN
    PERFORM evaluate_automation_rules(
      NEW.workspace_id, 'task.created', NEW.id,
      jsonb_build_object(
        'status', NEW.status,
        'priority', NEW.priority,
        'project_id', COALESCE(NEW.project_id::TEXT, ''),
        'project_name', COALESCE(v_project_name, ''),
        'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
        'user_id', NEW.created_by::TEXT,
        'creator', COALESCE(v_creator_name, ''),
        'creator_email', COALESCE(v_creator_email, ''),
        'assignee_names', COALESCE(v_assignee_names, ''),
        'assignee_emails', COALESCE(v_assignee_emails, ''),
        'due_date', COALESCE(NEW.due_date::TEXT, ''),
        'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
        'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
        'message_content', COALESCE(v_message_content, '')
      )
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM evaluate_automation_rules(
      NEW.workspace_id, 'task.status_changed', NEW.id,
      jsonb_build_object(
        'status', NEW.status,
        'old_status', OLD.status,
        'priority', NEW.priority,
        'project_id', COALESCE(NEW.project_id::TEXT, ''),
        'project_name', COALESCE(v_project_name, ''),
        'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
        'user_id', NEW.created_by::TEXT,
        'creator', COALESCE(v_creator_name, ''),
        'creator_email', COALESCE(v_creator_email, ''),
        'assignee_names', COALESCE(v_assignee_names, ''),
        'assignee_emails', COALESCE(v_assignee_emails, ''),
        'due_date', COALESCE(NEW.due_date::TEXT, ''),
        'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
        'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
        'message_content', COALESCE(v_message_content, '')
      )
    );
    IF NEW.status = 'completed' THEN
      PERFORM evaluate_automation_rules(
        NEW.workspace_id, 'task.completed', NEW.id,
        jsonb_build_object(
          'status', NEW.status,
          'priority', NEW.priority,
          'project_id', COALESCE(NEW.project_id::TEXT, ''),
          'project_name', COALESCE(v_project_name, ''),
          'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
          'user_id', NEW.created_by::TEXT,
          'creator', COALESCE(v_creator_name, ''),
          'creator_email', COALESCE(v_creator_email, ''),
          'assignee_names', COALESCE(v_assignee_names, ''),
          'assignee_emails', COALESCE(v_assignee_emails, ''),
          'due_date', COALESCE(NEW.due_date::TEXT, ''),
          'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
          'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
          'message_content', COALESCE(v_message_content, '')
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_task_events ON tasks;
CREATE TRIGGER trg_task_events
  AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION fn_fire_task_events();

-- Search RPCs
CREATE OR REPLACE FUNCTION global_search(p_query TEXT, p_workspace_id UUID, p_limit INT DEFAULT 20) RETURNS TABLE(result_type TEXT, id UUID, title TEXT, subtitle TEXT, avatar_url TEXT, link TEXT, created_at TIMESTAMPTZ, rank REAL) AS $$
BEGIN RETURN QUERY
  SELECT * FROM (
    SELECT 'message'::TEXT, m.id, m.content, c.name, pr.avatar_url, '/channels/' || c.slug || '#message-' || m.id, m.created_at,
      ts_rank(to_tsvector('english', coalesce(m.content, '')), plainto_tsquery('english', p_query))
    FROM messages m JOIN channels c ON c.id = m.channel_id JOIN profiles pr ON pr.id = m.user_id
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = auth.uid()
    WHERE c.workspace_id = p_workspace_id AND m.deleted_at IS NULL AND to_tsvector('english', coalesce(m.content, '')) @@ plainto_tsquery('english', p_query)
    UNION ALL
    SELECT 'channel'::TEXT, c.id, c.name, coalesce(c.description, ''), NULL::TEXT, '/channels/' || c.slug, c.created_at,
      ts_rank(to_tsvector('english', c.name || ' ' || coalesce(c.description, '')), plainto_tsquery('english', p_query))
    FROM channels c WHERE c.workspace_id = p_workspace_id AND c.archived_at IS NULL AND to_tsvector('english', c.name || ' ' || coalesce(c.description, '')) @@ plainto_tsquery('english', p_query)
    UNION ALL
    SELECT 'user'::TEXT, pr.id, coalesce(pr.display_name, pr.username), pr.username, pr.avatar_url, NULL::TEXT, pr.created_at,
      ts_rank(to_tsvector('english', coalesce(pr.display_name, '') || ' ' || coalesce(pr.username, '')), plainto_tsquery('english', p_query))
    FROM profiles pr JOIN workspace_members wm ON wm.user_id = pr.id WHERE wm.workspace_id = p_workspace_id
      AND to_tsvector('english', coalesce(pr.display_name, '') || ' ' || coalesce(pr.username, '')) @@ plainto_tsquery('english', p_query)
  ) all_results ORDER BY rank DESC LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- SECTION 9: GRANT EXECUTE ON ALL FUNCTIONS
-- ============================================================

GRANT EXECUTE ON FUNCTION public.user_is_workspace_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_workspace_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_channel_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_member_for_task(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_assignee(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_creator(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_owner(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_workspace_id(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION create_workspace_with_owner TO authenticated;
GRANT EXECUTE ON FUNCTION accept_workspace_invitation TO authenticated;
GRANT EXECUTE ON FUNCTION change_member_role TO authenticated;
GRANT EXECUTE ON FUNCTION remove_workspace_member TO authenticated;
GRANT EXECUTE ON FUNCTION get_profiles_by_ids TO authenticated;
GRANT EXECUTE ON FUNCTION create_direct_conversation TO authenticated;
GRANT EXECUTE ON FUNCTION create_group_conversation TO authenticated;
GRANT EXECUTE ON FUNCTION record_message_version TO authenticated;
GRANT EXECUTE ON FUNCTION mark_channel_read TO authenticated;
GRANT EXECUTE ON FUNCTION get_unread_count TO authenticated;
GRANT EXECUTE ON FUNCTION get_unread_counts TO authenticated;
GRANT EXECUTE ON FUNCTION mark_conversation_read TO authenticated;
GRANT EXECUTE ON FUNCTION update_user_presence TO authenticated;
GRANT EXECUTE ON FUNCTION touch_presence TO authenticated;
GRANT EXECUTE ON FUNCTION set_user_offline TO authenticated;
GRANT EXECUTE ON FUNCTION mark_message_read TO authenticated;
GRANT EXECUTE ON FUNCTION get_read_receipt_counts TO authenticated;
GRANT EXECUTE ON FUNCTION create_notification TO authenticated;
GRANT EXECUTE ON FUNCTION mark_notification_read TO authenticated;
GRANT EXECUTE ON FUNCTION mark_all_notifications_read TO authenticated;
GRANT EXECUTE ON FUNCTION get_notification_unread_count TO authenticated;
GRANT EXECUTE ON FUNCTION create_task TO authenticated;
GRANT EXECUTE ON FUNCTION update_task_status TO authenticated;
GRANT EXECUTE ON FUNCTION update_task TO authenticated;
GRANT EXECUTE ON FUNCTION delete_task TO authenticated;
GRANT EXECUTE ON FUNCTION archive_task TO authenticated;
GRANT EXECUTE ON FUNCTION restore_task TO authenticated;
GRANT EXECUTE ON FUNCTION message_to_task TO authenticated;
GRANT EXECUTE ON FUNCTION get_workspace_tasks TO authenticated;
GRANT EXECUTE ON FUNCTION create_project TO authenticated;
GRANT EXECUTE ON FUNCTION move_task_to_column TO authenticated;
GRANT EXECUTE ON FUNCTION get_project_member_count TO authenticated;
GRANT EXECUTE ON FUNCTION get_project_members TO authenticated;
GRANT EXECUTE ON FUNCTION add_project_member TO authenticated;
GRANT EXECUTE ON FUNCTION remove_project_member TO authenticated;
GRANT EXECUTE ON FUNCTION get_project_member_ids TO authenticated;
GRANT EXECUTE ON FUNCTION update_project_member_role TO authenticated;
GRANT EXECUTE ON FUNCTION get_pending_reminders TO authenticated;
GRANT EXECUTE ON FUNCTION mark_reminder_notified TO authenticated;
GRANT EXECUTE ON FUNCTION get_personal_planner TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_favorite TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_draft TO authenticated;
GRANT EXECUTE ON FUNCTION record_recent_activity TO authenticated;
GRANT EXECUTE ON FUNCTION global_search TO authenticated;
GRANT EXECUTE ON FUNCTION create_automation_rule TO authenticated;
GRANT EXECUTE ON FUNCTION get_automation_rules TO authenticated;
GRANT EXECUTE ON FUNCTION update_automation_rule TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_automation_rule TO authenticated;
GRANT EXECUTE ON FUNCTION log_automation_execution TO authenticated;
GRANT EXECUTE ON FUNCTION get_execution_logs TO authenticated;
GRANT EXECUTE ON FUNCTION evaluate_automation_rules TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- DONE. Verify:
-- ============================================================
SELECT tablename, COUNT(*) as policy_count
FROM pg_policies WHERE schemaname = 'public'
GROUP BY tablename ORDER BY tablename;

-- ==================== 001_fix_automation_schema.sql ====================
-- ============================================================
-- RUN THIS IN SUPABASE SQL EDITOR TO FIX AUTOMATION SCHEMA
-- This drops the old conflicting tables/functions and recreates them
-- Aligned with 009_phase10_automation.sql event types and column names
-- ============================================================

-- 1. DROP OLD TRIGGERS
DROP TRIGGER IF EXISTS trg_message_posted ON messages;
DROP TRIGGER IF EXISTS trg_task_events ON tasks;

-- 2. DROP OLD FUNCTIONS
DROP FUNCTION IF EXISTS evaluate_automation_rules(UUID, TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS fn_fire_message_posted();
DROP FUNCTION IF EXISTS fn_fire_task_events();
DROP FUNCTION IF EXISTS log_automation_execution(UUID, TEXT, UUID, BOOLEAN, INTEGER, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS update_automation_rule(UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS toggle_automation_rule(UUID);
DROP FUNCTION IF EXISTS get_execution_logs(UUID, UUID);
DROP FUNCTION IF EXISTS get_automation_rules(UUID);

-- 3. DROP OLD TABLES (CASCADE ensures dependencies are cleaned up)
DROP TABLE IF EXISTS automation_execution_logs CASCADE;
DROP TABLE IF EXISTS automation_actions CASCADE;
DROP TABLE IF EXISTS automation_conditions CASCADE;
DROP TABLE IF EXISTS automation_triggers CASCADE;
DROP TABLE IF EXISTS automation_rules CASCADE;

-- 4. CREATE NEW TABLES (with correct columns like sort_order and trigger_event)
CREATE TABLE automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('equals', 'not_equals', 'contains', 'not_contains', 'gt', 'lt', 'gte', 'lte', 'in', 'not_in', 'greater_than', 'less_than', 'is_empty', 'is_not_empty')),
  value TEXT NOT NULL DEFAULT '',
  logic TEXT DEFAULT 'and' CHECK (logic IN ('and', 'or')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('notification', 'send_notification', 'assign_task', 'update_status', 'move_task', 'add_label', 'post_message', 'send_reminder', 'create_task', 'create_event')),
  config JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE automation_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL,
  trigger_entity_id UUID,
  conditions_met BOOLEAN NOT NULL DEFAULT false,
  actions_executed INTEGER DEFAULT 0,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  executed_at TIMESTAMPTZ DEFAULT now()
);

-- 5. CREATE INDEXES
CREATE INDEX idx_automation_rules_workspace ON automation_rules(workspace_id);
CREATE INDEX idx_automation_triggers_rule ON automation_triggers(rule_id);
CREATE INDEX idx_automation_triggers_event ON automation_triggers(event_type);
CREATE INDEX idx_automation_conditions_rule ON automation_conditions(rule_id);
CREATE INDEX idx_automation_actions_rule ON automation_actions(rule_id);
CREATE INDEX idx_automation_logs_rule ON automation_execution_logs(rule_id);
CREATE INDEX idx_automation_logs_executed ON automation_execution_logs(executed_at DESC);

-- 6. ENABLE RLS
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_execution_logs ENABLE ROW LEVEL SECURITY;

-- 7. CREATE POLICIES
CREATE POLICY "Admins can view automation rules"
  ON automation_rules FOR SELECT USING (
    EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

CREATE POLICY "Admins can create automation rules"
  ON automation_rules FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

CREATE POLICY "Admins can update automation rules"
  ON automation_rules FOR UPDATE USING (
    EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

CREATE POLICY "Admins can delete automation rules"
  ON automation_rules FOR DELETE USING (
    EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = automation_rules.workspace_id AND user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

CREATE POLICY "Admins can manage triggers"
  ON automation_triggers FOR ALL USING (
    EXISTS (
      SELECT 1 FROM automation_rules ar
      JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
      WHERE ar.id = automation_triggers.rule_id
    )
  );

CREATE POLICY "Admins can manage conditions"
  ON automation_conditions FOR ALL USING (
    EXISTS (
      SELECT 1 FROM automation_rules ar
      JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
      WHERE ar.id = automation_conditions.rule_id
    )
  );

CREATE POLICY "Admins can manage actions"
  ON automation_actions FOR ALL USING (
    EXISTS (
      SELECT 1 FROM automation_rules ar
      JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
      WHERE ar.id = automation_actions.rule_id
    )
  );

CREATE POLICY "Admins can view execution logs"
  ON automation_execution_logs FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM automation_rules ar
      JOIN workspace_members wm ON wm.workspace_id = ar.workspace_id AND wm.user_id = auth.uid() AND wm.role IN ('owner', 'admin')
      WHERE ar.id = automation_execution_logs.rule_id
    )
  );

CREATE POLICY "System can insert execution logs"
  ON automation_execution_logs FOR INSERT WITH CHECK (true);

-- 8. CREATE RPC FUNCTIONS
CREATE OR REPLACE FUNCTION create_automation_rule(
  p_workspace_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_triggers JSONB DEFAULT '[]',
  p_conditions JSONB DEFAULT '[]',
  p_actions JSONB DEFAULT '[]',
  p_enabled BOOLEAN DEFAULT TRUE
)
RETURNS UUID AS $$
DECLARE
  v_rule_id UUID;
  v_trigger JSONB;
  v_condition JSONB;
  v_action JSONB;
BEGIN
  INSERT INTO automation_rules (workspace_id, name, description, enabled, created_by)
  VALUES (p_workspace_id, p_name, p_description, p_enabled, auth.uid())
  RETURNING id INTO v_rule_id;

  FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers)
  LOOP
    INSERT INTO automation_triggers (rule_id, event_type)
    VALUES (v_rule_id, COALESCE(v_trigger->>'event_type', ''));
  END LOOP;

  FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions)
  LOOP
    INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
    VALUES (v_rule_id, COALESCE(v_condition->>'field', ''), COALESCE(v_condition->>'operator', 'equals'), COALESCE(v_condition->>'value', ''), COALESCE(v_condition->>'logic', 'and'));
  END LOOP;

  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
    VALUES (v_rule_id, COALESCE(v_action->>'action_type', 'post_message'), COALESCE(v_action->'config', '{}'::jsonb), COALESCE((v_action->>'sort_order')::INTEGER, 0));
  END LOOP;

  RETURN v_rule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_automation_rules(p_workspace_id UUID)
RETURNS TABLE(
  rule_id UUID,
  name TEXT,
  description TEXT,
  enabled BOOLEAN,
  trigger_types TEXT[],
  action_count BIGINT,
  last_executed TIMESTAMPTZ,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ar.id AS rule_id,
    ar.name,
    ar.description,
    ar.enabled,
    COALESCE(ARRAY(SELECT at2.event_type FROM automation_triggers at2 WHERE at2.rule_id = ar.id), '{}') AS trigger_types,
    (SELECT COUNT(*) FROM automation_actions aa WHERE aa.rule_id = ar.id) AS action_count,
    (SELECT MAX(ael.executed_at) FROM automation_execution_logs ael WHERE ael.rule_id = ar.id) AS last_executed,
    ar.created_at
  FROM automation_rules ar
  WHERE ar.workspace_id = p_workspace_id
  ORDER BY ar.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION log_automation_execution(
  p_rule_id UUID,
  p_trigger_event TEXT,
  p_trigger_entity_id UUID DEFAULT NULL,
  p_conditions_met BOOLEAN DEFAULT false,
  p_actions_executed INTEGER DEFAULT 0,
  p_success BOOLEAN DEFAULT true,
  p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_log_id UUID;
BEGIN
  INSERT INTO automation_execution_logs (rule_id, trigger_event, trigger_entity_id, conditions_met, actions_executed, success, error_message)
  VALUES (p_rule_id, p_trigger_event, p_trigger_entity_id, p_conditions_met, p_actions_executed, p_success, p_error_message)
  RETURNING id INTO v_log_id;

  IF NOT p_success THEN
    IF (
      SELECT COUNT(*) FROM automation_execution_logs
      WHERE rule_id = p_rule_id AND success = false AND executed_at > now() - INTERVAL '1 hour'
    ) >= 5 THEN
      UPDATE automation_rules SET enabled = false, updated_at = now() WHERE id = p_rule_id;
    END IF;
  END IF;

  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION toggle_automation_rule(p_rule_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_new_state BOOLEAN;
BEGIN
  UPDATE automation_rules SET enabled = NOT enabled, updated_at = now()
  WHERE id = p_rule_id
  RETURNING enabled INTO v_new_state;

  RETURN v_new_state;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_execution_logs(p_workspace_id UUID, p_rule_id UUID DEFAULT NULL)
RETURNS TABLE(
  id UUID,
  rule_id UUID,
  trigger_event TEXT,
  trigger_entity_id UUID,
  conditions_met BOOLEAN,
  actions_executed INTEGER,
  success BOOLEAN,
  error_message TEXT,
  executed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT ael.id, ael.rule_id, ael.trigger_event, ael.trigger_entity_id,
    ael.conditions_met, ael.actions_executed, ael.success, ael.error_message, ael.executed_at
  FROM automation_execution_logs ael
  JOIN automation_rules ar ON ar.id = ael.rule_id
  WHERE ar.workspace_id = p_workspace_id
    AND (p_rule_id IS NULL OR ael.rule_id = p_rule_id)
  ORDER BY ael.executed_at DESC
  LIMIT 100;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_automation_rule(
  p_rule_id UUID,
  p_name TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_enabled BOOLEAN DEFAULT NULL,
  p_triggers JSONB DEFAULT NULL,
  p_conditions JSONB DEFAULT NULL,
  p_actions JSONB DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_trigger JSONB;
  v_condition JSONB;
  v_action JSONB;
BEGIN
  UPDATE automation_rules SET
    name = COALESCE(p_name, name),
    description = COALESCE(p_description, description),
    enabled = COALESCE(p_enabled, enabled),
    updated_at = now()
  WHERE id = p_rule_id;

  IF p_triggers IS NOT NULL THEN
    DELETE FROM automation_triggers WHERE rule_id = p_rule_id;
    FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers)
    LOOP
      INSERT INTO automation_triggers (rule_id, event_type)
      VALUES (p_rule_id, COALESCE(v_trigger->>'event_type', ''));
    END LOOP;
  END IF;

  IF p_conditions IS NOT NULL THEN
    DELETE FROM automation_conditions WHERE rule_id = p_rule_id;
    FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions)
    LOOP
      INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
      VALUES (p_rule_id, COALESCE(v_condition->>'field', ''), COALESCE(v_condition->>'operator', 'equals'), COALESCE(v_condition->>'value', ''), COALESCE(v_condition->>'logic', 'and'));
    END LOOP;
  END IF;

  IF p_actions IS NOT NULL THEN
    DELETE FROM automation_actions WHERE rule_id = p_rule_id;
    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
    LOOP
      INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
      VALUES (p_rule_id, COALESCE(v_action->>'action_type', 'post_message'), COALESCE(v_action->'config', '{}'::jsonb), COALESCE((v_action->>'sort_order')::INTEGER, 0));
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- EXECUTION ENGINE: pg triggers that fire automation rules
-- Event types use dot notation: message.posted, task.created,
-- task.status_changed, task.completed
-- ============================================================

-- Core evaluation function: called by table-level triggers
CREATE OR REPLACE FUNCTION evaluate_automation_rules(
  p_workspace_id UUID,
  p_event_type TEXT,
  p_entity_id UUID,
  p_entity_data JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
DECLARE
  v_rule RECORD;
  v_condition RECORD;
  v_action RECORD;
  v_conditions_met BOOLEAN;
  v_actions_executed INTEGER;
  v_field_value TEXT;
  v_message_user_id UUID;
  v_row_count INTEGER;
  v_num_field NUMERIC;
  v_num_value NUMERIC;
  v_is_numeric BOOLEAN;
  v_numeric_fields TEXT[] := ARRAY['message_length'];
BEGIN
  FOR v_rule IN
    SELECT DISTINCT ar.id AS rule_id
    FROM automation_rules ar
    JOIN automation_triggers at2 ON at2.rule_id = ar.id
    WHERE ar.workspace_id = p_workspace_id
      AND ar.enabled = true
      AND at2.event_type = p_event_type
  LOOP
    v_conditions_met := true;
    v_actions_executed := 0;

    FOR v_condition IN
      SELECT * FROM automation_conditions WHERE rule_id = v_rule.rule_id
    LOOP
      v_field_value := p_entity_data ->> v_condition.field;
      v_is_numeric := v_condition.field = ANY(v_numeric_fields);

      IF v_is_numeric AND v_field_value IS NOT NULL AND v_condition.value IS NOT NULL AND v_field_value != '' AND v_condition.value != '' THEN
        v_num_field := v_field_value::NUMERIC;
        v_num_value := v_condition.value::NUMERIC;
      ELSE
        v_num_field := NULL; v_num_value := NULL;
      END IF;

      CASE v_condition.operator
        WHEN 'equals', 'eq' THEN
          IF v_field_value IS DISTINCT FROM v_condition.value THEN v_conditions_met := false; END IF;
        WHEN 'not_equals', 'neq' THEN
          IF v_field_value = v_condition.value THEN v_conditions_met := false; END IF;
        WHEN 'contains' THEN
          IF v_field_value IS NULL OR v_field_value NOT LIKE '%' || v_condition.value || '%' THEN v_conditions_met := false; END IF;
        WHEN 'not_contains' THEN
          IF v_field_value LIKE '%' || v_condition.value || '%' THEN v_conditions_met := false; END IF;
        WHEN 'gt', 'greater_than' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field <= v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value <= v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'lt', 'less_than' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field >= v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value >= v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'gte' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field < v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value < v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'lte' THEN
          IF v_is_numeric THEN
            IF v_num_field IS NULL OR v_num_value IS NULL OR v_num_field > v_num_value THEN v_conditions_met := false; END IF;
          ELSE
            IF v_field_value IS NULL OR v_field_value > v_condition.value THEN v_conditions_met := false; END IF;
          END IF;
        WHEN 'is_empty' THEN
          IF v_field_value IS NOT NULL AND v_field_value != '' THEN v_conditions_met := false; END IF;
        WHEN 'is_not_empty' THEN
          IF v_field_value IS NULL OR v_field_value = '' THEN v_conditions_met := false; END IF;
        ELSE NULL;
      END CASE;

      EXIT WHEN NOT v_conditions_met;
    END LOOP;

    IF v_conditions_met THEN
      FOR v_action IN
        SELECT * FROM automation_actions WHERE rule_id = v_rule.rule_id ORDER BY sort_order
      LOOP
        IF v_action.action_type = 'post_message' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            IF (v_action.config ->> 'channel_id') IS NOT NULL AND (v_action.config ->> 'channel_id') != '' THEN
              INSERT INTO messages (channel_id, user_id, content)
              VALUES (
                (v_action.config ->> 'channel_id')::UUID,
                v_message_user_id,
                COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              );
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            ELSIF (v_action.config ->> 'channel') IS NOT NULL AND (v_action.config ->> 'channel') != '' THEN
              INSERT INTO messages (channel_id, user_id, content)
              SELECT c.id, v_message_user_id, COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              FROM channels c
              WHERE LOWER(TRIM(c.name)) = LOWER(TRIM(v_action.config ->> 'channel'))
                AND c.workspace_id = p_workspace_id
              LIMIT 1;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            ELSE
              INSERT INTO messages (channel_id, user_id, content)
              SELECT c.id, v_message_user_id, COALESCE(v_action.config ->> 'content', v_action.config ->> 'message', 'Automated message')
              FROM channels c WHERE c.workspace_id = p_workspace_id ORDER BY c.created_at ASC LIMIT 1;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          END IF;

        ELSIF v_action.action_type = 'send_notification' OR v_action.action_type = 'notification' THEN
          IF (v_action.config ->> 'recipients') = 'all_members' THEN
            INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
            SELECT p.user_id,
              COALESCE(v_action.config ->> 'title', 'Automation Notification'),
              COALESCE(v_action.config ->> 'message', COALESCE(v_action.config ->> 'content', 'You have a new notification')),
              'automation', 'automation', p_workspace_id
            FROM workspace_members p WHERE p.workspace_id = p_workspace_id AND p.user_id != COALESCE((p_entity_data ->> 'user_id')::UUID, '00000000-0000-0000-0000-000000000000'::UUID);
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          ELSIF (v_action.config ->> 'recipients') = 'creator' THEN
            v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
            IF v_message_user_id IS NULL THEN SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id; END IF;
            IF v_message_user_id IS NOT NULL THEN
              INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
              VALUES (v_message_user_id,
                COALESCE(v_action.config ->> 'title', 'Automation Notification'),
                COALESCE(v_action.config ->> 'message', COALESCE(v_action.config ->> 'content', 'You have a new notification')),
                'automation', 'automation', p_workspace_id);
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          ELSIF (v_action.config ->> 'recipients') = 'assignee' THEN
            INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
            SELECT ta.user_id,
              COALESCE(v_action.config ->> 'title', 'Automation Notification'),
              COALESCE(v_action.config ->> 'message', COALESCE(v_action.config ->> 'content', 'You have a new notification')),
              'automation', 'automation', p_workspace_id
            FROM task_assignees ta WHERE ta.task_id = p_entity_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          ELSE
            v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
            IF v_message_user_id IS NULL THEN SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id; END IF;
            IF v_message_user_id IS NOT NULL THEN
              INSERT INTO notifications (user_id, title, message, type, category, workspace_id)
              VALUES (v_message_user_id,
                COALESCE(v_action.config ->> 'title', 'Automation Notification'),
                COALESCE(v_action.config ->> 'message', COALESCE(v_action.config ->> 'content', 'You have a new notification')),
                'automation', 'automation', p_workspace_id);
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
            END IF;
          END IF;

        ELSIF v_action.action_type = 'update_status' THEN
          IF p_event_type LIKE 'task.%' THEN
            UPDATE tasks SET status = COALESCE(v_action.config ->> 'status', 'todo'), updated_at = now() WHERE id = p_entity_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;

        ELSIF v_action.action_type = 'create_task' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            DECLARE v_new_task_id UUID;
            BEGIN
              INSERT INTO tasks (workspace_id, title, description, status, priority, created_by)
              VALUES (p_workspace_id,
                COALESCE(NULLIF(v_action.config ->> 'title', ''), 'New Task'),
                NULLIF(v_action.config ->> 'description', ''),
                COALESCE(v_action.config ->> 'status', 'todo'),
                COALESCE(v_action.config ->> 'priority', 'medium'),
                v_message_user_id)
              RETURNING id INTO v_new_task_id;
              GET DIAGNOSTICS v_row_count = ROW_COUNT;
              IF v_row_count > 0 THEN
                v_actions_executed := v_actions_executed + 1;
                IF v_action.config ->> 'assignee' = 'trigger_creator' THEN
                  INSERT INTO task_assignees (task_id, user_id, assigned_by)
                  VALUES (v_new_task_id, v_message_user_id, v_message_user_id)
                  ON CONFLICT (task_id, user_id) DO NOTHING;
                ELSIF v_action.config ->> 'assignee' = 'assignee' THEN
                  INSERT INTO task_assignees (task_id, user_id, assigned_by)
                  SELECT v_new_task_id, v_message_user_id, v_message_user_id
                  WHERE (p_entity_data ->> 'user_id')::UUID IS NOT NULL
                    AND (p_entity_data ->> 'user_id')::UUID != v_message_user_id
                  ON CONFLICT (task_id, user_id) DO NOTHING;
                END IF;
              END IF;
            END;
          END IF;

        ELSIF v_action.action_type = 'send_reminder' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN
            SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id;
          END IF;
          IF v_message_user_id IS NOT NULL THEN
            INSERT INTO notifications (user_id, title, message, type)
            VALUES (v_message_user_id, COALESCE(v_action.config ->> 'title', 'Reminder'), COALESCE(v_action.config ->> 'message', 'You have a reminder'), 'reminder');
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;

        ELSIF v_action.action_type = 'assign_task' THEN
          DECLARE v_assign_to UUID; v_task_id UUID;
          BEGIN
            IF p_event_type LIKE 'task.%' THEN
              v_task_id := p_entity_id;
            ELSE
              SELECT t.id INTO v_task_id FROM tasks t WHERE t.message_id = p_entity_id LIMIT 1;
            END IF;
            IF v_task_id IS NULL THEN
              SELECT t.id INTO v_task_id FROM tasks t WHERE t.id = p_entity_id LIMIT 1;
            END IF;
            IF v_task_id IS NOT NULL THEN
              IF (v_action.config ->> 'assignee') = 'trigger_creator' THEN
                v_assign_to := (p_entity_data ->> 'user_id')::UUID;
                IF v_assign_to IS NULL THEN SELECT created_by INTO v_assign_to FROM automation_rules WHERE id = v_rule.rule_id; END IF;
              ELSIF (v_action.config ->> 'assignee') = 'trigger_assignee' THEN
                v_assign_to := (p_entity_data ->> 'user_id')::UUID;
              ELSIF (v_action.config ->> 'assignee') = 'specific_user' THEN
                SELECT id INTO v_assign_to FROM profiles WHERE LOWER(email) = LOWER(TRIM(v_action.config ->> 'assignee_email'));
              END IF;
              IF v_assign_to IS NOT NULL THEN
                INSERT INTO task_assignees (task_id, user_id, assigned_by)
                VALUES (v_task_id, v_assign_to, COALESCE((p_entity_data ->> 'user_id')::UUID, v_assign_to))
                ON CONFLICT (task_id, user_id) DO NOTHING;
                GET DIAGNOSTICS v_row_count = ROW_COUNT;
                IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
              END IF;
            END IF;
          END;

        ELSIF v_action.action_type = 'create_event' THEN
          v_message_user_id := (p_entity_data ->> 'user_id')::UUID;
          IF v_message_user_id IS NULL THEN SELECT created_by INTO v_message_user_id FROM automation_rules WHERE id = v_rule.rule_id; END IF;
          IF v_message_user_id IS NOT NULL THEN
            INSERT INTO calendar_events (workspace_id, title, description, start_time, end_time, created_by)
            VALUES (
              p_workspace_id,
              COALESCE(v_action.config ->> 'title', 'Automated Event'),
              v_action.config ->> 'description',
              (v_action.config ->> 'start_time')::TIMESTAMPTZ,
              (v_action.config ->> 'end_time')::TIMESTAMPTZ,
              v_message_user_id
            );
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;

        ELSIF v_action.action_type = 'move_task' THEN
          IF p_event_type LIKE 'task.%' THEN
            UPDATE tasks SET column_id = (v_action.config ->> 'column_id')::UUID, updated_at = now() WHERE id = p_entity_id;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;

        ELSIF v_action.action_type = 'add_label' THEN
          IF p_event_type LIKE 'task.%' THEN
            INSERT INTO task_label_assignments (task_id, label_id)
            VALUES (p_entity_id, (v_action.config ->> 'label_id')::UUID)
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS v_row_count = ROW_COUNT;
            IF v_row_count > 0 THEN v_actions_executed := v_actions_executed + 1; END IF;
          END IF;
        END IF;
      END LOOP;

      PERFORM log_automation_execution(
        v_rule.rule_id, p_event_type, p_entity_id,
        true, v_actions_executed, true, NULL
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- TRIGGER FUNCTIONS
-- Uses dot notation event types: message.posted, task.created,
-- task.status_changed, task.completed
-- Includes pg_trigger_depth() guard to prevent recursive triggers
-- ============================================================

CREATE OR REPLACE FUNCTION fn_fire_message_posted()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_channel_name TEXT;
  v_creator_name TEXT;
  v_creator_email TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT workspace_id, name INTO v_workspace_id, v_channel_name FROM channels WHERE id = NEW.channel_id;
  IF v_workspace_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, username, split_part(email, '@', 1)), email
    INTO v_creator_name, v_creator_email
    FROM profiles WHERE id = NEW.user_id;

  PERFORM evaluate_automation_rules(
    v_workspace_id, 'message.posted', NEW.id,
    jsonb_build_object(
      'channel_id', NEW.channel_id::TEXT,
      'channel_name', COALESCE(v_channel_name, ''),
      'content', COALESCE(NEW.content, ''),
      'user_id', NEW.user_id::TEXT,
      'creator', COALESCE(v_creator_name, ''),
      'creator_email', COALESCE(v_creator_email, ''),
      'message_length', COALESCE(length(NEW.content), 0)::TEXT
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_message_posted ON messages;
CREATE TRIGGER trg_message_posted
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION fn_fire_message_posted();

CREATE OR REPLACE FUNCTION fn_fire_task_events()
RETURNS TRIGGER AS $$
DECLARE
  v_creator_name TEXT;
  v_creator_email TEXT;
  v_assignee_names TEXT;
  v_assignee_emails TEXT;
  v_project_name TEXT;
  v_message_content TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, username, split_part(email, '@', 1)), email
    INTO v_creator_name, v_creator_email
    FROM profiles WHERE id = NEW.created_by;

  SELECT string_agg(COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), ', ')
    INTO v_assignee_names
    FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
    WHERE ta.task_id = NEW.id;

  SELECT string_agg(p.email, ', ')
    INTO v_assignee_emails
    FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
    WHERE ta.task_id = NEW.id;

  SELECT name INTO v_project_name FROM projects WHERE id = NEW.project_id;

  SELECT m.content INTO v_message_content FROM messages m WHERE m.id = NEW.message_id;

  IF TG_OP = 'INSERT' THEN
    PERFORM evaluate_automation_rules(
      NEW.workspace_id, 'task.created', NEW.id,
      jsonb_build_object(
        'status', NEW.status,
        'priority', NEW.priority,
        'project_id', COALESCE(NEW.project_id::TEXT, ''),
        'project_name', COALESCE(v_project_name, ''),
        'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
        'user_id', NEW.created_by::TEXT,
        'creator', COALESCE(v_creator_name, ''),
        'creator_email', COALESCE(v_creator_email, ''),
        'assignee_names', COALESCE(v_assignee_names, ''),
        'assignee_emails', COALESCE(v_assignee_emails, ''),
        'due_date', COALESCE(NEW.due_date::TEXT, ''),
        'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
        'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
        'message_content', COALESCE(v_message_content, '')
      )
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM evaluate_automation_rules(
      NEW.workspace_id, 'task.status_changed', NEW.id,
      jsonb_build_object(
        'status', NEW.status,
        'old_status', OLD.status,
        'priority', NEW.priority,
        'project_id', COALESCE(NEW.project_id::TEXT, ''),
        'project_name', COALESCE(v_project_name, ''),
        'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
        'user_id', NEW.created_by::TEXT,
        'creator', COALESCE(v_creator_name, ''),
        'creator_email', COALESCE(v_creator_email, ''),
        'assignee_names', COALESCE(v_assignee_names, ''),
        'assignee_emails', COALESCE(v_assignee_emails, ''),
        'due_date', COALESCE(NEW.due_date::TEXT, ''),
        'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
        'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
        'message_content', COALESCE(v_message_content, '')
      )
    );
    IF NEW.status = 'completed' THEN
      PERFORM evaluate_automation_rules(
        NEW.workspace_id, 'task.completed', NEW.id,
        jsonb_build_object(
          'status', NEW.status,
          'priority', NEW.priority,
          'project_id', COALESCE(NEW.project_id::TEXT, ''),
          'project_name', COALESCE(v_project_name, ''),
          'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
          'user_id', NEW.created_by::TEXT,
          'creator', COALESCE(v_creator_name, ''),
          'creator_email', COALESCE(v_creator_email, ''),
          'assignee_names', COALESCE(v_assignee_names, ''),
          'assignee_emails', COALESCE(v_assignee_emails, ''),
          'due_date', COALESCE(NEW.due_date::TEXT, ''),
          'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
          'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
          'message_content', COALESCE(v_message_content, '')
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_task_events ON tasks;
CREATE TRIGGER trg_task_events
  AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION fn_fire_task_events();

-- ==================== 002_fix_projects_rls.sql ====================
-- ============================================================
-- FIX: Drop ALL conflicting RLS policies on projects-related
-- tables and recreate clean ones.
--
-- The 500 error on PATCH /projects is caused by two overlapping
-- sets of policies creating nested RLS evaluation chains that
-- exceed PostgreSQL's stack depth limit.
--
-- Run this AFTER EVERYTHING_RUN_ME.sql
-- ============================================================

-- ── projects ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "projects_select" ON public.projects;
DROP POLICY IF EXISTS "projects_insert" ON public.projects;
DROP POLICY IF EXISTS "projects_update" ON public.projects;
DROP POLICY IF EXISTS "projects_delete" ON public.projects;
DROP POLICY IF EXISTS "Workspace members can view projects" ON public.projects;
DROP POLICY IF EXISTS "Workspace members can create projects" ON public.projects;
DROP POLICY IF EXISTS "Project owner or admin can update projects" ON public.projects;
DROP POLICY IF EXISTS "Project owner or workspace admin can delete projects" ON public.projects;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (
    is_workspace_member(workspace_id)
  );

CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT WITH CHECK (
    auth.uid() = owner_id
    AND is_workspace_member(workspace_id)
  );

CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (
    auth.uid() = owner_id
    OR is_project_admin(id)
    OR is_workspace_admin(workspace_id)
  );

CREATE POLICY "projects_delete" ON public.projects
  FOR DELETE USING (
    auth.uid() = owner_id
    OR is_workspace_admin(workspace_id)
  );

-- ── project_members ───────────────────────────────────────────
DROP POLICY IF EXISTS "project_members_select" ON public.project_members;
DROP POLICY IF EXISTS "project_members_insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members_delete" ON public.project_members;
DROP POLICY IF EXISTS "Project members can view project members" ON public.project_members;
DROP POLICY IF EXISTS "Project owners can manage members" ON public.project_members;
DROP POLICY IF EXISTS "Project owners or admins can remove members" ON public.project_members;

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_members_select" ON public.project_members
  FOR SELECT USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_members.project_id)
    )
  );

CREATE POLICY "project_members_insert" ON public.project_members
  FOR INSERT WITH CHECK (
    is_project_admin(project_id)
    OR is_workspace_admin(
      (SELECT workspace_id FROM public.projects WHERE id = project_members.project_id)
    )
  );

CREATE POLICY "project_members_delete" ON public.project_members
  FOR DELETE USING (
    is_project_admin(project_id)
    OR is_workspace_admin(
      (SELECT workspace_id FROM public.projects WHERE id = project_members.project_id)
    )
  );

-- ── project_columns ───────────────────────────────────────────
DROP POLICY IF EXISTS "project_columns_select" ON public.project_columns;
DROP POLICY IF EXISTS "project_columns_insert" ON public.project_columns;
DROP POLICY IF EXISTS "project_columns_update" ON public.project_columns;
DROP POLICY IF EXISTS "project_columns_delete" ON public.project_columns;
DROP POLICY IF EXISTS "Project members can view columns" ON public.project_columns;
DROP POLICY IF EXISTS "Project members can manage columns" ON public.project_columns;

ALTER TABLE public.project_columns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_columns_select" ON public.project_columns
  FOR SELECT USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_columns.project_id)
    )
  );

CREATE POLICY "project_columns_insert" ON public.project_columns
  FOR INSERT WITH CHECK (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_columns.project_id)
    )
  );

CREATE POLICY "project_columns_update" ON public.project_columns
  FOR UPDATE USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_columns.project_id)
    )
  );

CREATE POLICY "project_columns_delete" ON public.project_columns
  FOR DELETE USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_columns.project_id)
    )
  );

-- ── project_milestones ────────────────────────────────────────
DROP POLICY IF EXISTS "project_milestones_select" ON public.project_milestones;
DROP POLICY IF EXISTS "project_milestones_insert" ON public.project_milestones;
DROP POLICY IF EXISTS "project_milestones_update" ON public.project_milestones;
DROP POLICY IF EXISTS "project_milestones_delete" ON public.project_milestones;
DROP POLICY IF EXISTS "Project members can view milestones" ON public.project_milestones;
DROP POLICY IF EXISTS "Project members can manage milestones" ON public.project_milestones;

ALTER TABLE public.project_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_milestones_select" ON public.project_milestones
  FOR SELECT USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_milestones.project_id)
    )
  );

CREATE POLICY "project_milestones_insert" ON public.project_milestones
  FOR INSERT WITH CHECK (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_milestones.project_id)
    )
  );

CREATE POLICY "project_milestones_update" ON public.project_milestones
  FOR UPDATE USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_milestones.project_id)
    )
  );

CREATE POLICY "project_milestones_delete" ON public.project_milestones
  FOR DELETE USING (
    is_workspace_member(
      (SELECT workspace_id FROM public.projects WHERE id = project_milestones.project_id)
    )
  );

-- ==================== 003_fix_invitation_workspace_rls.sql ====================
-- Allow invited users to read workspace data for invitations they received
-- This fixes "Unknown workspace" showing in invitation cards
-- Uses auth.email() instead of querying auth.users directly (causes 42501)
DROP POLICY IF EXISTS "workspaces_select_for_invited" ON workspaces;

CREATE POLICY "workspaces_select_for_invited"
  ON workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invitations
      WHERE invitations.workspace_id = workspaces.id
      AND lower(invitations.email) = lower(auth.email())
      AND invitations.status IN ('pending', 'accepted')
    )
  );

-- ==================== 004_fix_users_permission_error.sql ====================
-- ============================================================
-- CLEANUP: Fix "permission denied for table users" error
-- The old workspaces_select_for_invited policy queried auth.users
-- directly, which the authenticated role cannot access.
-- Run this ONCE to drop and recreate the broken policy.
-- ============================================================

-- 1. Drop the broken policy (idempotent)
DROP POLICY IF EXISTS "workspaces_select_for_invited" ON workspaces;

-- 2. Recreate with auth.email() instead of auth.users
CREATE POLICY "workspaces_select_for_invited"
  ON workspaces FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invitations
      WHERE invitations.workspace_id = workspaces.id
      AND lower(invitations.email) = lower(auth.email())
      AND invitations.status IN ('pending', 'accepted')
    )
  );

-- 3. Also fix invitations SELECT policy if it was broken
DROP POLICY IF EXISTS "inv_select" ON invitations;
DROP POLICY IF EXISTS "invitations_select" ON invitations;
DROP POLICY IF EXISTS "invitations_select_members" ON invitations;

CREATE POLICY "inv_select" ON invitations FOR SELECT TO authenticated USING (
  public.user_is_workspace_member(invitations.workspace_id, auth.uid())
  OR lower(invitations.email) = lower(auth.email())
);

NOTIFY pgrst, 'reload schema';

-- ==================== 005_scheduled_message_attachments.sql ====================
-- 005_scheduled_message_attachments.sql
-- Adds a table for storing file attachments on scheduled messages

CREATE TABLE IF NOT EXISTS scheduled_message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_message_id UUID NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE scheduled_message_attachments ENABLE ROW LEVEL SECURITY;

-- Users can read attachments for their own scheduled messages
DROP POLICY IF EXISTS "scheduled_msg_attach_select_own" ON scheduled_message_attachments;
CREATE POLICY "scheduled_msg_attach_select_own"
  ON scheduled_message_attachments FOR SELECT
  USING (
    scheduled_message_id IN (
      SELECT id FROM scheduled_messages WHERE user_id = auth.uid()
    )
  );

-- Users can insert attachments for their own scheduled messages
DROP POLICY IF EXISTS "scheduled_msg_attach_insert_own" ON scheduled_message_attachments;
CREATE POLICY "scheduled_msg_attach_insert_own"
  ON scheduled_message_attachments FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND scheduled_message_id IN (
      SELECT id FROM scheduled_messages WHERE user_id = auth.uid()
    )
  );

-- Users can delete attachments for their own scheduled messages
DROP POLICY IF EXISTS "scheduled_msg_attach_delete_own" ON scheduled_message_attachments;
CREATE POLICY "scheduled_msg_attach_delete_own"
  ON scheduled_message_attachments FOR DELETE
  USING (
    scheduled_message_id IN (
      SELECT id FROM scheduled_messages WHERE user_id = auth.uid()
    )
  );

-- Index for efficient lookup when dispatching scheduled messages
CREATE INDEX IF NOT EXISTS idx_scheduled_msg_attach_msg_id
  ON scheduled_message_attachments(scheduled_message_id);

-- ==================== 006_missing_rpc_functions.sql ====================
-- ============================================================
-- 006: Missing RPC Functions
-- Run this AFTER 000-005
-- ============================================================

-- 1. get_workspace_member_count: used in Home page stats
CREATE OR REPLACE FUNCTION public.get_workspace_member_count(p_workspace_id UUID)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT count(*)::BIGINT
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id;
$$;
GRANT EXECUTE ON FUNCTION public.get_workspace_member_count(UUID) TO authenticated;

-- 2. transfer_workspace_ownership: used in workspace settings
CREATE OR REPLACE FUNCTION public.transfer_workspace_ownership(
  p_workspace_id UUID,
  p_new_owner_id UUID,
  p_caller_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_role TEXT;
  v_new_owner_role TEXT;
BEGIN
  SELECT role INTO v_caller_role
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_caller_id AND status = 'active';

  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RETURN json_build_object('error', 'Only the workspace owner can transfer ownership');
  END IF;

  SELECT role INTO v_new_owner_role
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id AND status = 'active';

  IF v_new_owner_role IS NULL THEN
    RETURN json_build_object('error', 'New owner must be a workspace member');
  END IF;

  UPDATE public.workspace_members SET role = 'admin'
  WHERE workspace_id = p_workspace_id AND user_id = p_caller_id;

  UPDATE public.workspace_members SET role = 'owner'
  WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id;

  UPDATE public.workspaces SET owner_id = p_new_owner_id
  WHERE id = p_workspace_id;

  RETURN json_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.transfer_workspace_ownership(UUID, UUID, UUID) TO authenticated;

-- 3. get_events_participants: fetch participants for multiple calendar events
CREATE OR REPLACE FUNCTION public.get_events_participants(p_event_ids UUID[])
RETURNS TABLE(event_id UUID, user_id UUID, display_name TEXT, avatar_url TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT ep.event_id, ep.user_id, COALESCE(p.display_name, p.email, 'Unknown') AS display_name, p.avatar_url
  FROM public.event_participants ep
  LEFT JOIN public.profiles p ON p.id = ep.user_id
  WHERE ep.event_id = ANY(p_event_ids);
$$;
GRANT EXECUTE ON FUNCTION public.get_events_participants(UUID[]) TO authenticated;

-- 4. add_event_participant: add a user to a calendar event
CREATE OR REPLACE FUNCTION public.add_event_participant(
  p_event_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  INSERT INTO public.event_participants (event_id, user_id)
  VALUES (p_event_id, p_user_id)
  ON CONFLICT (event_id, user_id) DO NOTHING;
$$;
GRANT EXECUTE ON FUNCTION public.add_event_participant(UUID, UUID) TO authenticated;

-- 5. remove_event_participant_by_id: remove a participant by their participant row id
CREATE OR REPLACE FUNCTION public.remove_event_participant_by_id(p_participant_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  DELETE FROM public.event_participants WHERE id = p_participant_id;
$$;
GRANT EXECUTE ON FUNCTION public.remove_event_participant_by_id(UUID) TO authenticated;

-- 6. mark_channel_read_up_to: mark all messages up to a timestamp as read
CREATE OR REPLACE FUNCTION public.mark_channel_read_up_to(
  p_channel_id UUID,
  p_user_id UUID,
  p_up_to TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.read_receipts (user_id, message_id, channel_id, read_at)
  SELECT
    p_user_id,
    m.id,
    p_channel_id,
    LEAST(m.created_at, p_up_to)
  FROM public.messages m
  WHERE m.channel_id = p_channel_id
    AND m.created_at <= p_up_to
    AND m.user_id != p_user_id
    AND NOT EXISTS (
      SELECT 1 FROM public.read_receipts rr
      WHERE rr.user_id = p_user_id AND rr.message_id = m.id
    )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.channel_members (user_id, channel_id, last_read_at)
  VALUES (p_user_id, p_channel_id, p_up_to)
  ON CONFLICT (user_id, channel_id)
  DO UPDATE SET last_read_at = GREATEST(channel_members.last_read_at, p_up_to);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_channel_read_up_to(UUID, UUID, TIMESTAMPTZ) TO authenticated;

-- ==================== 007_fix_projects_visibility.sql ====================
-- ============================================================
-- FIX: Projects visibility enforcement
--
-- The current projects_select policy allows ALL workspace members
-- to see ALL projects regardless of visibility setting.
-- This fix enforces:
--   'workspace'  -> any workspace member can see
--   'members'    -> only project members can see
--   'private'    -> only the project owner can see
--
-- Run this AFTER 002_fix_projects_rls.sql
-- ============================================================

DROP POLICY IF EXISTS "projects_select" ON public.projects;

CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (
    -- Owner can always see their own projects
    auth.uid() = owner_id
    OR
    -- 'workspace' visibility: any workspace member can see
    (
      visibility = 'workspace'
      AND is_workspace_member(workspace_id)
    )
    OR
    -- 'members' visibility: only project members can see
    (
      visibility = 'members'
      AND is_project_member(id, auth.uid())
    )
    OR
    -- workspace admins can always see all projects
    is_workspace_admin(workspace_id)
  );

-- ==================== 008_fix_tasks_visibility.sql ====================
-- ============================================================
-- FIX: Tasks visibility enforcement
--
-- The current tasks_select policy allows ALL workspace members
-- to see ALL tasks. This fix restricts visibility to:
--   - Task creator
--   - Task assignees
--   - Workspace admins
--
-- Run this AFTER 003_fix_projects_visibility.sql
-- ============================================================

DROP POLICY IF EXISTS "tasks_select" ON public.tasks;

CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT USING (
    -- Creator can always see their own tasks
    auth.uid() = created_by
    OR
    -- Assignees can see tasks assigned to them
    is_task_assignee(id, auth.uid())
    OR
    -- Workspace admins can see all tasks
    is_workspace_admin(workspace_id)
  );

-- ==================== 009_task_custom_statuses.sql ====================
-- Per-task custom statuses
CREATE TABLE IF NOT EXISTS task_custom_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE task_custom_statuses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users can manage custom statuses for tasks they can access' AND tablename = 'task_custom_statuses'
  ) THEN
    CREATE POLICY "Users can manage custom statuses for tasks they can access"
      ON task_custom_statuses
      FOR ALL
      USING (
        task_id IN (
          SELECT t.id FROM tasks t
          WHERE t.workspace_id IN (
            SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = auth.uid()
          )
        )
      )
      WITH CHECK (
        task_id IN (
          SELECT t.id FROM tasks t
          WHERE t.workspace_id IN (
            SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = auth.uid()
          )
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_custom_statuses_task_id ON task_custom_statuses(task_id);

-- ==================== 010_task_status_order.sql ====================
-- Store the full status order (defaults + customs) per task as JSON array
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_order JSONB;

-- Populate existing tasks with default order
UPDATE tasks SET status_order = '["backlog","todo","in_progress","review","completed","cancelled"]'::jsonb
WHERE status_order IS NULL;

-- Trigger: clean status_order when a custom status is deleted
CREATE OR REPLACE FUNCTION remove_status_from_order()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tasks
  SET status_order = (
    SELECT COALESCE(
      (
        SELECT jsonb_agg(elem)
        FROM jsonb_array_elements_text(tasks.status_order) AS elem
        WHERE elem != OLD.id::text
      ),
      '["backlog","todo","in_progress","review","completed","cancelled"]'::jsonb
    )
  )
  WHERE id = OLD.task_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_remove_status_from_order ON task_custom_statuses;
CREATE TRIGGER trg_remove_status_from_order
  AFTER DELETE ON task_custom_statuses
  FOR EACH ROW
  EXECUTE FUNCTION remove_status_from_order();

-- Trigger: append new custom status to task's status_order on insert
CREATE OR REPLACE FUNCTION add_status_to_order()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tasks
  SET status_order = COALESCE(status_order, '["backlog","todo","in_progress","review","completed","cancelled"]'::jsonb) || to_jsonb(NEW.id::text)
  WHERE id = NEW.task_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_add_status_to_order ON task_custom_statuses;
CREATE TRIGGER trg_add_status_to_order
  AFTER INSERT ON task_custom_statuses
  FOR EACH ROW
  EXECUTE FUNCTION add_status_to_order();

-- ==================== 011_allow_custom_status_values.sql ====================
-- Remove the CHECK constraint on tasks.status so custom status UUIDs can be stored
-- Custom statuses are stored in task_custom_statuses and referenced by UUID in tasks.status
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

-- ==================== 012_add_direct_conversations_realtime.sql ====================
-- 012_add_direct_conversations_realtime.sql
-- Enable realtime for direct_conversations and channels so sidebar updates in real time

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE direct_conversations; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE channels; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ==================== 013_01drop_old_policies.sql ====================
-- Run this BEFORE 013_02voice_calling.sql
--
-- Drops are guarded by a table-existence check. On a fresh database neither
-- call_sessions nor call_participants exist yet (they are created by
-- 013_02voice_calling.sql), so this is a no-op. On an existing database the
-- old policies are dropped before being recreated with the correct definitions.

DO $$ BEGIN
  IF to_regclass('public.call_sessions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "call_sessions_select_workspace" ON public.call_sessions';
    EXECUTE 'DROP POLICY IF EXISTS "call_sessions_insert_auth" ON public.call_sessions';
    EXECUTE 'DROP POLICY IF EXISTS "call_sessions_update_creator" ON public.call_sessions';
    EXECUTE 'DROP POLICY IF EXISTS "call_sessions_delete_creator" ON public.call_sessions';
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.call_participants') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "call_participants_select" ON public.call_participants';
    EXECUTE 'DROP POLICY IF EXISTS "call_participants_insert" ON public.call_participants';
    EXECUTE 'DROP POLICY IF EXISTS "call_participants_update" ON public.call_participants';
  END IF;
END $$;

-- ==================== 013_02voice_calling.sql ====================
-- 013_voice_calling.sql
-- Phase 11.1: Voice Calling - Database Schema

-- Call sessions table
CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES direct_conversations(id) ON DELETE SET NULL,
  call_type TEXT NOT NULL DEFAULT 'direct' CHECK (call_type IN ('direct', 'group', 'channel')),
  with_video BOOLEAN DEFAULT false,
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined', 'cancelled')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Call participants table
CREATE TABLE IF NOT EXISTS call_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'ringing', 'connected', 'disconnected', 'declined', 'left')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  is_muted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(call_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_call_sessions_workspace ON call_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_channel ON call_sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_conversation ON call_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_sessions_created_by ON call_sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants(call_id);
CREATE INDEX IF NOT EXISTS idx_call_participants_user ON call_participants(user_id);

-- RLS policies
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;

-- call_sessions: workspace members can view, authenticated can insert their own
DO $$ BEGIN
  CREATE POLICY "call_sessions_select_workspace" ON call_sessions
    FOR SELECT USING (is_workspace_member(workspace_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "call_sessions_insert_auth" ON call_sessions
    FOR INSERT WITH CHECK (auth.uid() = created_by);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "call_sessions_update_creator" ON call_sessions
    FOR UPDATE USING (
      auth.uid() = created_by
      OR auth.uid() IN (SELECT user_id FROM call_participants WHERE call_id = id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "call_sessions_delete_creator" ON call_sessions
    FOR DELETE USING (auth.uid() = created_by);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- call_participants: workspace members can view all participants of calls in their workspace
DO $$ BEGIN
  CREATE POLICY "call_participants_select" ON call_participants
    FOR SELECT USING (
      is_workspace_member((SELECT workspace_id FROM call_sessions WHERE id = call_id))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "call_participants_insert" ON call_participants
    FOR INSERT WITH CHECK (
      auth.uid() = user_id
      OR auth.uid() IN (SELECT created_by FROM call_sessions WHERE id = call_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "call_participants_update" ON call_participants
    FOR UPDATE USING (
      auth.uid() = user_id
      OR auth.uid() IN (SELECT created_by FROM call_sessions WHERE id = call_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enable realtime
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_sessions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_participants; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ensure full row data in realtime payloads (critical for UPDATE events)
ALTER TABLE call_sessions REPLICA IDENTITY FULL;
ALTER TABLE call_participants REPLICA IDENTITY FULL;

-- ==================== 014_calling_fixes.sql ====================
-- 014_calling_fixes.sql
-- Fix voice/video calling: add with_video flag, fix started_at timing

-- Add with_video column to distinguish voice vs video calls
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS with_video BOOLEAN DEFAULT false;

-- Fix started_at: should be set when call is answered, not on creation
ALTER TABLE call_sessions ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE call_sessions ALTER COLUMN started_at DROP DEFAULT;

-- ==================== 015_calling_rls_fix.sql ====================
-- 015_calling_rls_fix.sql
-- Fix call_participants RLS so both caller and called user can see all participants

-- Fix SELECT: allow any workspace member to see all participants of calls in their workspace
DROP POLICY IF EXISTS "call_participants_select" ON call_participants;

CREATE POLICY "call_participants_select" ON call_participants
  FOR SELECT USING (
    is_workspace_member((SELECT workspace_id FROM call_sessions WHERE id = call_id))
  );

-- ==================== 016_call_signaling.sql ====================
-- 016_call_signaling.sql
-- Database-backed WebRTC signaling (replaces unreliable Broadcast channels)
-- Run this AFTER 013_02voice_calling.sql

CREATE TABLE IF NOT EXISTS call_signaling (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('offer', 'answer', 'ice-candidate', 'end-call')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for efficient delivery queries
CREATE INDEX IF NOT EXISTS idx_call_signaling_delivery ON call_signaling (to_user_id, call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_signaling_call ON call_signaling (call_id);

-- RLS
ALTER TABLE call_signaling ENABLE ROW LEVEL SECURITY;

-- Participants can read messages addressed to them
DO $$ BEGIN
  CREATE POLICY "call_signaling_select" ON call_signaling
    FOR SELECT USING (to_user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Authenticated users can insert messages they send
DO $$ BEGIN
  CREATE POLICY "call_signaling_insert" ON call_signaling
    FOR INSERT WITH CHECK (from_user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Creator of the call can clean up signaling rows
DO $$ BEGIN
  CREATE POLICY "call_signaling_delete" ON call_signaling
    FOR DELETE USING (
      call_id IN (SELECT id FROM call_sessions WHERE created_by = auth.uid())
      OR to_user_id = auth.uid()
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enable realtime
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_signaling; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE call_signaling REPLICA IDENTITY FULL;

-- Cleanup function for old signaling rows (call periodically or on call end)
CREATE OR REPLACE FUNCTION cleanup_call_signaling(p_call_id UUID DEFAULT NULL)
RETURNS void AS $$
BEGIN
  IF p_call_id IS NOT NULL THEN
    DELETE FROM call_signaling WHERE call_id = p_call_id;
  ELSE
    DELETE FROM call_signaling WHERE created_at < now() - interval '1 hour';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================== 017_profile_timezone.sql ====================
-- Add timezone column to profiles so members can see each other's local time
-- Value is an IANA timezone name (e.g. 'Europe/Paris') auto-detected on the client
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS timezone TEXT;

-- ==================== 018_audit_log.sql ====================
-- ============================================================
-- AUDIT LOG
-- Workspace-scoped audit trail for admin visibility.
-- Reads are admin-only; writes happen via SECURITY DEFINER
-- RPCs and DB triggers (app users cannot insert directly).
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_select_admin" ON audit_log;
CREATE POLICY "audit_log_select_admin" ON audit_log FOR SELECT TO authenticated
  USING (is_workspace_admin(workspace_id));

CREATE INDEX IF NOT EXISTS audit_log_workspace_created_idx ON audit_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id);

-- RPC used by the app for actions that don't map to a DB trigger
CREATE OR REPLACE FUNCTION public.write_audit_log(
  p_workspace_id UUID,
  p_action TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS VOID AS $$
BEGIN
  IF NOT is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION 'No permission.';
  END IF;
  INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (p_workspace_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_metadata);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Server-side coverage for the most important events
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_audit_trigger() RETURNS TRIGGER AS $$
DECLARE v_workspace_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'workspace_members' THEN
    v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_workspace_id,
      auth.uid(),
      CASE WHEN TG_OP = 'INSERT' THEN 'member_joined' ELSE 'member_left' END,
      'workspace_member',
      COALESCE(NEW.user_id, OLD.user_id),
      jsonb_build_object('user_id', COALESCE(NEW.user_id, OLD.user_id))
    );
  ELSIF TG_TABLE_NAME = 'channels' THEN
    v_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
    INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      v_workspace_id,
      auth.uid(),
      'channel_' || lower(TG_OP),
      'channel',
      COALESCE(NEW.id, OLD.id),
      jsonb_build_object('name', COALESCE(NEW.name, OLD.name), 'is_private', COALESCE(NEW.is_private, OLD.is_private))
    );
  ELSIF TG_TABLE_NAME = 'messages' AND TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT workspace_id INTO v_workspace_id FROM channels WHERE id = OLD.channel_id;
    IF v_workspace_id IS NOT NULL THEN
      INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, metadata)
      VALUES (v_workspace_id, auth.uid(), 'message_deleted', 'message', OLD.id, jsonb_build_object('channel_id', OLD.channel_id));
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_member_added ON workspace_members;
CREATE TRIGGER trg_audit_member_added
  AFTER INSERT ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit_member_removed ON workspace_members;
CREATE TRIGGER trg_audit_member_removed
  AFTER DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit_channel ON channels;
CREATE TRIGGER trg_audit_channel
  AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit_message_deleted ON messages;
CREATE TRIGGER trg_audit_message_deleted
  AFTER UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_trigger();

-- ==================== 019_workspace_settings.sql ====================
-- ============================================================
-- WORKSPACE SETTINGS
-- Per-workspace preferences:
--   default_channel_ids  channels new members auto-join on invitation accept
--   retention_days       auto-hide messages older than N days (0 = disabled)
--   quiet_hours_start/end 24h clock times (HH:MM, 24h) for notification suppression
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_channel_ids UUID[] DEFAULT '{}',
  retention_days INTEGER DEFAULT 0,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_settings_select" ON workspace_settings;
CREATE POLICY "workspace_settings_select" ON workspace_settings FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id));
DROP POLICY IF EXISTS "workspace_settings_insert" ON workspace_settings;
CREATE POLICY "workspace_settings_insert" ON workspace_settings FOR INSERT TO authenticated
  WITH CHECK (is_workspace_admin(workspace_id));
DROP POLICY IF EXISTS "workspace_settings_update" ON workspace_settings;
CREATE POLICY "workspace_settings_update" ON workspace_settings FOR UPDATE TO authenticated
  USING (is_workspace_admin(workspace_id));

-- Upsert settings (admin only)
CREATE OR REPLACE FUNCTION public.upsert_workspace_settings(
  p_workspace_id UUID,
  p_default_channel_ids UUID[] DEFAULT NULL,
  p_retention_days INTEGER DEFAULT NULL,
  p_quiet_hours_start TEXT DEFAULT NULL,
  p_quiet_hours_end TEXT DEFAULT NULL
) RETURNS JSON AS $$
BEGIN
  IF NOT is_workspace_admin(p_workspace_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  INSERT INTO workspace_settings (workspace_id, default_channel_ids, retention_days, quiet_hours_start, quiet_hours_end, updated_by)
  VALUES (p_workspace_id, COALESCE(p_default_channel_ids, '{}'), COALESCE(p_retention_days, 0), p_quiet_hours_start, p_quiet_hours_end, auth.uid())
  ON CONFLICT (workspace_id) DO UPDATE SET
    default_channel_ids = COALESCE(EXCLUDED.default_channel_ids, workspace_settings.default_channel_ids),
    retention_days = COALESCE(EXCLUDED.retention_days, workspace_settings.retention_days),
    quiet_hours_start = COALESCE(EXCLUDED.quiet_hours_start, workspace_settings.quiet_hours_start),
    quiet_hours_end = COALESCE(EXCLUDED.quiet_hours_end, workspace_settings.quiet_hours_end),
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Read settings (workspace members)
CREATE OR REPLACE FUNCTION public.get_workspace_settings(p_workspace_id UUID) RETURNS JSON AS $$
DECLARE v_row workspace_settings%ROWTYPE;
BEGIN
  IF NOT is_workspace_member(p_workspace_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  SELECT * INTO v_row FROM workspace_settings WHERE workspace_id = p_workspace_id;
  IF v_row.workspace_id IS NULL THEN
    RETURN json_build_object(
      'workspace_id', p_workspace_id,
      'default_channel_ids', '{}'::json,
      'retention_days', 0,
      'quiet_hours_start', NULL::text,
      'quiet_hours_end', NULL::text
    );
  END IF;

  RETURN json_build_object(
    'workspace_id', v_row.workspace_id,
    'default_channel_ids', v_row.default_channel_ids,
    'retention_days', v_row.retention_days,
    'quiet_hours_start', v_row.quiet_hours_start,
    'quiet_hours_end', v_row.quiet_hours_end
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Soft-delete (hide) messages older than the retention window in workspaces
-- that have retention enabled. Callable periodically (e.g. a cron job).
CREATE OR REPLACE FUNCTION public.apply_message_retention() RETURNS BIGINT AS $$
DECLARE v_deleted BIGINT;
BEGIN
  UPDATE messages m SET deleted_at = now()
  FROM workspace_settings s
  WHERE s.workspace_id = (SELECT workspace_id FROM channels WHERE id = m.channel_id)
    AND s.retention_days > 0
    AND m.deleted_at IS NULL
    AND m.created_at < now() - (s.retention_days || ' days')::interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- AUTO-JOIN DEFAULT CHANNELS ON INVITATION ACCEPT
-- ============================================================

CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_invitation_id UUID, p_user_id UUID, p_user_email TEXT DEFAULT NULL) RETURNS JSON AS $$
DECLARE v_invitation RECORD; v_existing_member UUID; v_channel_id UUID;
BEGIN
  SELECT * INTO v_invitation FROM invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN RETURN json_build_object('success', false, 'error', 'Invitation not found.'); END IF;
  IF v_invitation.status != 'pending' THEN RETURN json_build_object('success', false, 'error', 'This invitation is no longer valid.'); END IF;
  IF v_invitation.expires_at < NOW() THEN UPDATE invitations SET status = 'expired' WHERE id = p_invitation_id; RETURN json_build_object('success', false, 'error', 'This invitation has expired.'); END IF;
  IF p_user_email IS NOT NULL AND lower(v_invitation.email) != lower(p_user_email) THEN RETURN json_build_object('success', false, 'error', 'Email mismatch.'); END IF;
  SELECT user_id INTO v_existing_member FROM workspace_members WHERE workspace_id = v_invitation.workspace_id AND user_id = p_user_id;
  IF v_existing_member IS NOT NULL THEN UPDATE invitations SET status = 'accepted', user_id = p_user_id WHERE id = p_invitation_id; RETURN json_build_object('success', true); END IF;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (v_invitation.workspace_id, p_user_id, v_invitation.role);
  UPDATE invitations SET status = 'accepted', user_id = p_user_id WHERE id = p_invitation_id;

  FOR v_channel_id IN
    SELECT unnest(default_channel_ids) FROM workspace_settings WHERE workspace_id = v_invitation.workspace_id
  LOOP
    INSERT INTO channel_members (channel_id, user_id) VALUES (v_channel_id, p_user_id)
    ON CONFLICT (channel_id, user_id) DO NOTHING;
  END LOOP;

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==================== 020_attachments_layout.sql ====================
-- Persist the creator's chosen attachment grid layout per message
-- The layout value is the last layout the message author picked (grid/masonry/featured/gallery/carousel/stack)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments_layout TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_attachments_layout_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_attachments_layout_check
  CHECK (attachments_layout IS NULL OR attachments_layout IN ('grid', 'masonry', 'featured', 'gallery', 'carousel', 'stack', 'bento'));

-- ==================== 023_attachment_sort_order.sql ====================
-- 023_attachment_sort_order.sql
-- Adds a sort_order column so message attachments can be reordered by the author.
-- Backfills existing rows (per message, oldest first) so current order is preserved.
ALTER TABLE file_attachments ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
  FROM file_attachments
)
UPDATE file_attachments f
SET sort_order = ranked.rn
FROM ranked
WHERE f.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_file_attachments_sort_order ON file_attachments(message_id, sort_order);

DROP POLICY IF EXISTS "Users can update own attachments" ON file_attachments;
CREATE POLICY "Users can update own attachments" ON file_attachments
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ==================== 024_scheduled_message_auto_send.sql ====================
-- 024_scheduled_message_auto_send.sql
-- Makes scheduled messages send at their exact scheduled time even when the
-- sender is offline. Runs a pg_cron job every minute that inserts any due
-- messages directly in Postgres (bypassing RLS as security definer), moves
-- their attachments into file_attachments, and marks them as sent.

-- 1) Support scheduling into a thread (parent message).
ALTER TABLE scheduled_messages
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- 2) The worker function. Claims each due row atomically (sent = true) so a
-- client-side fallback poll can never double-send the same message.
CREATE OR REPLACE FUNCTION public.send_due_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg RECORD;
  target_channel_id uuid;
  inserted_message_id uuid;
  att RECORD;
  sent_count integer := 0;
BEGIN
  FOR msg IN
    SELECT * FROM scheduled_messages
    WHERE sent = false
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
  LOOP
    UPDATE scheduled_messages SET sent = true WHERE id = msg.id AND sent = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    target_channel_id := msg.channel_id;
    IF target_channel_id IS NULL AND msg.conversation_id IS NOT NULL THEN
      SELECT channel_id INTO target_channel_id
      FROM direct_conversations
      WHERE id = msg.conversation_id;
    END IF;

    IF target_channel_id IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO messages (channel_id, user_id, content, parent_id, link_mode)
      VALUES (target_channel_id, msg.user_id, msg.content, msg.parent_id, msg.link_mode)
      RETURNING id INTO inserted_message_id;
    EXCEPTION WHEN OTHERS THEN
      -- Revert the claim so the next run retries.
      UPDATE scheduled_messages SET sent = false WHERE id = msg.id;
      CONTINUE;
    END;

    FOR att IN
      SELECT * FROM scheduled_message_attachments
      WHERE scheduled_message_id = msg.id
    LOOP
      BEGIN
        INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
        VALUES (inserted_message_id, att.user_id, att.file_name, att.file_size, att.file_type, att.file_url);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;

    DELETE FROM scheduled_message_attachments WHERE scheduled_message_id = msg.id;
    sent_count := sent_count + 1;
  END LOOP;

  RETURN sent_count;
END;
$$;

-- 3) Grant execution so the cron worker (postgres) can run it.
GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO postgres;
GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO service_role;

-- 4) Schedule it every minute.
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('send-due-scheduled-messages', '* * * * *', 'SELECT public.send_due_scheduled_messages();');

-- ==================== 025_reminders_target.sql ====================
-- 025_reminders_target.sql
-- Makes reminders assignable to a member, a DM group, or a channel.
--   target_type: 'user' | 'channel' | 'dm' | NULL (NULL = self)
--   target_id  : user id / channel id / direct_conversation id
--   recipients : resolved member ids to notify at remind time (set by the client)
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id UUID,
  ADD COLUMN IF NOT EXISTS recipients uuid[] DEFAULT ARRAY[]::uuid[],
  ADD COLUMN IF NOT EXISTS message TEXT;

-- Index so due-reminder polling across recipients stays fast.
CREATE INDEX IF NOT EXISTS idx_reminders_due_recipients
  ON reminders(remind_at) WHERE notified = false AND dismissed = false;

-- ==================== 026_automation_action_types.sql ====================
-- 026_automation_action_types.sql
-- Extends the automation action type whitelist with new high-value actions:
--   auto_reply      : reply to the triggering message in the same channel
--   schedule_message: queue a message to be posted later via scheduled_messages
ALTER TABLE automation_actions
  DROP CONSTRAINT IF EXISTS automation_actions_action_type_check;

ALTER TABLE automation_actions
  ADD CONSTRAINT automation_actions_action_type_check
  CHECK (action_type IN (
    'notification', 'send_notification', 'assign_task', 'update_status',
    'move_task', 'add_label', 'post_message', 'send_reminder',
    'create_task', 'create_event', 'auto_reply', 'schedule_message'
  ));

-- ==================== 027_automation_rule_last_executed.sql ====================
-- 027_automation_rule_last_executed.sql
-- Fixes the 400 "Could not find the 'last_executed_at' column" error that the
-- app hits whenever a rule runs: the engine PATCHes automation_rules with
-- last_executed_at, but the column was never added to the table.
ALTER TABLE automation_rules
  ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMPTZ;

-- The reminders Complete button updates a `completed` flag that never existed.
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false;

-- ==================== 028_disable_db_automation_triggers.sql ====================
-- 028_disable_db_automation_triggers.sql
-- The SQL-side automation engine (evaluate_automation_rules) runs the SAME rules
-- as the client engine, but its send_reminder branch inserts an INSTANT
-- notification and it doesn't understand the newer config (delay, recipients,
-- member ids, auto_reply, schedule_message). That caused reminders to fire
-- immediately regardless of the configured delay, and duplicated execution of
-- other actions.
--
-- The client-side engine (useAutomationEngine) handles every event type these
-- triggers covered AND applies delays correctly, so the triggers are dropped.
DROP TRIGGER IF EXISTS trg_message_posted ON messages;
DROP TRIGGER IF EXISTS trg_task_events ON tasks;

-- ==================== 029_reminder_auto_send.sql ====================
-- 029_reminder_auto_send.sql
-- Guarantees reminders are delivered at their remind_at time even when the
-- sender's browser is closed. A pg_cron job runs every minute and, for each
-- due reminder (mirroring the client poll in useAutomationEngine), inserts a
-- notification for the reminder's recipients and marks it notified.
-- Atomic claim (notified = true) prevents the client poll from double-sending.

CREATE OR REPLACE FUNCTION public.send_due_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rem RECORD;
  recipient uuid;
  delivered_count integer := 0;
BEGIN
  FOR rem IN
    SELECT id, user_id, title, message, recipients
    FROM reminders
    WHERE remind_at <= now()
      AND notified = false
      AND dismissed = false
    ORDER BY remind_at ASC
    LIMIT 500
  LOOP
    UPDATE reminders SET notified = true WHERE id = rem.id AND notified = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF rem.recipients IS NOT NULL AND cardinality(rem.recipients) > 0 THEN
      FOR recipient IN SELECT unnest(rem.recipients) LOOP
        INSERT INTO notifications (user_id, type, title, message, link, category, entity_type)
        VALUES (recipient, 'reminder', rem.title, COALESCE(rem.message, 'Reminder'), '/calendar', 'calendar', 'event');
        delivered_count := delivered_count + 1;
      END LOOP;
    ELSE
      INSERT INTO notifications (user_id, type, title, message, link, category, entity_type)
      VALUES (rem.user_id, 'reminder', rem.title, COALESCE(rem.message, 'Reminder'), '/calendar', 'calendar', 'event');
      delivered_count := delivered_count + 1;
    END IF;
  END LOOP;

  RETURN delivered_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_due_reminders() TO postgres;
GRANT EXECUTE ON FUNCTION public.send_due_reminders() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('send-due-reminders', '* * * * *', 'SELECT public.send_due_reminders();');

-- ==================== 030_reminders_recipient_rls.sql ====================
-- 030_reminders_recipient_rls.sql
-- Lets reminder recipients (assignees) read and manage the reminders that
-- were created for them, not just the creator. The existing policy only
-- allowed auth.uid() = user_id, so a reminder "assigned to someone else"
-- was invisible to that person and only the creator could see it.

DROP POLICY IF EXISTS "reminders_recipients_select" ON reminders;
DROP POLICY IF EXISTS "reminders_recipients_update" ON reminders;

CREATE POLICY "reminders_recipients_select" ON reminders
  FOR SELECT
  USING (auth.uid() = ANY(COALESCE(recipients, ARRAY[]::uuid[])));

CREATE POLICY "reminders_recipients_update" ON reminders
  FOR UPDATE
  USING (auth.uid() = ANY(COALESCE(recipients, ARRAY[]::uuid[])));

-- ==================== 031_call_history_delete_rls.sql ====================
-- 031_call_history_delete_rls.sql
-- Allow users to permanently delete calls from their call history.
-- - Call creators may remove the whole call record (session delete is already
--   restricted to the creator via "call_sessions_delete_creator").
-- - Participants may remove their own history entry.

-- call_participants: DELETE allowed for the participant themselves or the call creator
DROP POLICY IF EXISTS "call_participants_delete_self" ON call_participants;

CREATE POLICY "call_participants_delete_self" ON call_participants
  FOR DELETE USING (
    auth.uid() = user_id
    OR auth.uid() IN (SELECT created_by FROM call_sessions WHERE id = call_id)
  );

-- ==================== 032_avatar_display_style.sql ====================
-- Add avatar display style to profiles so members can see each other's avatar presentation
-- Value is one of 'frame' | 'circle' | 'polaroid' (defaults to 'frame' on the client)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_style TEXT;

-- ==================== 033_automation_visibility.sql ====================
-- ============================================================
-- 033_automation_visibility.sql
-- Everyone can create automations. Each member controls what they
-- see via a per-user visibility setting:
--   'own'      (default)  only the automations they created
--   'all'                 every automation in the workspace
--   'selected'            automations created by chosen members
-- Owners can edit/delete their own rules; workspace owners/admins
-- can edit/delete any rule they can see. Duplicating a rule always
-- forks it into a new rule owned by the duplicator.
--
-- Fixes the 403 / 42501 "new row violates row-level security policy
-- for table automation_rules" that members hit when creating a rule.
-- ============================================================

-- 1. Per-user automation visibility settings -------------------
ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS automation_visibility TEXT NOT NULL DEFAULT 'own'
    CHECK (automation_visibility IN ('own', 'all', 'selected'));
ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS automation_visible_members UUID[] NOT NULL DEFAULT '{}';

-- 2. RLS helper: can the current user VIEW a rule? --------------
-- Own rules are always visible; otherwise it depends on the
-- viewer's visibility mode for the rule's workspace.
CREATE OR REPLACE FUNCTION public.can_view_automation_rule(p_rule_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM automation_rules ar
    WHERE ar.id = p_rule_id
      AND (
        ar.created_by = auth.uid()
        OR EXISTS (
          SELECT 1
          FROM workspace_members wm
          WHERE wm.workspace_id = ar.workspace_id
            AND wm.user_id = auth.uid()
            AND (
              wm.automation_visibility = 'all'
              OR (wm.automation_visibility = 'selected' AND wm.automation_visible_members @> ARRAY[ar.created_by])
            )
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 3. RLS helper: can the current user MANAGE (edit/delete) a rule?
-- The rule must be visible to them AND they must own it or be a
-- workspace owner/admin.
CREATE OR REPLACE FUNCTION public.can_manage_automation_rule(p_rule_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM automation_rules ar
    WHERE ar.id = p_rule_id
      AND public.can_view_automation_rule(p_rule_id)
      AND (
        ar.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.workspace_members wm
          WHERE wm.workspace_id = ar.workspace_id
            AND wm.user_id = auth.uid()
            AND wm.role IN ('owner', 'admin')
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.can_view_automation_rule(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_automation_rule(UUID) TO authenticated;

-- 4. Read / save the current user's visibility preference ------
CREATE OR REPLACE FUNCTION public.get_automation_visibility(p_workspace_id UUID)
RETURNS JSON AS $$
DECLARE v_row workspace_members%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
  ) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;
  SELECT * INTO v_row
  FROM workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = auth.uid();
  RETURN json_build_object(
    'success', true,
    'workspace_id', p_workspace_id,
    'visibility', v_row.automation_visibility,
    'visible_members', v_row.automation_visible_members
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.set_automation_visibility(
  p_workspace_id UUID,
  p_visibility TEXT,
  p_visible_members UUID[] DEFAULT NULL
) RETURNS JSON AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = p_workspace_id AND wm.user_id = auth.uid()
  ) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;
  IF p_visibility NOT IN ('own', 'all', 'selected') THEN
    RETURN json_build_object('success', false, 'error', 'Invalid visibility mode.');
  END IF;
  IF p_visibility = 'selected' AND (p_visible_members IS NULL OR cardinality(p_visible_members) = 0) THEN
    RETURN json_build_object('success', false, 'error', 'Pick at least one member.');
  END IF;
  UPDATE workspace_members
  SET automation_visibility = p_visibility,
      automation_visible_members = CASE
        WHEN p_visibility = 'selected' THEN COALESCE(p_visible_members, '{}')
        ELSE automation_visible_members
      END,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = auth.uid();
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_automation_visibility(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_automation_visibility(UUID, TEXT, UUID[]) TO authenticated;

-- 5. Drop the old admin-only policies --------------------------
DROP POLICY IF EXISTS "Admins can view automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can create automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can update automation rules" ON automation_rules;
DROP POLICY IF EXISTS "Admins can delete automation rules" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_select" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_insert" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_update" ON automation_rules;
DROP POLICY IF EXISTS "automation_rules_delete" ON automation_rules;

DROP POLICY IF EXISTS "Admins can manage triggers" ON automation_triggers;
DROP POLICY IF EXISTS "automation_triggers_all" ON automation_triggers;

DROP POLICY IF EXISTS "Admins can manage conditions" ON automation_conditions;
DROP POLICY IF EXISTS "automation_conditions_all" ON automation_conditions;

DROP POLICY IF EXISTS "Admins can manage actions" ON automation_actions;
DROP POLICY IF EXISTS "automation_actions_all" ON automation_actions;

DROP POLICY IF EXISTS "Admins can view execution logs" ON automation_execution_logs;
DROP POLICY IF EXISTS "System can insert execution logs" ON automation_execution_logs;
DROP POLICY IF EXISTS "automation_logs_select" ON automation_execution_logs;
DROP POLICY IF EXISTS "automation_logs_insert" ON automation_execution_logs;
DROP POLICY IF EXISTS "automation_logs_delete" ON automation_execution_logs;

DROP POLICY IF EXISTS "automation_triggers_select" ON automation_triggers;
DROP POLICY IF EXISTS "automation_triggers_insert" ON automation_triggers;
DROP POLICY IF EXISTS "automation_triggers_update" ON automation_triggers;
DROP POLICY IF EXISTS "automation_triggers_delete" ON automation_triggers;

DROP POLICY IF EXISTS "automation_conditions_select" ON automation_conditions;
DROP POLICY IF EXISTS "automation_conditions_insert" ON automation_conditions;
DROP POLICY IF EXISTS "automation_conditions_update" ON automation_conditions;
DROP POLICY IF EXISTS "automation_conditions_delete" ON automation_conditions;

DROP POLICY IF EXISTS "automation_actions_select" ON automation_actions;
DROP POLICY IF EXISTS "automation_actions_insert" ON automation_actions;
DROP POLICY IF EXISTS "automation_actions_update" ON automation_actions;
DROP POLICY IF EXISTS "automation_actions_delete" ON automation_actions;

-- 6. New policies ----------------------------------------------

-- automation_rules
CREATE POLICY "automation_rules_select" ON automation_rules FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(id));

-- Insert gate: created_by must be the authenticated user. Membership
-- is enforced server-side by the trg_automation_rules_set_creator
-- trigger (SECURITY DEFINER), so this policy never depends on RLS on
-- workspace_members or on helper functions.
CREATE POLICY "automation_rules_insert" ON automation_rules FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "automation_rules_update" ON automation_rules FOR UPDATE TO authenticated
  USING (public.can_manage_automation_rule(id))
  WITH CHECK (public.can_manage_automation_rule(id));

CREATE POLICY "automation_rules_delete" ON automation_rules FOR DELETE TO authenticated
  USING (public.can_manage_automation_rule(id));

-- automation_triggers
CREATE POLICY "automation_triggers_select" ON automation_triggers FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(rule_id));
CREATE POLICY "automation_triggers_insert" ON automation_triggers FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_triggers_update" ON automation_triggers FOR UPDATE TO authenticated
  USING (public.can_manage_automation_rule(rule_id))
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_triggers_delete" ON automation_triggers FOR DELETE TO authenticated
  USING (public.can_manage_automation_rule(rule_id));

-- automation_conditions
CREATE POLICY "automation_conditions_select" ON automation_conditions FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(rule_id));
CREATE POLICY "automation_conditions_insert" ON automation_conditions FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_conditions_update" ON automation_conditions FOR UPDATE TO authenticated
  USING (public.can_manage_automation_rule(rule_id))
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_conditions_delete" ON automation_conditions FOR DELETE TO authenticated
  USING (public.can_manage_automation_rule(rule_id));

-- automation_actions
CREATE POLICY "automation_actions_select" ON automation_actions FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(rule_id));
CREATE POLICY "automation_actions_insert" ON automation_actions FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_actions_update" ON automation_actions FOR UPDATE TO authenticated
  USING (public.can_manage_automation_rule(rule_id))
  WITH CHECK (public.can_manage_automation_rule(rule_id));
CREATE POLICY "automation_actions_delete" ON automation_actions FOR DELETE TO authenticated
  USING (public.can_manage_automation_rule(rule_id));

-- automation_execution_logs
CREATE POLICY "automation_logs_select" ON automation_execution_logs FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(rule_id));
CREATE POLICY "automation_logs_insert" ON automation_execution_logs FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "automation_logs_delete" ON automation_execution_logs FOR DELETE TO authenticated
  USING (public.can_manage_automation_rule(rule_id));

-- 7. Read RPCs now respect visibility --------------------------
CREATE OR REPLACE FUNCTION public.get_automation_rules(p_workspace_id UUID)
RETURNS TABLE(
  rule_id UUID,
  name TEXT,
  description TEXT,
  enabled BOOLEAN,
  trigger_types TEXT[],
  action_count BIGINT,
  last_executed TIMESTAMPTZ,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ar.id AS rule_id,
    ar.name,
    ar.description,
    ar.enabled,
    COALESCE(ARRAY(SELECT at2.event_type FROM automation_triggers at2 WHERE at2.rule_id = ar.id), '{}') AS trigger_types,
    (SELECT COUNT(*) FROM automation_actions aa WHERE aa.rule_id = ar.id) AS action_count,
    (SELECT MAX(ael.executed_at) FROM automation_execution_logs ael WHERE ael.rule_id = ar.id) AS last_executed,
    ar.created_at
  FROM automation_rules ar
  WHERE ar.workspace_id = p_workspace_id
    AND public.can_view_automation_rule(ar.id)
  ORDER BY ar.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_execution_logs(p_workspace_id UUID, p_rule_id UUID DEFAULT NULL)
RETURNS TABLE(
  id UUID,
  rule_id UUID,
  trigger_event TEXT,
  trigger_entity_id UUID,
  conditions_met BOOLEAN,
  actions_executed INTEGER,
  success BOOLEAN,
  error_message TEXT,
  executed_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT ael.id, ael.rule_id, ael.trigger_event, ael.trigger_entity_id,
    ael.conditions_met, ael.actions_executed, ael.success, ael.error_message, ael.executed_at
  FROM automation_execution_logs ael
  JOIN automation_rules ar ON ar.id = ael.rule_id
  WHERE ar.workspace_id = p_workspace_id
    AND public.can_view_automation_rule(ar.id)
    AND (p_rule_id IS NULL OR ael.rule_id = p_rule_id)
  ORDER BY ael.executed_at DESC
  LIMIT 100;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Belt-and-suspenders: force created_by to the request user ----
-- Guarantees the INSERT policy's "auth.uid() = created_by" half can
-- never be the reason a legit member gets blocked, no matter what the
-- client sends.
CREATE OR REPLACE FUNCTION public.set_automation_rule_creator()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;
  NEW.created_by := auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    WHERE wm.workspace_id = NEW.workspace_id AND wm.user_id = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'You are not a member of this workspace.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_automation_rules_set_creator ON automation_rules;
CREATE TRIGGER trg_automation_rules_set_creator
  BEFORE INSERT ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_automation_rule_creator();

-- ==================== 034_automation_edit_requests.sql ====================
-- ============================================================
-- 034_automation_edit_requests.sql
-- Members who can VIEW but not MANAGE an automation can request
-- edit access. The rule owner (or any workspace owner/admin) is
-- notified and can accept or reject. Accepted members become
-- approved editors and can edit/delete the rule until revoked.
--
-- Builds on 033_automation_visibility.sql (requires
-- can_view_automation_rule / can_manage_automation_rule).
-- ============================================================

-- 1. Tables ----------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_edit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  responded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (rule_id, requester_id)
);
ALTER TABLE automation_edit_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS automation_rule_editors (
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (rule_id, user_id)
);
ALTER TABLE automation_rule_editors ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_automation_edit_requests_rule ON automation_edit_requests(rule_id);
CREATE INDEX IF NOT EXISTS idx_automation_edit_requests_requester ON automation_edit_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_automation_rule_editors_user ON automation_rule_editors(user_id);

-- 2. Helpers ---------------------------------------------------
-- Is the current user the rule creator or a workspace owner/admin?
CREATE OR REPLACE FUNCTION public.is_automation_owner_admin(p_rule_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM automation_rules ar
    WHERE ar.id = p_rule_id
      AND (
        ar.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.workspace_members wm
          WHERE wm.workspace_id = ar.workspace_id
            AND wm.user_id = auth.uid()
            AND wm.role IN ('owner', 'admin')
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Manage = can view AND (creator OR owner/admin OR approved editor)
CREATE OR REPLACE FUNCTION public.can_manage_automation_rule(p_rule_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM automation_rules ar
    WHERE ar.id = p_rule_id
      AND public.can_view_automation_rule(p_rule_id)
      AND (
        ar.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.workspace_members wm
          WHERE wm.workspace_id = ar.workspace_id
            AND wm.user_id = auth.uid()
            AND wm.role IN ('owner', 'admin')
        )
        OR EXISTS (SELECT 1 FROM automation_rule_editors e WHERE e.rule_id = p_rule_id AND e.user_id = auth.uid())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.is_automation_owner_admin(UUID) TO authenticated;

-- 3. RLS policies ----------------------------------------------

-- automation_edit_requests
DROP POLICY IF EXISTS "aer_select" ON automation_edit_requests;
DROP POLICY IF EXISTS "aer_insert" ON automation_edit_requests;
DROP POLICY IF EXISTS "aer_update" ON automation_edit_requests;
DROP POLICY IF EXISTS "aer_delete" ON automation_edit_requests;

-- automation_rule_editors
DROP POLICY IF EXISTS "are_select" ON automation_rule_editors;
DROP POLICY IF EXISTS "are_insert" ON automation_rule_editors;
DROP POLICY IF EXISTS "are_delete" ON automation_rule_editors;

CREATE POLICY "aer_select" ON automation_edit_requests FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR public.is_automation_owner_admin(rule_id));
CREATE POLICY "aer_insert" ON automation_edit_requests FOR INSERT TO authenticated
  WITH CHECK (requester_id = auth.uid() AND public.can_view_automation_rule(rule_id));
CREATE POLICY "aer_update" ON automation_edit_requests FOR UPDATE TO authenticated
  USING (public.is_automation_owner_admin(rule_id));
CREATE POLICY "aer_delete" ON automation_edit_requests FOR DELETE TO authenticated
  USING (requester_id = auth.uid() OR public.is_automation_owner_admin(rule_id));

-- automation_rule_editors
CREATE POLICY "are_select" ON automation_rule_editors FOR SELECT TO authenticated
  USING (public.can_view_automation_rule(rule_id));
CREATE POLICY "are_insert" ON automation_rule_editors FOR INSERT TO authenticated
  WITH CHECK (public.is_automation_owner_admin(rule_id));
CREATE POLICY "are_delete" ON automation_rule_editors FOR DELETE TO authenticated
  USING (public.is_automation_owner_admin(rule_id) OR user_id = auth.uid());

-- 4. RPCs ------------------------------------------------------
-- Request edit access on a rule (owner/admin already manage; others get a request).
CREATE OR REPLACE FUNCTION public.request_automation_edit(p_rule_id UUID)
RETURNS JSON AS $$
DECLARE v_owner_id UUID; v_rule_name TEXT; v_workspace_id UUID;
BEGIN
  SELECT created_by, name, workspace_id INTO v_owner_id, v_rule_name, v_workspace_id
  FROM automation_rules WHERE id = p_rule_id;
  IF v_owner_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'Rule not found.'); END IF;
  IF NOT public.can_view_automation_rule(p_rule_id) THEN
    RETURN json_build_object('success', false, 'error', 'You cannot view this rule.');
  END IF;
  IF v_owner_id = auth.uid() OR public.can_manage_automation_rule(p_rule_id) THEN
    RETURN json_build_object('success', false, 'error', 'You already have edit access.');
  END IF;

  INSERT INTO automation_edit_requests (rule_id, requester_id)
  VALUES (p_rule_id, auth.uid())
  ON CONFLICT (rule_id, requester_id)
  DO UPDATE SET status = 'pending', responded_at = NULL, responded_by = NULL, created_at = now();

  PERFORM public.create_notification(
    v_owner_id,
    'system',
    'Automation edit request',
    'Someone asked for edit access to "' || v_rule_name || '".',
    '/automation',
    'workspace',
    'automation',
    p_rule_id,
    auth.uid(),
    v_workspace_id
  );

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Accept or reject an edit request (owner/admin only).
CREATE OR REPLACE FUNCTION public.respond_automation_edit_request(p_request_id UUID, p_accept BOOLEAN)
RETURNS JSON AS $$
DECLARE v_rule_id UUID; v_requester_id UUID; v_rule_name TEXT; v_workspace_id UUID;
BEGIN
  SELECT rule_id, requester_id INTO v_rule_id, v_requester_id
  FROM automation_edit_requests WHERE id = p_request_id;
  IF v_rule_id IS NULL THEN RETURN json_build_object('success', false, 'error', 'Request not found.'); END IF;
  IF NOT public.is_automation_owner_admin(v_rule_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  UPDATE automation_edit_requests
  SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,
      responded_at = now(),
      responded_by = auth.uid()
  WHERE id = p_request_id;

  IF p_accept THEN
    INSERT INTO automation_rule_editors (rule_id, user_id, granted_by)
    VALUES (v_rule_id, v_requester_id, auth.uid())
    ON CONFLICT (rule_id, user_id) DO NOTHING;
  END IF;

  SELECT name, workspace_id INTO v_rule_name, v_workspace_id
  FROM automation_rules WHERE id = v_rule_id;

  PERFORM public.create_notification(
    v_requester_id,
    'system',
    CASE WHEN p_accept THEN 'Automation edit access granted' ELSE 'Automation edit request declined' END,
    CASE WHEN p_accept
      THEN 'Your edit request for "' || v_rule_name || '" was accepted.'
      ELSE 'Your edit request for "' || v_rule_name || '" was declined.'
    END,
    '/automation',
    'workspace',
    'automation',
    v_rule_id,
    auth.uid(),
    v_workspace_id
  );

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revoke a granted editor (owner/admin only).
CREATE OR REPLACE FUNCTION public.revoke_automation_editor(p_rule_id UUID, p_user_id UUID)
RETURNS JSON AS $$
BEGIN
  IF NOT public.is_automation_owner_admin(p_rule_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;
  DELETE FROM automation_rule_editors WHERE rule_id = p_rule_id AND user_id = p_user_id;
  UPDATE automation_edit_requests
  SET status = 'rejected', responded_at = now(), responded_by = auth.uid()
  WHERE rule_id = p_rule_id AND requester_id = p_user_id AND status = 'accepted';
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Incoming + outgoing requests for a workspace, with rule/member names.
CREATE OR REPLACE FUNCTION public.get_automation_edit_requests(p_workspace_id UUID)
RETURNS TABLE(
  id UUID,
  rule_id UUID,
  requester_id UUID,
  status TEXT,
  created_at TIMESTAMPTZ,
  rule_name TEXT,
  requester_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.rule_id, r.requester_id, r.status, r.created_at,
         ar.name,
         COALESCE(p.display_name, p.username, p.email)
  FROM automation_edit_requests r
  JOIN automation_rules ar ON ar.id = r.rule_id
  LEFT JOIN profiles p ON p.id = r.requester_id
  WHERE ar.workspace_id = p_workspace_id
    AND (r.requester_id = auth.uid() OR public.is_automation_owner_admin(r.rule_id))
  ORDER BY r.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rules in a workspace where the current user is an approved editor.
CREATE OR REPLACE FUNCTION public.get_my_automation_edit_access(p_workspace_id UUID)
RETURNS TABLE(rule_id UUID) AS $$
  SELECT e.rule_id
  FROM automation_rule_editors e
  JOIN automation_rules ar ON ar.id = e.rule_id
  WHERE ar.workspace_id = p_workspace_id AND e.user_id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.request_automation_edit(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_automation_edit_request(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_automation_editor(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_automation_edit_requests(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_automation_edit_access(UUID) TO authenticated;

-- ==================== 035_create_automation_rule_fix.sql ====================
-- ============================================================
-- COMPLETE FIX — run this in the project your app ACTUALLY uses:
--
--   https://supabase.com/dashboard/project/nwsxrtfkdbnuzejyeogh/...
--
-- Check the URL of the Supabase dashboard tab BEFORE running.
-- If the project ref is NOT "nwsxrtfkdbnuzejyeogh", switch to the
-- project whose ref is nwsxrtfkdbnuzejyeogh and run this there.
-- ============================================================

-- 1) automation_rules policies are managed by 033_automation_visibility.sql
--    (can_view_automation_rule / can_manage_automation_rule). Do NOT drop or
--    recreate them here -- that would overwrite the working "works for everyone"
--    setup. Run 033 before 034.

-- 2) force created_by to the request user + membership guard (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.set_automation_rule_creator()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;
  NEW.created_by := auth.uid();
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = NEW.workspace_id AND wm.user_id = NEW.created_by) THEN
    RAISE EXCEPTION 'You are not a member of this workspace.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_automation_rules_set_creator ON automation_rules;
CREATE TRIGGER trg_automation_rules_set_creator
  BEFORE INSERT ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_automation_rule_creator();

-- 3) SECURITY DEFINER RPC the app uses to create rules.
--    Runs as the function owner, so it bypasses RLS. The trigger above
--    still enforces membership + forces created_by = auth.uid().
--    First drop EVERY old overload (the app always passes p_enabled), so
--    PostgREST does not keep resolving the 6-arg version from its cache.
DROP FUNCTION IF EXISTS public.create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN);

CREATE OR REPLACE FUNCTION public.create_automation_rule(
  p_workspace_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_triggers JSONB DEFAULT '[]',
  p_conditions JSONB DEFAULT '[]',
  p_actions JSONB DEFAULT '[]',
  p_enabled BOOLEAN DEFAULT TRUE
)
RETURNS UUID AS $$
DECLARE
  v_rule_id UUID;
  v_trigger JSONB;
  v_condition JSONB;
  v_action JSONB;
BEGIN
  INSERT INTO automation_rules (workspace_id, name, description, enabled, created_by)
  VALUES (p_workspace_id, p_name, p_description, p_enabled, auth.uid())
  RETURNING id INTO v_rule_id;

  FOR v_trigger IN SELECT * FROM jsonb_array_elements(p_triggers)
  LOOP
    INSERT INTO automation_triggers (rule_id, event_type)
    VALUES (v_rule_id, COALESCE(v_trigger->>'event_type', ''));
  END LOOP;

  FOR v_condition IN SELECT * FROM jsonb_array_elements(p_conditions)
  LOOP
    INSERT INTO automation_conditions (rule_id, field, operator, value, logic)
    VALUES (v_rule_id, COALESCE(v_condition->>'field', ''), COALESCE(v_condition->>'operator', 'equals'), COALESCE(v_condition->>'value', ''), COALESCE(v_condition->>'logic', 'and'));
  END LOOP;

  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    INSERT INTO automation_actions (rule_id, action_type, config, sort_order)
    VALUES (v_rule_id, COALESCE(v_action->>'action_type', 'post_message'), COALESCE(v_action->'config', '{}'::jsonb), COALESCE((v_action->>'sort_order')::INTEGER, 0));
  END LOOP;

  RETURN v_rule_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.create_automation_rule(UUID, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN) TO authenticated;

-- Force PostgREST to rebuild its schema cache immediately (otherwise the
-- 404 / PGRST202 can linger until the next automatic reload).
NOTIFY pgrst, 'reload schema';

-- 4) verification (must show the new text)
SELECT policyname, cmd, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'automation_rules'
ORDER BY cmd;

-- 5) MUST return one row with proargnames including p_enabled.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'create_automation_rule'
  AND pg_get_function_identity_arguments(p.oid) LIKE '%p_enabled%';

-- ==================== 036_automation_edit_request_cancel.sql ====================
-- ============================================================
-- 036_automation_edit_request_cancel.sql
-- Lets the requester withdraw their own pending edit request
-- before the owner/admin responds. Builds on
-- 034_automation_edit_requests.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_automation_edit_request(p_request_id UUID)
RETURNS JSON AS $$
DECLARE v_requester_id UUID;
BEGIN
  SELECT requester_id INTO v_requester_id
  FROM automation_edit_requests
  WHERE id = p_request_id;

  IF v_requester_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Request not found.');
  END IF;

  IF v_requester_id <> auth.uid() THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  DELETE FROM automation_edit_requests WHERE id = p_request_id;
  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.cancel_automation_edit_request(UUID) TO authenticated;

-- ==================== 037_forwarded_messages.sql ====================
-- ============================================================
-- 037_forwarded_messages.sql
-- Marks a message as a forward/share of another message so the
-- UI can show a "forwarded" indicator next to the content.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_forwarded_from ON messages(forwarded_from_message_id);

-- ==================== 039_fix_project_roles.sql ====================
-- ============================================================
-- FIX: Enforce project roles (owner / admin / member / viewer)
--
--   owner  -> everything
--   admin  -> manage members, edit project, delete project/tasks
--   member -> create + edit project tasks, cannot delete project
--   viewer -> read-only (cannot create/edit/delete project tasks)
--
-- Run this AFTER 002_fix_projects_rls.sql + 008_fix_tasks_visibility.sql
-- ============================================================

-- Helper: can the user create/edit tasks inside this project?
CREATE OR REPLACE FUNCTION public.is_project_editor(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = p_project_id AND user_id = p_user_id AND role IN ('owner', 'admin', 'member')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Helper: is the user a read-only viewer of this project?
CREATE OR REPLACE FUNCTION public.is_project_viewer(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = p_project_id AND user_id = p_user_id AND role = 'viewer'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.is_project_editor(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_project_viewer(UUID, UUID) TO authenticated;

-- ── tasks_select: creator, assignee, project member, workspace admin ──
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT USING (
    auth.uid() = created_by
    OR is_task_assignee(id, auth.uid())
    OR (project_id IS NOT NULL AND is_project_member(project_id))
    OR is_workspace_admin(workspace_id)
  );

-- ── tasks_insert: workspace member, not a viewer-only member ──
DROP POLICY IF EXISTS "tasks_insert" ON public.tasks;
CREATE POLICY "tasks_insert" ON public.tasks
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND is_workspace_member(workspace_id)
    AND (project_id IS NULL OR is_project_editor(project_id))
  );

-- ── tasks_update: creator, assignee, project editor, workspace admin ──
DROP POLICY IF EXISTS "tasks_update" ON public.tasks;
CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE USING (
    auth.uid() = created_by
    OR is_task_assignee(id, auth.uid())
    OR (project_id IS NOT NULL AND is_project_editor(project_id))
    OR is_workspace_admin(workspace_id)
  );

-- ── tasks_delete: creator or workspace admin (project admin via RPC) ──
DROP POLICY IF EXISTS "tasks_delete" ON public.tasks;
CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE USING (
    auth.uid() = created_by
    OR is_workspace_admin(workspace_id)
  );

-- ── projects_update: owner, project editor (member+), workspace admin ──
DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (
    auth.uid() = owner_id
    OR is_project_editor(id)
    OR is_workspace_admin(workspace_id)
  );

-- ── projects_delete: owner, project admin, workspace admin ──
DROP POLICY IF EXISTS "projects_delete" ON public.projects;
CREATE POLICY "projects_delete" ON public.projects
  FOR DELETE USING (
    auth.uid() = owner_id
    OR is_project_admin(id)
    OR is_workspace_admin(workspace_id)
  );

-- ==================== 040_project_resources.sql ====================
-- ============================================================
-- FEATURE: Project resources tab — paste links + upload images,
-- with per-item comments.
--
-- Run this AFTER 039_fix_project_roles.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS project_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('link', 'image')),
  url TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_resource_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL REFERENCES project_resources(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_resources_project ON project_resources(project_id);
CREATE INDEX IF NOT EXISTS idx_project_resource_comments_resource ON project_resource_comments(resource_id);

ALTER TABLE project_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_resource_comments ENABLE ROW LEVEL SECURITY;

-- ── project_resources ────────────────────────────────────────
DROP POLICY IF EXISTS "project_resources_select" ON public.project_resources;
CREATE POLICY "project_resources_select" ON public.project_resources
  FOR SELECT USING (
    is_project_member(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
  );

DROP POLICY IF EXISTS "project_resources_insert" ON public.project_resources;
CREATE POLICY "project_resources_insert" ON public.project_resources
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND is_project_editor(project_id)
  );

DROP POLICY IF EXISTS "project_resources_update" ON public.project_resources;
CREATE POLICY "project_resources_update" ON public.project_resources
  FOR UPDATE USING (
    is_project_editor(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
  );

DROP POLICY IF EXISTS "project_resources_delete" ON public.project_resources;
CREATE POLICY "project_resources_delete" ON public.project_resources
  FOR DELETE USING (
    auth.uid() = created_by
    OR is_project_admin(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
  );

-- ── project_resource_comments ────────────────────────────────
DROP POLICY IF EXISTS "project_resource_comments_select" ON public.project_resource_comments;
CREATE POLICY "project_resource_comments_select" ON public.project_resource_comments
  FOR SELECT USING (
    is_project_member(
      (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id)
    )
    OR is_workspace_admin(
      (SELECT workspace_id FROM projects WHERE id = (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id))
    )
  );

DROP POLICY IF EXISTS "project_resource_comments_insert" ON public.project_resource_comments;
CREATE POLICY "project_resource_comments_insert" ON public.project_resource_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND is_project_editor(
      (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id)
    )
  );

DROP POLICY IF EXISTS "project_resource_comments_delete" ON public.project_resource_comments;
CREATE POLICY "project_resource_comments_delete" ON public.project_resource_comments
  FOR DELETE USING (
    auth.uid() = user_id
    OR is_project_admin(
      (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id)
    )
  );

-- ==================== 041_fix_project_resources_rls.sql ====================
-- ============================================================
-- FIX: Project resources visibility for workspace members
--
-- The projects table lets any workspace member view a project
-- (projects_select), but the 040 resource policies only let
-- explicit project members (or workspace admins) see resources
-- or comment. A workspace member who is not a project member
-- therefore saw a blank Resources tab with no way to upload or
-- comment.
--
-- Align resource policies with projects_select:
--   view + comment  -> any workspace member
--   upload          -> any workspace member (created_by = self)
--   update/delete   -> creator, project admin, workspace admin
--
-- Run AFTER 040_project_resources.sql
-- ============================================================

DROP POLICY IF EXISTS "project_resources_select" ON public.project_resources;
CREATE POLICY "project_resources_select" ON public.project_resources
  FOR SELECT USING (
    is_workspace_member((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
    OR is_project_member(project_id)
  );

DROP POLICY IF EXISTS "project_resources_insert" ON public.project_resources;
CREATE POLICY "project_resources_insert" ON public.project_resources
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND is_workspace_member((SELECT workspace_id FROM projects WHERE id = project_resources.project_id))
  );

DROP POLICY IF EXISTS "project_resource_comments_select" ON public.project_resource_comments;
CREATE POLICY "project_resource_comments_select" ON public.project_resource_comments
  FOR SELECT USING (
    is_workspace_member(
      (SELECT workspace_id FROM projects WHERE id = (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id))
    )
    OR is_project_member(
      (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id)
    )
  );

DROP POLICY IF EXISTS "project_resource_comments_insert" ON public.project_resource_comments;
CREATE POLICY "project_resource_comments_insert" ON public.project_resource_comments
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND is_workspace_member(
      (SELECT workspace_id FROM projects WHERE id = (SELECT project_id FROM project_resources WHERE id = project_resource_comments.resource_id))
    )
  );

-- ==================== 042_project_settings_owner_only.sql ====================
-- ============================================================
-- FIX: Project settings updates are owner/admin-only
--
-- 039_fix_project_roles.sql widened projects_update to any
-- project "member" role so a plain member could edit the
-- project name / description / icon / color / visibility.
-- Settings edits (incl. archive) should be limited to the
-- project owner / project admin / workspace admin.
--
--   owner / project admin / workspace admin -> edit settings
--   member / viewer                         -> read-only
--
-- Run AFTER 039_fix_project_roles.sql
-- ============================================================

DROP POLICY IF EXISTS "projects_update" ON public.projects;
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (
    auth.uid() = owner_id
    OR is_project_admin(id)
    OR is_workspace_admin(workspace_id)
  );

-- ==================== 043_project_milestone_created_by.sql ====================
-- ============================================================
-- FIX: Milestone ownership (created_by) + per-owner RLS
--
-- project_milestones previously had no created_by column and
-- its insert/update/delete policies let ANY workspace member
-- create, edit, or delete any milestone. Add a creator so the
-- viewer model works:
--
--   view   -> any workspace member
--   create -> workspace member (created_by = self)
--   update -> creator, project editor (member+), workspace admin
--   delete -> creator, project editor (member+), workspace admin
--
-- Run AFTER 002_fix_projects_rls.sql
-- ============================================================

ALTER TABLE public.project_milestones
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "project_milestones_insert" ON public.project_milestones;
CREATE POLICY "project_milestones_insert" ON public.project_milestones
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND is_workspace_member((SELECT workspace_id FROM projects WHERE id = project_milestones.project_id))
  );

DROP POLICY IF EXISTS "project_milestones_update" ON public.project_milestones;
CREATE POLICY "project_milestones_update" ON public.project_milestones
  FOR UPDATE USING (
    auth.uid() = created_by
    OR is_project_editor(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_milestones.project_id))
  )
  WITH CHECK (
    auth.uid() = created_by
    OR is_project_editor(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_milestones.project_id))
  );

DROP POLICY IF EXISTS "project_milestones_delete" ON public.project_milestones;
CREATE POLICY "project_milestones_delete" ON public.project_milestones
  FOR DELETE USING (
    auth.uid() = created_by
    OR is_project_editor(project_id)
    OR is_workspace_admin((SELECT workspace_id FROM projects WHERE id = project_milestones.project_id))
  );

-- ==================== 044_profiles_select_scoped.sql ====================
-- ============================================================
-- FIX: Scope profiles SELECT to the current user + shared workspaces
--
-- Previously "profiles_select_all" used USING (true) with no TO role,
-- so ANY client (even logged out) could read every profile in the app.
-- This drops that policy and replaces it with one that only lets an
-- authenticated user see:
--
--   * their own profile, and
--   * profiles of users who share at least one workspace with them.
--
-- Global user search (src/hooks/useSearch/useSearch.ts) automatically
-- becomes "workspace-mates only". All other profile reads in the app go
-- through known ids (own id, channel members, assignees, etc.) and are
-- unaffected.
--
-- The invite-by-email flow (src/lib/workspace/workspace.ts) needs to
-- resolve an email to a user id even when the invitee is NOT yet a
-- workspace member. A plain SELECT by email would now be blocked, so we
-- add a SECURITY DEFINER RPC gated to authenticated users that returns
-- ONLY the user id (no display_name, avatar, etc.) for the invite path.
--
-- Run AFTER 000_EVERYTHING_RUN_ME.sql
-- ============================================================

DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
DROP POLICY IF EXISTS "profiles_select_scoped" ON profiles;

CREATE POLICY "profiles_select_scoped" ON profiles
  FOR SELECT TO authenticated
  USING (
    auth.uid() = id
    OR EXISTS (
      SELECT 1
      FROM workspace_members wm1
      JOIN workspace_members wm2 ON wm2.workspace_id = wm1.workspace_id
      WHERE wm1.user_id = auth.uid()
        AND wm2.user_id = profiles.id
    )
  );

-- Narrow, authenticated-only email -> id lookup used by the invite flow.
-- Deliberately returns only the id; intentionally not callable by anon.
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email TEXT)
RETURNS TABLE (user_id UUID) AS $$
  SELECT id FROM profiles WHERE lower(email) = lower(p_email) LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) TO authenticated;

-- ==================== 045_file_attachments_workspace.sql ====================
-- ============================================================
-- FIX: file_attachments.workspace_id for efficient per-workspace scoping
--
-- file_attachments previously had no workspace_id, so anything that
-- wanted "files for this workspace" had to join through messages ->
-- channels or (worse) fetch everything and filter client-side (the
-- Files page currently does exactly that).
--
-- This migration:
--   1. adds workspace_id (nullable, FK -> workspaces),
--   2. backfills it for all existing rows via messages -> channels,
--   3. adds a BEFORE INSERT trigger that derives it automatically when
--      inserts omit it (keeps every write path working without changes),
--   4. indexes it for range queries + realtime filtering.
--
-- messages.channel_id is NOT NULL and references channels, so every
-- attachment's message resolves to a workspace_id.
--
-- Run AFTER 044_profiles_select_scoped.sql (order irrelevant, but must
-- be after the base schema 000).
-- ============================================================

ALTER TABLE public.file_attachments
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE public.file_attachments fa
SET workspace_id = ch.workspace_id
FROM messages m
JOIN channels ch ON ch.id = m.channel_id
WHERE fa.message_id = m.id
  AND fa.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_file_attachments_workspace_id
  ON public.file_attachments(workspace_id);

CREATE OR REPLACE FUNCTION public.set_file_attachment_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    SELECT ch.workspace_id INTO NEW.workspace_id
    FROM messages m
    JOIN channels ch ON ch.id = m.channel_id
    WHERE m.id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_file_attachments_workspace_id ON public.file_attachments;
CREATE TRIGGER trg_file_attachments_workspace_id
  BEFORE INSERT ON public.file_attachments
  FOR EACH ROW EXECUTE FUNCTION public.set_file_attachment_workspace_id();

-- ==================== 046_workspace_scope_columns.sql ====================
-- ============================================================
-- FIX: workspace/channel scoping columns for realtime + filtering
--
-- Several high-volume tables lacked a workspace (or channel) column,
-- so realtime subscriptions and queries had to be whole-table (noisy,
-- cross-workspace) and filter client-side. This adds:
--
--   messages.workspace_id               -> for scoped realtime (automation
--                                          engine) + workspace-scoped reads
--   reactions.workspace_id              -> for scoped realtime (message pane
--                                          + automation engine)
--   call_participants.workspace_id      -> for scoped realtime (call pane)
--   message_read_receipts.channel_id    -> for scoped realtime + a
--                                          channel-limited read-receipts fetch
--
-- Each column is backfilled from existing relations, kept in sync by a
-- BEFORE INSERT trigger (every insert path keeps working unchanged), and
-- indexed. All statements are idempotent.
--
-- Run AFTER 045_file_attachments_workspace.sql
-- ============================================================

-- ============ messages.workspace_id ============
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE public.messages m
SET workspace_id = ch.workspace_id
FROM channels ch
WHERE m.channel_id = ch.id
  AND m.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_workspace_id ON public.messages(workspace_id);

CREATE OR REPLACE FUNCTION public.set_message_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    SELECT ch.workspace_id INTO NEW.workspace_id
    FROM channels ch
    WHERE ch.id = NEW.channel_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_workspace_id ON public.messages;
CREATE TRIGGER trg_messages_workspace_id
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_workspace_id();

-- ============ reactions.workspace_id ============
ALTER TABLE public.reactions
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE public.reactions r
SET workspace_id = ch.workspace_id
FROM messages m
JOIN channels ch ON ch.id = m.channel_id
WHERE r.message_id = m.id
  AND r.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_reactions_workspace_id ON public.reactions(workspace_id);

CREATE OR REPLACE FUNCTION public.set_reaction_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    SELECT ch.workspace_id INTO NEW.workspace_id
    FROM messages m
    JOIN channels ch ON ch.id = m.channel_id
    WHERE m.id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reactions_workspace_id ON public.reactions;
CREATE TRIGGER trg_reactions_workspace_id
  BEFORE INSERT ON public.reactions
  FOR EACH ROW EXECUTE FUNCTION public.set_reaction_workspace_id();

-- ============ call_participants.workspace_id ============
ALTER TABLE public.call_participants
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE public.call_participants cp
SET workspace_id = cs.workspace_id
FROM call_sessions cs
WHERE cp.call_id = cs.id
  AND cp.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_call_participants_workspace ON public.call_participants(workspace_id);

CREATE OR REPLACE FUNCTION public.set_call_participant_workspace_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    SELECT cs.workspace_id INTO NEW.workspace_id
    FROM call_sessions cs
    WHERE cs.id = NEW.call_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_call_participants_workspace_id ON public.call_participants;
CREATE TRIGGER trg_call_participants_workspace_id
  BEFORE INSERT ON public.call_participants
  FOR EACH ROW EXECUTE FUNCTION public.set_call_participant_workspace_id();

-- ============ message_read_receipts.channel_id ============
ALTER TABLE public.message_read_receipts
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

UPDATE public.message_read_receipts r
SET channel_id = m.channel_id
FROM messages m
WHERE r.message_id = m.id
  AND r.channel_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_read_receipts_channel ON public.message_read_receipts(channel_id);

CREATE OR REPLACE FUNCTION public.set_read_receipt_channel_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    SELECT m.channel_id INTO NEW.channel_id
    FROM messages m
    WHERE m.id = NEW.message_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_read_receipts_channel_id ON public.message_read_receipts;
CREATE TRIGGER trg_read_receipts_channel_id
  BEFORE INSERT ON public.message_read_receipts
  FOR EACH ROW EXECUTE FUNCTION public.set_read_receipt_channel_id();

-- message_read_receipts was missing from the realtime publication, so the
-- read-receipts subscription never received events. Enable it now. Same for
-- pinned_messages (the pinned-messages panel re-subscribes with a channel
-- filter, but the table was never published so its events never arrived).
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.message_read_receipts;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pinned_messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Batch last-message lookup for the DM sidebar. SECURITY INVOKER (default) so
-- RLS still limits results to channels the caller is a member of.
CREATE OR REPLACE FUNCTION public.get_last_messages_for_channels(p_channel_ids UUID[])
RETURNS TABLE(channel_id UUID, content TEXT, created_at TIMESTAMPTZ, user_id UUID) AS $$
  SELECT DISTINCT ON (m.channel_id) m.channel_id, m.content, m.created_at, m.user_id
  FROM messages m
  WHERE m.channel_id = ANY(p_channel_ids)
    AND m.deleted_at IS NULL
    AND m.parent_id IS NULL
  ORDER BY m.channel_id, m.created_at DESC;
$$ LANGUAGE sql STABLE;

-- ==================== 047_workspace_members_realtime.sql ====================
-- Add workspace_members to the realtime publication so that member
-- add/remove events are broadcast to connected clients.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_members;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ==================== 048_forwarded_attachment_policy.sql ====================
-- ============================================================
-- 048_forwarded_attachment_policy.sql
-- Per-user preference for what happens to a message's files when
-- the sender deletes a message that has been forwarded.
--
--   'keep'   (default) deleting the message keeps the storage files
--            for forwarded copies, so forwards keep working.
--   'delete' deleting the message also removes its files from
--            forwarded copies (they become messages with no files)
--            and deletes the files from storage.
--
-- Idempotent: safe to run any number of times.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS forwarded_attachment_policy TEXT NOT NULL DEFAULT 'keep';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_forwarded_attachment_policy_check'
      AND conrelid = 'profiles'::regclass
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_forwarded_attachment_policy_check
      CHECK (forwarded_attachment_policy IN ('keep', 'delete'));
  END IF;
END $$;

-- ==================== 049_workspace_join_links.sql ====================
-- =====================================================================
-- 049 - Workspace invite links & join requests
-- ---------------------------------------------------------------------
-- Workspace owners/admins can generate a shareable invite link. Anyone
-- with the link can request to join the workspace; the owner/admin
-- approves or rejects the request. Both sides get a notification.
--
-- Run this in the Supabase SQL editor (or: psql -f 049_workspace_join_links.sql)
-- =====================================================================

-- Tables ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspace_invite_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invite_links_workspace ON workspace_invite_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invite_links_token ON workspace_invite_links(token);
ALTER TABLE workspace_invite_links ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS workspace_join_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_join_requests_pending
  ON workspace_join_requests(workspace_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_workspace_join_requests_workspace ON workspace_join_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_join_requests_user ON workspace_join_requests(user_id);
ALTER TABLE workspace_join_requests ENABLE ROW LEVEL SECURITY;

-- RLS: only workspace owners/admins may read join requests (drives the
-- realtime subscription in the settings UI). All writes go through the
-- SECURITY DEFINER functions below, so no write policies are needed.
DROP POLICY IF EXISTS "workspace_join_requests_select_managers" ON workspace_join_requests;
CREATE POLICY "workspace_join_requests_select_managers"
  ON workspace_join_requests FOR SELECT
  USING (public.user_is_workspace_admin(workspace_id, auth.uid()));

-- Realtime: broadcast join requests so the owner UI updates live
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_join_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Helpers -----------------------------------------------------------------

-- Resolve invite link info for the public landing page. Safe for the
-- anon role: only returns public workspace details plus the caller's own
-- membership/request status (auth.uid() is NULL for anonymous visitors).
CREATE OR REPLACE FUNCTION public.get_workspace_invite_link_info(p_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_link RECORD;
  v_workspace RECORD;
  v_member BOOLEAN := false;
  v_req_status TEXT := NULL;
BEGIN
  SELECT * INTO v_link FROM workspace_invite_links WHERE token = p_token LIMIT 1;
  IF v_link.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not-found');
  END IF;

  IF v_link.expires_at IS NOT NULL AND v_link.expires_at < now() THEN
    RETURN jsonb_build_object('found', false, 'reason', 'expired');
  END IF;

  SELECT * INTO v_workspace FROM workspaces WHERE id = v_link.workspace_id;
  IF v_workspace.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not-found');
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_member := EXISTS (
      SELECT 1 FROM workspace_members m
      WHERE m.workspace_id = v_workspace.id AND m.user_id = auth.uid()
    );
    SELECT status INTO v_req_status
      FROM workspace_join_requests r
      WHERE r.workspace_id = v_workspace.id AND r.user_id = auth.uid()
      ORDER BY r.created_at DESC
      LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'reason', 'ok',
    'workspace_id', v_workspace.id,
    'workspace_name', v_workspace.name,
    'workspace_slug', v_workspace.slug,
    'workspace_description', v_workspace.description,
    'workspace_avatar_url', v_workspace.avatar_url,
    'expires_at', v_link.expires_at,
    'is_member', v_member,
    'request_status', v_req_status
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_workspace_invite_link_info(TEXT) TO anon, authenticated;

-- Create a new invite link (owner/admin only). Links live 30 days.
CREATE OR REPLACE FUNCTION public.create_workspace_invite_link(p_workspace_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_link RECORD;
  v_token TEXT;
BEGIN
  IF NOT public.user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'You do not have permission to create invite links.');
  END IF;

  v_token := substr(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 1, 24);

  INSERT INTO workspace_invite_links (workspace_id, token, created_by, expires_at)
  VALUES (p_workspace_id, v_token, auth.uid(), now() + interval '30 days')
  RETURNING * INTO v_link;

  RETURN jsonb_build_object('success', true, 'link', to_jsonb(v_link));
END;
$$;

-- List active invite links for a workspace (owner/admin only)
CREATE OR REPLACE FUNCTION public.get_workspace_invite_links(p_workspace_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_links jsonb;
BEGIN
  IF NOT public.user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb)
    INTO v_links
    FROM workspace_invite_links l
    WHERE l.workspace_id = p_workspace_id
      AND (l.expires_at IS NULL OR l.expires_at > now());

  RETURN v_links;
END;
$$;

-- Revoke (delete) an invite link (owner/admin only)
CREATE OR REPLACE FUNCTION public.revoke_workspace_invite_link(p_link_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_workspace_id UUID;
BEGIN
  SELECT workspace_id INTO v_workspace_id FROM workspace_invite_links WHERE id = p_link_id;
  IF v_workspace_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invite link not found.');
  END IF;

  IF NOT public.user_is_workspace_admin(v_workspace_id, auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'You do not have permission to revoke invite links.');
  END IF;

  DELETE FROM workspace_invite_links WHERE id = p_link_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- Submit a join request for the signed-in user via an invite link.
-- Also notifies the workspace owners/admins.
CREATE OR REPLACE FUNCTION public.submit_workspace_join_request(p_token TEXT)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_link RECORD;
  v_workspace RECORD;
  v_user_id UUID := auth.uid();
  v_req_id UUID;
  v_manager RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You must be signed in to request access.');
  END IF;

  SELECT * INTO v_link FROM workspace_invite_links WHERE token = p_token LIMIT 1;
  IF v_link.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This invite link is invalid or no longer exists.');
  END IF;

  IF v_link.expires_at IS NOT NULL AND v_link.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'This invite link has expired.');
  END IF;

  SELECT * INTO v_workspace FROM workspaces WHERE id = v_link.workspace_id;
  IF v_workspace.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This workspace no longer exists.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = v_workspace.id AND m.user_id = v_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already-member');
  END IF;

  IF EXISTS (
    SELECT 1 FROM workspace_join_requests r
    WHERE r.workspace_id = v_workspace.id AND r.user_id = v_user_id AND r.status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already-requested');
  END IF;

  -- Drop old decided requests so a re-request after a rejection works cleanly
  DELETE FROM workspace_join_requests
  WHERE workspace_id = v_workspace.id AND user_id = v_user_id;

  INSERT INTO workspace_join_requests (workspace_id, user_id)
  VALUES (v_workspace.id, v_user_id)
  RETURNING id INTO v_req_id;

  FOR v_manager IN
    SELECT user_id FROM workspace_members
    WHERE workspace_id = v_workspace.id AND role IN ('owner', 'admin')
  LOOP
    IF v_manager.user_id <> v_user_id THEN
      PERFORM public.create_notification(
        v_manager.user_id,
        'invitation',
        'New join request',
        'Someone requested to join ' || v_workspace.name || '.',
        '/settings?tab=join-requests',
        'workspace',
        'workspace',
        v_workspace.id,
        v_user_id,
        v_workspace.id
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'request_id', v_req_id, 'workspace_name', v_workspace.name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_workspace_join_request(TEXT) TO authenticated;

-- List join requests for a workspace (owner/admin only). Pending first,
-- newest first; includes the requester profile for display.
CREATE OR REPLACE FUNCTION public.get_workspace_join_requests(p_workspace_id UUID)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.user_is_workspace_admin(p_workspace_id, auth.uid()) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', r.id,
      'workspace_id', r.workspace_id,
      'user_id', r.user_id,
      'status', r.status,
      'decided_by', r.decided_by,
      'decided_at', r.decided_at,
      'created_at', r.created_at,
      'updated_at', r.updated_at,
      'requester_name', p.display_name,
      'requester_username', p.username,
      'requester_avatar_url', p.avatar_url
    ) ORDER BY (r.status = 'pending') DESC, r.created_at DESC
  ), '[]'::jsonb) INTO v_rows
  FROM workspace_join_requests r
  LEFT JOIN profiles p ON p.id = r.user_id
  WHERE r.workspace_id = p_workspace_id;

  RETURN v_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_workspace_join_requests(UUID) TO authenticated;

-- Approve or reject a join request (owner/admin only). Approving adds the
-- user as a workspace member and notifies them.
CREATE OR REPLACE FUNCTION public.decide_workspace_join_request(p_request_id UUID, p_accept BOOLEAN)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_request RECORD;
  v_workspace RECORD;
  v_manager UUID := auth.uid();
BEGIN
  IF v_manager IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You must be signed in.');
  END IF;

  SELECT * INTO v_request FROM workspace_join_requests WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found.');
  END IF;

  IF v_request.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This request has already been decided.');
  END IF;

  IF NOT public.user_is_workspace_admin(v_request.workspace_id, v_manager) THEN
    RETURN jsonb_build_object('success', false, 'error', 'You do not have permission to decide join requests.');
  END IF;

  SELECT * INTO v_workspace FROM workspaces WHERE id = v_request.workspace_id;

  IF p_accept THEN
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (v_request.workspace_id, v_request.user_id, 'member')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    UPDATE workspace_join_requests
    SET status = 'accepted', decided_by = v_manager, decided_at = now(), updated_at = now()
    WHERE id = p_request_id;

    PERFORM public.create_notification(
      v_request.user_id,
      'invitation',
      'Request approved',
      'You have been added to ' || v_workspace.name || '.',
      '/',
      'workspace',
      'workspace',
      v_request.workspace_id,
      v_manager,
      v_request.workspace_id
    );
  ELSE
    UPDATE workspace_join_requests
    SET status = 'rejected', decided_by = v_manager, decided_at = now(), updated_at = now()
    WHERE id = p_request_id;

    PERFORM public.create_notification(
      v_request.user_id,
      'invitation',
      'Request declined',
      'Your request to join ' || v_workspace.name || ' was declined.',
      NULL,
      'workspace',
      'workspace',
      v_request.workspace_id,
      v_manager,
      v_request.workspace_id
    );
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_workspace_join_request(UUID, BOOLEAN) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_workspace_invite_link(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_workspace_invite_links(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_workspace_invite_link(UUID) TO authenticated;

-- ==================== 050_server_side_automation_engine.sql ====================
-- ============================================================================
-- 050_server_side_automation_engine.sql
-- ----------------------------------------------------------------------------
-- Moves automation rule EXECUTION out of the browser and into Postgres.
--
-- Problem being fixed:
--   1. The client engine (useAutomationEngine) only runs while a browser tab is
--      open AND signed in as the rule creator, so automations silently stop
--      when the creator goes offline.
--   2. Realtime events fire in EVERY open tab of the creator, so with N tabs /
--      devices open the same automation executes N times (duplicate
--      notifications, tasks, messages, and inflated unread badges).
--
-- Fix:
--   * A SECURITY DEFINER engine (`evaluate_automation_rules`) evaluates every
--     enabled rule for the workspace INSIDE the same transaction as the
--     triggering event. It runs exactly once, server-side, regardless of who
--     is online or how many tabs are open.
--   * Table triggers call the engine for every event type the UI exposes:
--     message.posted, message.mentioned, message.reaction_added, task.created,
--     task.status_changed, task.completed, task.assigned, project.created,
--     project.archived, member.joined, member.left, calendar.event_created.
--   * Two pg_cron jobs handle the time-based triggers (calendar.event_reminder
--     15 min before, calendar.event_started when an event begins) using a
--     dedup table so they fire once per event even when nobody is online.
--   * Delayed actions keep working offline: send_reminder -> reminders table
--     (delivered by send_due_reminders cron), schedule_message ->
--     scheduled_messages (delivered by send_due_scheduled_messages cron).
--
-- Run this in the Supabase SQL editor for the project this app uses.
-- It is idempotent and safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) Drop the OLD client-era SQL engine + triggers so there is only ONE engine.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_message_posted ON messages;
DROP TRIGGER IF EXISTS trg_task_events ON tasks;
DROP FUNCTION IF EXISTS public.evaluate_automation_rules(UUID, TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS public.fn_fire_message_posted();
DROP FUNCTION IF EXISTS public.fn_fire_task_events();
DROP FUNCTION IF EXISTS public.log_automation_execution(UUID, TEXT, UUID, BOOLEAN, INTEGER, BOOLEAN, TEXT);

-- Defensive schema guards (idempotent; normally covered by earlier migrations
-- 025 / 027, but keeps this migration self-contained).
ALTER TABLE public.automation_rules
  ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMPTZ;
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id UUID,
  ADD COLUMN IF NOT EXISTS recipients uuid[] DEFAULT ARRAY[]::uuid[],
  ADD COLUMN IF NOT EXISTS message TEXT;

-- ---------------------------------------------------------------------------
-- 1) Dedup table for time-based calendar triggers (fire once per event).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automation_event_fired (
  event_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  workspace_id UUID,
  fired_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (event_type, entity_id)
);

-- Internal dedup bookkeeping: only SECURITY DEFINER functions (table owner)
-- touch this table, so enable RLS with no policies to block anon/authenticated
-- clients entirely.
ALTER TABLE public.automation_event_fired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_event_fired FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2) Small helpers
-- ---------------------------------------------------------------------------

-- Resolve the "trigger creator" (the actor behind the event) the same way the
-- client engine did: sender_id / created_by / user_id, else the rule creator.
CREATE OR REPLACE FUNCTION public.automation_resolve_actor(
  p_context JSONB,
  p_rule_creator UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(p_context ->> 'sender_id', '')::UUID,
    NULLIF(p_context ->> 'created_by', '')::UUID,
    NULLIF(p_context ->> 'user_id', '')::UUID,
    p_rule_creator
  );
$$;

-- Evaluate a single condition against the event context (mirrors
-- evaluateCondition / matchesConditions in the old client engine).
CREATE OR REPLACE FUNCTION public.automation_eval_condition(
  p_field TEXT,
  p_operator TEXT,
  p_value TEXT,
  p_context JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_actual TEXT;
  v_num_f NUMERIC;
  v_num_v NUMERIC;
BEGIN
  v_actual := COALESCE(p_context ->> p_field, '');
  CASE p_operator
    WHEN 'equals' THEN
      RETURN v_actual = COALESCE(p_value, '');
    WHEN 'not_equals' THEN
      RETURN v_actual <> COALESCE(p_value, '');
    WHEN 'contains' THEN
      RETURN position(lower(COALESCE(p_value, '')) in lower(v_actual)) > 0;
    WHEN 'not_contains' THEN
      RETURN position(lower(COALESCE(p_value, '')) in lower(v_actual)) = 0;
    WHEN 'greater_than' THEN
      BEGIN
        v_num_f := v_actual::NUMERIC; v_num_v := COALESCE(p_value, '0')::NUMERIC;
        RETURN v_num_f > v_num_v;
      EXCEPTION WHEN OTHERS THEN RETURN false; END;
    WHEN 'less_than' THEN
      BEGIN
        v_num_f := v_actual::NUMERIC; v_num_v := COALESCE(p_value, '0')::NUMERIC;
        RETURN v_num_f < v_num_v;
      EXCEPTION WHEN OTHERS THEN RETURN false; END;
    WHEN 'gte' THEN
      BEGIN
        v_num_f := v_actual::NUMERIC; v_num_v := COALESCE(p_value, '0')::NUMERIC;
        RETURN v_num_f >= v_num_v;
      EXCEPTION WHEN OTHERS THEN RETURN false; END;
    WHEN 'lte' THEN
      BEGIN
        v_num_f := v_actual::NUMERIC; v_num_v := COALESCE(p_value, '0')::NUMERIC;
        RETURN v_num_f <= v_num_v;
      EXCEPTION WHEN OTHERS THEN RETURN false; END;
    WHEN 'is_empty' THEN
      RETURN v_actual = '' OR v_actual IS NULL;
    WHEN 'is_not_empty' THEN
      RETURN v_actual <> '' AND v_actual IS NOT NULL;
    ELSE
      RETURN true;
  END CASE;
END;
$$;

-- Find or create the DM (direct_conversations + backing channel) between the
-- rule creator and the target user, mirroring getOrCreateDmConversation.
CREATE OR REPLACE FUNCTION public.automation_resolve_dm(
  p_workspace_id UUID,
  p_creator_id UUID,
  p_other_id UUID,
  OUT v_conversation_id UUID,
  OUT v_channel_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_count INTEGER;
BEGIN
  v_member_count := (SELECT COUNT(DISTINCT x) FROM unnest(ARRAY[p_creator_id, p_other_id]) x);

  SELECT dc.conversation_id, dc.channel_id INTO v_conversation_id, v_channel_id
  FROM (
    SELECT dc.id AS conversation_id, dc.channel_id
    FROM direct_conversations dc
    WHERE dc.workspace_id = p_workspace_id
      AND dc.type = 'dm'
      AND (SELECT count(*) FROM direct_conversation_participants dcp WHERE dcp.conversation_id = dc.id) = v_member_count
      AND NOT EXISTS (
        SELECT 1 FROM direct_conversation_participants dcp
        WHERE dcp.conversation_id = dc.id
          AND dcp.user_id <> ALL (ARRAY[p_creator_id, p_other_id])
      )
    LIMIT 1
  ) dc;

  IF v_conversation_id IS NULL THEN
    INSERT INTO channels (workspace_id, name, slug, type, is_private, created_by)
    VALUES (p_workspace_id, 'Direct Message', 'dm-' || substr(gen_random_uuid()::text, 1, 8), 'text', true, p_creator_id)
    RETURNING id INTO v_channel_id;

    INSERT INTO channel_members (channel_id, user_id, role)
    SELECT v_channel_id, x, CASE WHEN x = p_creator_id THEN 'owner' ELSE 'member' END
    FROM unnest(ARRAY[p_creator_id, p_other_id]) x
    ON CONFLICT (channel_id, user_id) DO NOTHING;

    INSERT INTO direct_conversations (workspace_id, channel_id, type, created_by)
    VALUES (p_workspace_id, v_channel_id, 'dm', p_creator_id)
    RETURNING id INTO v_conversation_id;

    INSERT INTO direct_conversation_participants (conversation_id, user_id)
    SELECT v_conversation_id, x FROM unnest(ARRAY[p_creator_id, p_other_id]) x
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END IF;
END;
$$;

-- Next status in the task's flow order (mirrors getTaskStatusOrder + the
-- 'next' branch of update_status in the client engine).
CREATE OR REPLACE FUNCTION public.automation_next_status(
  p_task_id UUID,
  p_current TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_order TEXT[] := '{}';
  v_customs TEXT[] := '{}';
  v_hidden TEXT[] := '{}';
  v_task_order TEXT[] := '{}';
  v_ordered TEXT[] := '{}';
  v_missing TEXT[] := '{}';
  v_idx INTEGER;
  x TEXT;
BEGIN
  SELECT COALESCE(ARRAY_AGG(c.id ORDER BY c.sort_order), '{}')
    INTO v_customs
  FROM task_custom_statuses c
  WHERE c.task_id = p_task_id AND c.name NOT LIKE '__hidden__:%';

  SELECT COALESCE(ARRAY_AGG(substr(c.name, 11)), '{}')
    INTO v_hidden
  FROM task_custom_statuses c
  WHERE c.task_id = p_task_id AND c.name LIKE '__hidden__:%';

  SELECT COALESCE(ARRAY(
    SELECT s FROM (VALUES ('backlog'), ('todo'), ('in_progress'), ('review'), ('completed')) t(s)
    WHERE s <> ALL (v_hidden)
  ), '{}') INTO v_order;
  v_order := v_order || v_customs;

  SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.status_order)), '{}')
    INTO v_task_order
  FROM tasks t WHERE t.id = p_task_id;

  IF array_length(v_task_order, 1) > 0 THEN
    FOREACH x IN ARRAY v_task_order LOOP
      IF x = ANY(v_order) AND NOT (x = ANY(v_ordered)) THEN
        v_ordered := v_ordered || x;
      END IF;
    END LOOP;
    FOREACH x IN ARRAY v_order LOOP
      IF NOT (x = ANY(v_ordered)) THEN
        v_missing := v_missing || x;
      END IF;
    END LOOP;
    v_order := v_ordered || v_missing;
  END IF;

  v_idx := array_position(v_order, p_current);
  IF v_idx IS NOT NULL AND v_idx < array_length(v_order, 1) THEN
    RETURN v_order[v_idx + 1];
  END IF;
  RETURN p_current;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) THE ENGINE: evaluate every matching enabled rule and run its actions.
--    Runs SECURITY DEFINER inside the triggering transaction. Per-rule and
--    per-action exception handling guarantee a broken rule can never fail the
--    user's original INSERT (e.g. posting a message).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_automation_rules(
  p_workspace_id UUID,
  p_event_type TEXT,
  p_entity_id UUID,
  p_entity_data JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule RECORD;
  v_cond RECORD;
  v_context JSONB;
  v_met BOOLEAN;
  v_result BOOLEAN;
  v_all_succeeded BOOLEAN;
  v_executed INTEGER;
  v_err TEXT;
BEGIN
  FOR v_rule IN
    SELECT ar.id, ar.created_by
    FROM automation_rules ar
    JOIN automation_triggers t ON t.rule_id = ar.id
    WHERE ar.workspace_id = p_workspace_id
      AND ar.enabled = true
      AND t.event_type = p_event_type
      AND (
        p_event_type <> 'message.mentioned'
        OR EXISTS (
          SELECT 1 FROM profiles mp
          WHERE mp.id = ar.created_by
            AND (
              (
                regexp_replace(lower(COALESCE(mp.username, '')), '[^a-z0-9_]', '', 'g') <> ''
                AND lower(COALESCE(p_entity_data ->> 'content', '')) ~
                  (E'@\\m' || regexp_replace(lower(COALESCE(mp.username, '')), '[^a-z0-9_]', '', 'g') || E'\\M')
              )
              OR lower(COALESCE(p_entity_data ->> 'content', '')) ~ E'@\\mhere\\M'
            )
        )
      )
    GROUP BY ar.id, ar.created_by
  LOOP
    BEGIN
      v_context := p_entity_data;
      IF p_entity_data ? 'sender_id' THEN
        v_context := v_context || jsonb_build_object(
          'is_own',
          COALESCE((p_entity_data ->> 'sender_id')::UUID, '00000000-0000-0000-0000-000000000000'::UUID) = v_rule.created_by
        );
      END IF;

      v_result := true;
      v_executed := 0;
      v_all_succeeded := true;
      v_err := NULL;

      FOR v_cond IN
        SELECT field, operator, value, logic
        FROM automation_conditions
        WHERE rule_id = v_rule.id
        ORDER BY created_at ASC, id ASC
      LOOP
        v_met := public.automation_eval_condition(v_cond.field, v_cond.operator, v_cond.value, v_context);
        IF v_cond.logic = 'or' THEN
          v_result := v_result OR v_met;
        ELSE
          v_result := v_result AND v_met;
        END IF;
      END LOOP;

      IF v_result THEN
        DECLARE
          v_act RECORD;
        BEGIN
          FOR v_act IN
            SELECT action_type, config
            FROM automation_actions
            WHERE rule_id = v_rule.id
            ORDER BY sort_order ASC, id ASC
          LOOP
            BEGIN
              PERFORM public.automation_execute_action(
                v_rule.id, v_rule.created_by, p_workspace_id, p_event_type,
                p_entity_id, v_act.action_type, v_act.config, v_context
              );
              v_executed := v_executed + 1;
            EXCEPTION WHEN OTHERS THEN
              v_all_succeeded := false;
              v_err := SQLERRM;
              RAISE WARNING 'automation action failed rule=% action=% err=%', v_rule.id, v_act.action_type, SQLERRM;
            END;
          END LOOP;
        END;

        INSERT INTO automation_execution_logs
          (rule_id, trigger_event, trigger_entity_id, conditions_met, actions_executed, success, error_message)
        VALUES
          (v_rule.id, p_event_type, p_entity_id, true, v_executed,
           v_all_succeeded AND v_executed > 0,
           CASE WHEN v_all_succeeded THEN NULL ELSE COALESCE(v_err, 'action failed') END);

        UPDATE automation_rules SET last_executed_at = now(), updated_at = now() WHERE id = v_rule.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'automation evaluation failed rule=% event=% err=%', v_rule.id, p_event_type, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) ACTION EXECUTION (mirrors executeAction in the old client engine).
--    Returns normally on intentional skips; raises on hard failures (caught by
--    the caller so one bad action does not stop the remaining actions).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.automation_execute_action(
  p_rule_id UUID,
  p_rule_creator UUID,
  p_workspace_id UUID,
  p_event_type TEXT,
  p_entity_id UUID,
  p_action_type TEXT,
  p_config JSONB,
  p_context JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id UUID;
  v_title TEXT;
  v_message TEXT;
  v_link TEXT;
  v_targets UUID[];
  v_unique UUID[];
  v_task_id UUID;
  v_new_task_id UUID;
  v_channel_id UUID;
  v_conv_id UUID;
  v_message_id UUID;
  v_content TEXT;
  v_parent_id UUID;
  v_raw_channel TEXT;
  v_scheduled_at TIMESTAMPTZ;
  v_scheduled_message_id UUID;
  v_delay NUMERIC;
  v_days_until INTEGER;
  v_remind_at TIMESTAMPTZ;
  v_entity_type TEXT;
  v_status TEXT;
  v_has_attachments BOOLEAN;
BEGIN
  v_actor_id := public.automation_resolve_actor(p_context, p_rule_creator);
  v_title := COALESCE(p_config ->> 'title', '');
  v_message := COALESCE(p_config ->> 'message', '');
  v_link := COALESCE(p_context ->> 'link', '/');
  v_has_attachments := (p_config -> 'attachments') IS NOT NULL
    AND jsonb_typeof(p_config -> 'attachments') = 'array'
    AND jsonb_array_length(p_config -> 'attachments') > 0;

  CASE p_action_type
    WHEN 'send_notification' THEN
      v_targets := ARRAY[v_actor_id];
      IF COALESCE(p_config ->> 'recipients', 'trigger_creator') = 'all_members' THEN
        v_targets := ARRAY(SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id = p_workspace_id);
      ELSIF COALESCE(p_config ->> 'recipients', 'trigger_creator') = 'assignee'
        AND NULLIF(p_context ->> 'assignee_id', '') IS NOT NULL THEN
        v_targets := ARRAY[(p_context ->> 'assignee_id')::UUID];
      ELSIF COALESCE(p_config ->> 'recipients', 'trigger_creator') = 'self' THEN
        v_targets := ARRAY[p_rule_creator];
      END IF;

      v_unique := ARRAY(SELECT DISTINCT x FROM unnest(v_targets) x WHERE x IS NOT NULL);
      INSERT INTO notifications (user_id, type, title, message, link, category, workspace_id)
      SELECT x, 'automation',
        COALESCE(NULLIF(v_title, ''), 'Automation Alert'),
        COALESCE(NULLIF(v_message, ''), 'You have a new notification'),
        v_link, 'automation', p_workspace_id
      FROM unnest(v_unique) x
      WHERE x IS NOT NULL;

    WHEN 'create_task' THEN
      v_status := COALESCE(p_config ->> 'status', 'todo');
      IF v_status NOT IN ('backlog', 'todo', 'in_progress', 'review', 'completed', 'cancelled') THEN
        v_status := 'todo';
      END IF;
      INSERT INTO tasks (workspace_id, title, description, priority, status, created_by, project_id)
      VALUES (
        p_workspace_id,
        COALESCE(NULLIF(p_config ->> 'title', ''), 'New Task'),
        NULLIF(p_config ->> 'description', ''),
        COALESCE(NULLIF(p_config ->> 'priority', ''), 'medium'),
        v_status,
        p_rule_creator,
        NULLIF(p_context ->> 'project_id', '')::UUID
      )
      RETURNING id INTO v_new_task_id;

      IF COALESCE(p_config ->> 'assignee', 'none') = 'trigger_creator' THEN
        INSERT INTO task_assignees (task_id, user_id, assigned_by)
        VALUES (v_new_task_id, v_actor_id, p_rule_creator)
        ON CONFLICT (task_id, user_id) DO NOTHING;
      ELSIF COALESCE(p_config ->> 'assignee', 'none') = 'specific_user' THEN
        INSERT INTO task_assignees (task_id, user_id, assigned_by)
        SELECT v_new_task_id, uid, p_rule_creator
        FROM (
          SELECT value AS uid FROM jsonb_array_elements_text(COALESCE(p_config -> 'assignee_ids', '[]'::jsonb))
          UNION
          SELECT NULLIF(p_config ->> 'assignee_id', '')
        ) t
        WHERE uid IS NOT NULL AND uid <> ''
        ON CONFLICT (task_id, user_id) DO NOTHING;
      END IF;

    WHEN 'assign_task' THEN
      v_task_id := COALESCE(NULLIF(p_config ->> 'task_id', '')::UUID, p_entity_id);
      IF v_task_id IS NULL THEN RETURN; END IF;
      CASE COALESCE(p_config ->> 'assignee', 'trigger_creator')
        WHEN 'trigger_creator' THEN
          INSERT INTO task_assignees (task_id, user_id, assigned_by)
          VALUES (v_task_id, v_actor_id, p_rule_creator)
          ON CONFLICT (task_id, user_id) DO NOTHING;
        WHEN 'self' THEN
          INSERT INTO task_assignees (task_id, user_id, assigned_by)
          VALUES (v_task_id, p_rule_creator, p_rule_creator)
          ON CONFLICT (task_id, user_id) DO NOTHING;
        WHEN 'trigger_assignee' THEN
          IF NULLIF(p_context ->> 'assignee_id', '') IS NOT NULL THEN
            INSERT INTO task_assignees (task_id, user_id, assigned_by)
            VALUES (v_task_id, (p_context ->> 'assignee_id')::UUID, p_rule_creator)
            ON CONFLICT (task_id, user_id) DO NOTHING;
          END IF;
        WHEN 'specific_user' THEN
          INSERT INTO task_assignees (task_id, user_id, assigned_by)
          SELECT v_task_id, uid, p_rule_creator
          FROM (
            SELECT value AS uid FROM jsonb_array_elements_text(COALESCE(p_config -> 'assignee_ids', '[]'::jsonb))
            UNION
            SELECT NULLIF(p_config ->> 'assignee_id', '')
            UNION
            SELECT p.id::text FROM profiles p WHERE lower(p.email) = lower(COALESCE(NULLIF(p_config ->> 'assignee_email', ''), ''))
          ) t
          WHERE uid IS NOT NULL AND uid <> ''
          ON CONFLICT (task_id, user_id) DO NOTHING;
      END CASE;

    WHEN 'update_status' THEN
      v_task_id := COALESCE(NULLIF(p_config ->> 'task_id', '')::UUID, p_entity_id);
      IF v_task_id IS NULL THEN RETURN; END IF;
      v_status := COALESCE(p_config ->> 'status', 'todo');
      IF v_status = 'next' THEN
        v_status := public.automation_next_status(v_task_id, (SELECT status FROM tasks WHERE id = v_task_id));
      END IF;
      IF v_status = '' THEN v_status := 'todo'; END IF;
      UPDATE tasks SET status = v_status, updated_at = now() WHERE id = v_task_id;

    WHEN 'post_message' THEN
      v_raw_channel := COALESCE(p_config ->> 'channel', '');
      v_content := COALESCE(p_config ->> 'content', '');
      IF v_content = '' AND NOT v_has_attachments THEN RETURN; END IF;

      IF v_raw_channel = '__trigger_creator__' THEN
        IF v_actor_id IS NULL THEN RETURN; END IF;
        SELECT * INTO v_conv_id, v_channel_id
        FROM public.automation_resolve_dm(p_workspace_id, p_rule_creator, v_actor_id);
      ELSIF v_raw_channel <> '' THEN
        v_channel_id := v_raw_channel::UUID;
      ELSE
        v_channel_id := NULLIF(p_context ->> 'channel_id', '')::UUID;
      END IF;
      IF v_channel_id IS NULL THEN RETURN; END IF;

      INSERT INTO messages (channel_id, user_id, content)
      VALUES (v_channel_id, p_rule_creator, CASE WHEN v_content = '' THEN ' ' ELSE v_content END)
      RETURNING id INTO v_message_id;

      INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
      SELECT v_message_id, p_rule_creator,
        COALESCE(att ->> 'file_name', 'file'),
        COALESCE(NULLIF(att ->> 'file_size', '')::BIGINT, 0),
        COALESCE(att ->> 'file_type', ''),
        att ->> 'file_url'
      FROM jsonb_array_elements(COALESCE(p_config -> 'attachments', '[]'::jsonb)) att
      WHERE NULLIF(att ->> 'file_url', '') IS NOT NULL;

    WHEN 'auto_reply' THEN
      v_content := COALESCE(p_config ->> 'content', '');
      IF v_content = '' AND NOT v_has_attachments THEN RETURN; END IF;
      IF NULLIF(p_context ->> 'channel_id', '') IS NULL THEN RETURN; END IF;
      -- Self-replies (sender = rule creator) are allowed: the reply message is
      -- inserted while the messages trigger is already running, so the engine's
      -- own insert is at pg_trigger_depth() > 1 and never re-triggers the rules.
      -- That depth guard is what prevents echo loops, not a sender filter.
      v_channel_id := (p_context ->> 'channel_id')::UUID;
      v_parent_id := NULLIF(p_context ->> 'entity_id', '')::UUID;
      IF COALESCE(p_config ->> 'reply_mode', 'inline') <> 'thread' THEN
        v_parent_id := NULL;
      END IF;

      INSERT INTO messages (channel_id, user_id, content, parent_id)
      VALUES (v_channel_id, p_rule_creator, CASE WHEN v_content = '' THEN ' ' ELSE v_content END, v_parent_id)
      RETURNING id INTO v_message_id;

      INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
      SELECT v_message_id, p_rule_creator,
        COALESCE(att ->> 'file_name', 'file'),
        COALESCE(NULLIF(att ->> 'file_size', '')::BIGINT, 0),
        COALESCE(att ->> 'file_type', ''),
        att ->> 'file_url'
      FROM jsonb_array_elements(COALESCE(p_config -> 'attachments', '[]'::jsonb)) att
      WHERE NULLIF(att ->> 'file_url', '') IS NOT NULL;

    WHEN 'schedule_message' THEN
      v_content := COALESCE(p_config ->> 'content', '');
      IF v_content = '' AND NOT v_has_attachments THEN RETURN; END IF;

      v_delay := NULLIF(p_config ->> 'delay_minutes', '')::NUMERIC;
      v_scheduled_at := NULLIF(p_config ->> 'scheduled_at', '')::TIMESTAMPTZ;
      IF v_scheduled_at IS NOT NULL AND v_scheduled_at <= now() THEN
        v_scheduled_at := NULL;
      END IF;
      IF v_scheduled_at IS NULL THEN
        IF v_delay IS NULL OR v_delay <= 0 THEN RETURN; END IF;
        v_scheduled_at := now() + (v_delay * INTERVAL '1 minute');
      END IF;

      v_raw_channel := COALESCE(p_config ->> 'channel', '');
      v_channel_id := NULL;
      v_conv_id := NULL;
      IF v_raw_channel = '__trigger_creator__' THEN
        IF v_actor_id IS NULL THEN RETURN; END IF;
        SELECT * INTO v_conv_id, v_channel_id
        FROM public.automation_resolve_dm(p_workspace_id, p_rule_creator, v_actor_id);
      ELSIF v_raw_channel <> '' THEN
        v_channel_id := v_raw_channel::UUID;
      ELSE
        v_conv_id := NULLIF(p_context ->> 'conversation_id', '')::UUID;
        IF v_conv_id IS NULL THEN
          v_channel_id := NULLIF(p_context ->> 'channel_id', '')::UUID;
        END IF;
      END IF;
      IF v_channel_id IS NULL AND v_conv_id IS NULL THEN RETURN; END IF;

      INSERT INTO scheduled_messages (user_id, channel_id, conversation_id, content, scheduled_at)
      VALUES (p_rule_creator, v_channel_id, v_conv_id, CASE WHEN v_content = '' THEN ' ' ELSE v_content END, v_scheduled_at)
      RETURNING id INTO v_scheduled_message_id;

      INSERT INTO scheduled_message_attachments (scheduled_message_id, user_id, file_name, file_size, file_type, file_url)
      SELECT v_scheduled_message_id, p_rule_creator,
        COALESCE(att ->> 'file_name', 'file'),
        COALESCE(NULLIF(att ->> 'file_size', '')::BIGINT, 0),
        COALESCE(att ->> 'file_type', ''),
        att ->> 'file_url'
      FROM jsonb_array_elements(COALESCE(p_config -> 'attachments', '[]'::jsonb)) att
      WHERE NULLIF(att ->> 'file_url', '') IS NOT NULL;

    WHEN 'send_reminder' THEN
      CASE COALESCE(p_config ->> 'delay_type', 'minutes')
        WHEN 'specific_time' THEN
          IF NULLIF(p_config ->> 'scheduled_time', '') IS NULL THEN RETURN; END IF;
          v_remind_at := (date_trunc('day', now())::date + (p_config ->> 'scheduled_time')::time)::timestamptz;
          IF v_remind_at <= now() THEN v_remind_at := v_remind_at + INTERVAL '1 day'; END IF;
        WHEN 'specific_day' THEN
          IF NULLIF(p_config ->> 'scheduled_day', '') IS NULL THEN RETURN; END IF;
          v_remind_at := (date_trunc('day', now())::date + COALESCE(NULLIF(p_config ->> 'scheduled_time', ''), '09:00')::time)::timestamptz;
          v_days_until := ((p_config ->> 'scheduled_day')::INTEGER - EXTRACT(DOW FROM v_remind_at)::INTEGER + 7) % 7;
          IF v_days_until = 0 AND v_remind_at <= now() THEN v_days_until := 7; END IF;
          v_remind_at := v_remind_at + (v_days_until * INTERVAL '1 day');
        ELSE
          v_delay := NULLIF(p_config ->> 'delay_minutes', '')::NUMERIC;
          IF v_delay IS NULL OR v_delay <= 0 THEN RETURN; END IF;
          v_remind_at := now() + (v_delay * INTERVAL '1 minute');
      END CASE;

      v_targets := '{}';
      CASE COALESCE(p_config ->> 'target_type', 'self')
        WHEN 'trigger_creator' THEN
          v_targets := ARRAY[v_actor_id];
        WHEN 'user' THEN
          IF NULLIF(p_config ->> 'target_id', '') IS NOT NULL THEN
            v_targets := ARRAY[(p_config ->> 'target_id')::UUID];
          END IF;
        WHEN 'channel' THEN
          IF NULLIF(p_config ->> 'target_id', '') IS NOT NULL THEN
            v_targets := ARRAY(SELECT cm.user_id FROM channel_members cm WHERE cm.channel_id = (p_config ->> 'target_id')::UUID);
          END IF;
        WHEN 'dm' THEN
          IF NULLIF(p_config ->> 'target_id', '') IS NOT NULL THEN
            v_targets := ARRAY(SELECT dcp.user_id FROM direct_conversation_participants dcp WHERE dcp.conversation_id = (p_config ->> 'target_id')::UUID);
          END IF;
        ELSE
          v_targets := ARRAY[p_rule_creator];
      END CASE;

      v_unique := ARRAY(SELECT DISTINCT x FROM unnest(v_targets) x WHERE x IS NOT NULL);
      IF array_length(v_unique, 1) IS NULL OR (array_length(v_unique, 1) = 1 AND v_unique[1] = p_rule_creator) THEN
        v_unique := '{}';
      END IF;

      v_entity_type := COALESCE(p_context ->> 'entity_type', 'custom');
      IF v_entity_type NOT IN ('task', 'event', 'milestone', 'message', 'custom') THEN
        v_entity_type := 'custom';
      END IF;

      INSERT INTO reminders (user_id, title, remind_at, entity_type, entity_id, target_type, target_id, recipients, message)
      VALUES (
        p_rule_creator,
        COALESCE(NULLIF(v_title, ''), 'Reminder'),
        v_remind_at,
        v_entity_type,
        NULLIF(p_context ->> 'entity_id', '')::UUID,
        COALESCE(NULLIF(p_config ->> 'target_type', ''), 'self'),
        NULLIF(p_config ->> 'target_id', '')::UUID,
        v_unique,
        NULLIF(p_config ->> 'message', '')
      );

    ELSE
      RETURN; -- unknown action type -> ignore
  END CASE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) TRIGGER FUNCTIONS + TRIGGERS
--    The pg_trigger_depth() > 1 guard stops recursion: actions that insert
--    into the same tables (post_message/auto_reply/update_status) never
--    re-fire the engine.
-- ---------------------------------------------------------------------------

-- messages -> message.posted + message.mentioned
CREATE OR REPLACE FUNCTION public.fn_automation_message_events()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_channel_name TEXT;
  v_creator_name TEXT;
  v_creator_email TEXT;
  v_ctx JSONB;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT c.workspace_id, c.name INTO v_workspace_id, v_channel_name
  FROM channels c WHERE c.id = NEW.channel_id;
  IF v_workspace_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), p.email
    INTO v_creator_name, v_creator_email
  FROM profiles p WHERE p.id = NEW.user_id;

  v_ctx := jsonb_build_object(
    'entity_id', NEW.id,
    'entity_type', 'message',
    'channel_id', NEW.channel_id,
    'channel_name', COALESCE(v_channel_name, ''),
    'content', COALESCE(NEW.content, ''),
    'message_content', COALESCE(NEW.content, ''),
    'message_length', COALESCE(length(NEW.content), 0),
    'sender_id', NEW.user_id,
    'user_id', NEW.user_id,
    'creator', COALESCE(v_creator_name, ''),
    'creator_email', COALESCE(v_creator_email, ''),
    'link', '/channels',
    'created_at', NEW.created_at
  );

  PERFORM public.evaluate_automation_rules(v_workspace_id, 'message.posted', NEW.id, v_ctx);
  PERFORM public.evaluate_automation_rules(v_workspace_id, 'message.mentioned', NEW.id, v_ctx);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_message_events ON messages;
CREATE TRIGGER trg_automation_message_events
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_message_events();

-- tasks -> task.created / task.status_changed / task.completed
CREATE OR REPLACE FUNCTION public.fn_automation_task_events()
RETURNS TRIGGER AS $$
DECLARE
  v_creator_name TEXT;
  v_creator_email TEXT;
  v_assignee_names TEXT;
  v_assignee_emails TEXT;
  v_assignee_first TEXT;
  v_project_name TEXT;
  v_channel_name TEXT;
  v_message_content TEXT;
  v_ctx JSONB;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), p.email
    INTO v_creator_name, v_creator_email
  FROM profiles p WHERE p.id = NEW.created_by;

  SELECT string_agg(COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), ', '),
         string_agg(p.email, ', ')
    INTO v_assignee_names, v_assignee_emails
  FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
  WHERE ta.task_id = NEW.id;

  SELECT p.email INTO v_assignee_first
  FROM task_assignees ta JOIN profiles p ON p.id = ta.user_id
  WHERE ta.task_id = NEW.id LIMIT 1;

  SELECT name INTO v_project_name FROM projects WHERE id = NEW.project_id;
  SELECT name INTO v_channel_name FROM channels WHERE id = NEW.channel_id;
  SELECT content INTO v_message_content FROM messages WHERE id = NEW.message_id;

  v_ctx := jsonb_build_object(
    'entity_id', NEW.id,
    'entity_type', 'task',
    'title', COALESCE(NEW.title, ''),
    'description', COALESCE(NEW.description, ''),
    'status', NEW.status,
    'priority', NEW.priority,
    'project_id', COALESCE(NEW.project_id::TEXT, ''),
    'project_name', COALESCE(v_project_name, ''),
    'channel_id', COALESCE(NEW.channel_id::TEXT, ''),
    'channel_name', COALESCE(v_channel_name, ''),
    'created_by', NEW.created_by,
    'user_id', NEW.created_by,
    'creator', COALESCE(v_creator_name, ''),
    'creator_email', COALESCE(v_creator_email, ''),
    'assignee', COALESCE(v_assignee_first, ''),
    'assignee_names', COALESCE(v_assignee_names, ''),
    'assignee_emails', COALESCE(v_assignee_emails, ''),
    'due_date', COALESCE(NEW.due_date::TEXT, ''),
    'is_overdue', CASE WHEN NEW.due_date IS NOT NULL AND NEW.due_date < now() THEN 'true' ELSE 'false' END,
    'has_due_date', CASE WHEN NEW.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
    'message_content', COALESCE(v_message_content, ''),
    'created_at', NEW.created_at,
    'updated_at', NEW.updated_at,
    'link', '/tasks'
  );

  IF TG_OP = 'INSERT' THEN
    PERFORM public.evaluate_automation_rules(NEW.workspace_id, 'task.created', NEW.id, v_ctx);
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.evaluate_automation_rules(NEW.workspace_id, 'task.status_changed', NEW.id, v_ctx || jsonb_build_object('old_status', OLD.status));
    IF NEW.status = 'completed' THEN
      PERFORM public.evaluate_automation_rules(NEW.workspace_id, 'task.completed', NEW.id, v_ctx || jsonb_build_object('old_status', OLD.status));
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_task_events ON tasks;
CREATE TRIGGER trg_automation_task_events
  AFTER INSERT OR UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_task_events();

-- task_assignees -> task.assigned
CREATE OR REPLACE FUNCTION public.fn_automation_task_assigned()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_task RECORD;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT workspace_id, project_id, created_by, title, status, priority, due_date
    INTO v_workspace_id, v_task.project_id, v_task.created_by, v_task.title, v_task.status, v_task.priority, v_task.due_date
  FROM tasks WHERE id = NEW.task_id;
  IF v_workspace_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public.evaluate_automation_rules(
    v_workspace_id, 'task.assigned', NEW.task_id,
    jsonb_build_object(
      'entity_id', NEW.task_id,
      'entity_type', 'task',
      'assignee_id', NEW.user_id,
      'title', COALESCE(v_task.title, ''),
      'status', COALESCE(v_task.status, ''),
      'priority', COALESCE(v_task.priority, ''),
      'project_id', COALESCE(v_task.project_id::TEXT, ''),
      'created_by', v_task.created_by,
      'user_id', v_task.created_by,
      'due_date', COALESCE(v_task.due_date::TEXT, ''),
      'is_overdue', CASE WHEN v_task.due_date IS NOT NULL AND v_task.due_date < now() THEN 'true' ELSE 'false' END,
      'has_due_date', CASE WHEN v_task.due_date IS NOT NULL THEN 'true' ELSE 'false' END,
      'link', '/tasks'
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_task_assigned ON task_assignees;
CREATE TRIGGER trg_automation_task_assigned
  AFTER INSERT ON task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_task_assigned();

-- projects -> project.created / project.archived
CREATE OR REPLACE FUNCTION public.fn_automation_project_events()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_name TEXT;
  v_owner_email TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), p.email
    INTO v_owner_name, v_owner_email
  FROM profiles p WHERE p.id = NEW.owner_id;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.evaluate_automation_rules(
      NEW.workspace_id, 'project.created', NEW.id,
      jsonb_build_object(
        'entity_id', NEW.id,
        'entity_type', 'project',
        'project_name', NEW.name,
        'name', NEW.name,
        'description', COALESCE(NEW.description, ''),
        'created_by', NEW.owner_id,
        'user_id', NEW.owner_id,
        'creator', COALESCE(v_owner_name, ''),
        'creator_email', COALESCE(v_owner_email, ''),
        'created_at', NEW.created_at,
        'link', '/projects'
      )
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'archived' THEN
    PERFORM public.evaluate_automation_rules(
      NEW.workspace_id, 'project.archived', NEW.id,
      jsonb_build_object(
        'entity_id', NEW.id,
        'entity_type', 'project',
        'project_name', NEW.name,
        'name', NEW.name,
        'status', NEW.status,
        'old_status', OLD.status,
        'updated_at', NEW.updated_at,
        'link', '/projects'
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_project_events ON projects;
CREATE TRIGGER trg_automation_project_events
  AFTER INSERT OR UPDATE OF status ON projects
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_project_events();

-- workspace_members -> member.joined / member.left
CREATE OR REPLACE FUNCTION public.fn_automation_member_events()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_user_id UUID;
  v_name TEXT;
  v_email TEXT;
  v_created_at TIMESTAMPTZ;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_workspace_id := NEW.workspace_id;
    v_user_id := NEW.user_id;
    v_created_at := NEW.created_at;
  ELSE
    v_workspace_id := OLD.workspace_id;
    v_user_id := OLD.user_id;
    v_created_at := now();
  END IF;

  SELECT COALESCE(p.display_name, p.username, split_part(p.email, '@', 1)), p.email
    INTO v_name, v_email
  FROM profiles p WHERE p.id = v_user_id;

  PERFORM public.evaluate_automation_rules(
    v_workspace_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'member.joined' ELSE 'member.left' END,
    v_user_id,
    jsonb_build_object(
      'entity_id', v_user_id,
      'entity_type', 'member',
      'user_id', v_user_id,
      'member_name', COALESCE(v_name, ''),
      'member_email', COALESCE(v_email, ''),
      'created_at', v_created_at,
      'link', '/workspace/settings'
    )
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_member_events ON workspace_members;
CREATE TRIGGER trg_automation_member_events
  AFTER INSERT OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_member_events();

-- calendar_events -> calendar.event_created
CREATE OR REPLACE FUNCTION public.fn_automation_calendar_events()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.evaluate_automation_rules(
      NEW.workspace_id, 'calendar.event_created', NEW.id,
      jsonb_build_object(
        'entity_id', NEW.id,
        'entity_type', 'event',
        'event_title', NEW.title,
        'title', NEW.title,
        'description', COALESCE(NEW.description, ''),
        'start_at', NEW.start_at,
        'end_at', NEW.end_at,
        'created_by', NEW.user_id,
        'user_id', NEW.user_id,
        'created_at', NEW.created_at,
        'updated_at', NEW.updated_at,
        'link', '/calendar'
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_calendar_events ON calendar_events;
CREATE TRIGGER trg_automation_calendar_events
  AFTER INSERT ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_calendar_events();

-- reactions -> message.reaction_added
CREATE OR REPLACE FUNCTION public.fn_automation_reaction_events()
RETURNS TRIGGER AS $$
DECLARE
  v_workspace_id UUID;
  v_channel_id UUID;
  v_channel_name TEXT;
  v_msg_content TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  SELECT m.workspace_id, m.channel_id, m.content
    INTO v_workspace_id, v_channel_id, v_msg_content
  FROM messages m WHERE m.id = NEW.message_id;
  IF v_workspace_id IS NULL THEN RETURN NEW; END IF;

  SELECT name INTO v_channel_name FROM channels WHERE id = v_channel_id;

  PERFORM public.evaluate_automation_rules(
    v_workspace_id, 'message.reaction_added', NEW.message_id,
    jsonb_build_object(
      'entity_id', NEW.message_id,
      'entity_type', 'message',
      'emoji', NEW.emoji,
      'channel_id', COALESCE(v_channel_id::TEXT, ''),
      'channel_name', COALESCE(v_channel_name, ''),
      'sender_id', NEW.user_id,
      'user_id', NEW.user_id,
      'message_content', COALESCE(v_msg_content, ''),
      'created_at', NEW.created_at,
      'link', '/channels'
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_automation_reaction_events ON reactions;
CREATE TRIGGER trg_automation_reaction_events
  AFTER INSERT ON reactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_automation_reaction_events();

-- ---------------------------------------------------------------------------
-- 6) TIME-BASED TRIGGERS via pg_cron
--    calendar.event_reminder : fires once ~15 min before an event starts.
--    calendar.event_started   : fires once when an event is in progress.
--    Dedup table guarantees exactly-once even when nobody is online.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_calendar_event_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev RECORD;
BEGIN
  FOR v_ev IN
    SELECT e.id, e.workspace_id, e.title, e.start_at, e.end_at
    FROM calendar_events e
    WHERE e.deleted_at IS NULL
      AND e.start_at > now()
      AND e.start_at <= now() + INTERVAL '15 minutes'
      AND EXISTS (
        SELECT 1 FROM automation_triggers t
        JOIN automation_rules ar ON ar.id = t.rule_id
        WHERE ar.workspace_id = e.workspace_id AND ar.enabled = true
          AND t.event_type = 'calendar.event_reminder'
      )
  LOOP
    BEGIN
      INSERT INTO public.automation_event_fired (event_type, entity_id, workspace_id)
      VALUES ('calendar.event_reminder', v_ev.id, v_ev.workspace_id)
      ON CONFLICT (event_type, entity_id) DO NOTHING;
      IF FOUND THEN
        PERFORM public.evaluate_automation_rules(
          v_ev.workspace_id, 'calendar.event_reminder', v_ev.id,
          jsonb_build_object(
            'entity_id', v_ev.id,
            'entity_type', 'event',
            'event_title', v_ev.title,
            'title', v_ev.title,
            'start_at', v_ev.start_at,
            'end_at', v_ev.end_at,
            'link', '/calendar'
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event_reminder failed event=% err=%', v_ev.id, SQLERRM;
    END;
  END LOOP;
  RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fire_calendar_event_started()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev RECORD;
BEGIN
  FOR v_ev IN
    SELECT e.id, e.workspace_id, e.title, e.start_at, e.end_at
    FROM calendar_events e
    WHERE e.deleted_at IS NULL
      AND e.start_at <= now()
      AND e.end_at > now()
      AND EXISTS (
        SELECT 1 FROM automation_triggers t
        JOIN automation_rules ar ON ar.id = t.rule_id
        WHERE ar.workspace_id = e.workspace_id AND ar.enabled = true
          AND t.event_type = 'calendar.event_started'
      )
  LOOP
    BEGIN
      INSERT INTO public.automation_event_fired (event_type, entity_id, workspace_id)
      VALUES ('calendar.event_started', v_ev.id, v_ev.workspace_id)
      ON CONFLICT (event_type, entity_id) DO NOTHING;
      IF FOUND THEN
        PERFORM public.evaluate_automation_rules(
          v_ev.workspace_id, 'calendar.event_started', v_ev.id,
          jsonb_build_object(
            'entity_id', v_ev.id,
            'entity_type', 'event',
            'event_title', v_ev.title,
            'title', v_ev.title,
            'start_at', v_ev.start_at,
            'end_at', v_ev.end_at,
            'link', '/calendar'
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event_started failed event=% err=%', v_ev.id, SQLERRM;
    END;
  END LOOP;
  RETURN 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7) Ensure the offline delivery crons for reminders + scheduled messages
--    exist (self-contained; re-creates the worker functions idempotently).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_due_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rem RECORD;
  recipient uuid;
  delivered_count integer := 0;
BEGIN
  FOR rem IN
    SELECT id, user_id, title, message, recipients
    FROM reminders
    WHERE remind_at <= now()
      AND notified = false
      AND dismissed = false
    ORDER BY remind_at ASC
    LIMIT 500
  LOOP
    UPDATE reminders SET notified = true WHERE id = rem.id AND notified = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF rem.recipients IS NOT NULL AND cardinality(rem.recipients) > 0 THEN
      FOR recipient IN SELECT unnest(rem.recipients) LOOP
        INSERT INTO notifications (user_id, type, title, message, link, category, entity_type)
        VALUES (recipient, 'reminder', rem.title, COALESCE(rem.message, 'Reminder'), '/calendar', 'calendar', 'event');
        delivered_count := delivered_count + 1;
      END LOOP;
    ELSE
      INSERT INTO notifications (user_id, type, title, message, link, category, entity_type)
      VALUES (rem.user_id, 'reminder', rem.title, COALESCE(rem.message, 'Reminder'), '/calendar', 'calendar', 'event');
      delivered_count := delivered_count + 1;
    END IF;
  END LOOP;
  RETURN delivered_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_due_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg RECORD;
  target_channel_id uuid;
  inserted_message_id uuid;
  att RECORD;
  sent_count integer := 0;
BEGIN
  FOR msg IN
    SELECT * FROM scheduled_messages
    WHERE sent = false
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
  LOOP
    UPDATE scheduled_messages SET sent = true WHERE id = msg.id AND sent = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    target_channel_id := msg.channel_id;
    IF target_channel_id IS NULL AND msg.conversation_id IS NOT NULL THEN
      SELECT channel_id INTO target_channel_id
      FROM direct_conversations WHERE id = msg.conversation_id;
    END IF;
    IF target_channel_id IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO messages (channel_id, user_id, content, parent_id, link_mode)
      VALUES (target_channel_id, msg.user_id, msg.content, msg.parent_id, msg.link_mode)
      RETURNING id INTO inserted_message_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE scheduled_messages SET sent = false WHERE id = msg.id;
      CONTINUE;
    END;

    FOR att IN
      SELECT * FROM scheduled_message_attachments WHERE scheduled_message_id = msg.id
    LOOP
      BEGIN
        INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
        VALUES (inserted_message_id, att.user_id, att.file_name, att.file_size, att.file_type, att.file_url);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;

    DELETE FROM scheduled_message_attachments WHERE scheduled_message_id = msg.id;
    sent_count := sent_count + 1;
  END LOOP;
  RETURN sent_count;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-due-scheduled-messages') THEN
    PERFORM cron.schedule('send-due-scheduled-messages', '* * * * *', 'SELECT public.send_due_scheduled_messages();');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-due-reminders') THEN
    PERFORM cron.schedule('send-due-reminders', '* * * * *', 'SELECT public.send_due_reminders();');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'automation-calendar-reminders') THEN
    PERFORM cron.schedule('automation-calendar-reminders', '* * * * *', 'SELECT public.fire_calendar_event_reminders();');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'automation-calendar-started') THEN
    PERFORM cron.schedule('automation-calendar-started', '* * * * *', 'SELECT public.fire_calendar_event_started();');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8) Permissions + PostgREST cache reload
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.evaluate_automation_rules(UUID, TEXT, UUID, JSONB) TO postgres;
GRANT EXECUTE ON FUNCTION public.evaluate_automation_rules(UUID, TEXT, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.fire_calendar_event_reminders() TO postgres;
GRANT EXECUTE ON FUNCTION public.fire_calendar_event_started() TO postgres;
GRANT EXECUTE ON FUNCTION public.send_due_reminders() TO postgres;
GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO postgres;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFICATION: run these after the migration to confirm the engine is live.
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('evaluate_automation_rules','automation_execute_action','fire_calendar_event_reminders','fire_calendar_event_started');
--   SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_automation_%';
-- ---------------------------------------------------------------------------

-- ==================== 051_project_visibility_realtime_and_notifications.sql ====================
-- ============================================================================
-- 051_project_visibility_realtime_and_notifications.sql
-- ----------------------------------------------------------------------------
-- User-requested changes:
--   1. Project visibility: only project members (any role incl. viewer),
--      project owners, or workspace admins/owners may SEE a project.
--      ('workspace' visibility no longer grants read access to non-members.)
--   2. Realtime publication for project_members + project_resources +
--      project_resource_comments so membership / role changes and resource
--      comments update live in the client.
--   3. When an email invite is accepted, notify the inviter and the
--      workspace owner(s).
--   4. Events: send a default reminder notification ~15 min before an event
--      and an "event started" notification once the event begins, for the
--      creator + participants (independent of automation rules).
--
-- All statements are idempotent. Run after 050_server_side_automation_engine.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) STRICT PROJECT VISIBILITY
--    Owner, any project member (owner/admin/member/viewer), or a workspace
--    owner/admin can read a project. Everyone else (incl. non-member
--    workspace users) is blocked by RLS.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "projects_select" ON public.projects;

CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (
    -- Project owner always sees their own projects
    auth.uid() = owner_id
    OR
    -- Any project member (any role, including viewer) can see the project
    is_project_member(id, auth.uid())
    OR
    -- Workspace owner/admins can always see all projects
    is_workspace_admin(workspace_id)
  );

-- ----------------------------------------------------------------------------
-- 2) REALTIME PUBLICATION
-- ----------------------------------------------------------------------------
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.project_members; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.project_resources; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.project_resource_comments; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Safety net: ensure the internal automation dedup table stays locked down even
-- if 050 was applied before RLS was enabled on it.
ALTER TABLE public.automation_event_fired ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_event_fired FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3) OWNER NOTIFICATION ON INVITE ACCEPTANCE
--    Notifies the inviter (invitations.invited_by) and every workspace owner
--    (workspace_members.role = 'owner') once an email invite is accepted.
--    Implemented as a decoupled trigger on invitations so the
--    accept_workspace_invitation function stays EXACTLY as written in 019.
--    Best-effort: failures are logged as WARNINGs, never block the invite.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_notify_owner_on_invite_accepted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recipient UUID;
  v_recipients UUID[] := ARRAY[]::uuid[];
  v_workspace_name TEXT;
  v_member_name TEXT;
BEGIN
  BEGIN
    IF NEW.status <> 'accepted' OR OLD.status <> 'pending' OR NEW.user_id IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.invited_by IS NOT NULL AND NEW.invited_by <> NEW.user_id THEN
      v_recipients := array_append(v_recipients, NEW.invited_by);
    END IF;

    FOR v_recipient IN
      SELECT user_id FROM public.workspace_members
      WHERE workspace_id = NEW.workspace_id AND role = 'owner'
        AND user_id IS DISTINCT FROM NEW.user_id
    LOOP
      IF NOT v_recipient = ANY(v_recipients) THEN
        v_recipients := array_append(v_recipients, v_recipient);
      END IF;
    END LOOP;

    IF cardinality(v_recipients) > 0 THEN
      SELECT name INTO v_workspace_name FROM public.workspaces WHERE id = NEW.workspace_id;
      SELECT COALESCE(display_name, username, 'a member') INTO v_member_name
      FROM public.profiles WHERE id = NEW.user_id;

      INSERT INTO public.notifications
        (user_id, type, title, message, link, category, entity_type, entity_id, actor_id, workspace_id)
      SELECT recipient,
             'invitation',
             'Invite accepted',
             'Your invite to join ' || COALESCE(v_workspace_name, 'the workspace')
               || ' was accepted by ' || COALESCE(v_member_name, 'a member') || '.',
             '/workspace/settings',
             'workspace',
             'invitation',
             NULL,
             NEW.user_id,
             NEW.workspace_id
      FROM unnest(v_recipients) AS recipient;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'invite accepted owner-notification failed invitation=% err=%', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_owner_on_invite_accepted ON public.invitations;
CREATE TRIGGER trg_notify_owner_on_invite_accepted
  AFTER UPDATE OF status ON public.invitations
  FOR EACH ROW
  WHEN (NEW.status = 'accepted')
  EXECUTE FUNCTION public.fn_notify_owner_on_invite_accepted();

-- ----------------------------------------------------------------------------
-- 4) DEFAULT EVENT REMINDER + EVENT STARTED NOTIFICATIONS
--    These run on the existing cron (automation-calendar-reminders and
--    automation-calendar-started) and notify the event creator + participants
--    even when no automation rule exists.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_calendar_event_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev RECORD;
  v_has_rule BOOLEAN;
BEGIN
  FOR v_ev IN
    SELECT e.id, e.workspace_id, e.user_id, e.title, e.start_at, e.end_at
    FROM calendar_events e
    WHERE e.deleted_at IS NULL
      AND e.start_at > now()
      AND e.start_at <= now() + INTERVAL '15 minutes'
  LOOP
    BEGIN
      INSERT INTO public.automation_event_fired (event_type, entity_id, workspace_id)
      VALUES ('calendar.event_reminder', v_ev.id, v_ev.workspace_id)
      ON CONFLICT (event_type, entity_id) DO NOTHING;
      IF FOUND THEN
        -- Default reminder for the creator + participants
        INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
        SELECT DISTINCT recipient,
               'event_reminder',
               'Event reminder',
               v_ev.title || ' starts at ' || to_char(v_ev.start_at AT TIME ZONE 'UTC', 'HH24:MI'),
               '/calendar',
               'calendar',
               'event',
               v_ev.id,
               v_ev.workspace_id
        FROM (
          SELECT v_ev.user_id AS recipient
          UNION
          SELECT user_id FROM event_participants WHERE event_id = v_ev.id
        ) recipients
        WHERE recipient IS NOT NULL;

        -- Still fire automation rules if any exist for this trigger
        SELECT EXISTS (
          SELECT 1 FROM automation_triggers t
          JOIN automation_rules ar ON ar.id = t.rule_id
          WHERE ar.workspace_id = v_ev.workspace_id AND ar.enabled = true
            AND t.event_type = 'calendar.event_reminder'
        ) INTO v_has_rule;

        IF v_has_rule THEN
          PERFORM public.evaluate_automation_rules(
            v_ev.workspace_id, 'calendar.event_reminder', v_ev.id,
            jsonb_build_object(
              'entity_id', v_ev.id,
              'entity_type', 'event',
              'event_title', v_ev.title,
              'title', v_ev.title,
              'start_at', v_ev.start_at,
              'end_at', v_ev.end_at,
              'link', '/calendar'
            )
          );
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event_reminder failed event=% err=%', v_ev.id, SQLERRM;
    END;
  END LOOP;
  RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fire_calendar_event_started()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev RECORD;
  v_has_rule BOOLEAN;
BEGIN
  FOR v_ev IN
    SELECT e.id, e.workspace_id, e.user_id, e.title, e.start_at, e.end_at
    FROM calendar_events e
    WHERE e.deleted_at IS NULL
      AND e.start_at <= now()
      AND e.end_at > now()
  LOOP
    BEGIN
      INSERT INTO public.automation_event_fired (event_type, entity_id, workspace_id)
      VALUES ('calendar.event_started', v_ev.id, v_ev.workspace_id)
      ON CONFLICT (event_type, entity_id) DO NOTHING;
      IF FOUND THEN
        -- Default "event started" notification for the creator + participants
        INSERT INTO notifications (user_id, type, title, message, link, category, entity_type, entity_id, workspace_id)
        SELECT DISTINCT recipient,
               'event_started',
               'Event started',
               v_ev.title || ' has started.',
               '/calendar',
               'calendar',
               'event',
               v_ev.id,
               v_ev.workspace_id
        FROM (
          SELECT v_ev.user_id AS recipient
          UNION
          SELECT user_id FROM event_participants WHERE event_id = v_ev.id
        ) recipients
        WHERE recipient IS NOT NULL;

        -- Still fire automation rules if any exist for this trigger
        SELECT EXISTS (
          SELECT 1 FROM automation_triggers t
          JOIN automation_rules ar ON ar.id = t.rule_id
          WHERE ar.workspace_id = v_ev.workspace_id AND ar.enabled = true
            AND t.event_type = 'calendar.event_started'
        ) INTO v_has_rule;

        IF v_has_rule THEN
          PERFORM public.evaluate_automation_rules(
            v_ev.workspace_id, 'calendar.event_started', v_ev.id,
            jsonb_build_object(
              'entity_id', v_ev.id,
              'entity_type', 'event',
              'event_title', v_ev.title,
              'title', v_ev.title,
              'start_at', v_ev.start_at,
              'end_at', v_ev.end_at,
              'link', '/calendar'
            )
          );
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event_started failed event=% err=%', v_ev.id, SQLERRM;
    END;
  END LOOP;
  RETURN 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fire_calendar_event_reminders() TO postgres;
GRANT EXECUTE ON FUNCTION public.fire_calendar_event_started() TO postgres;

-- ==================== 052_project_workspace_visibility.sql ====================
-- Workspace-visibility projects: every workspace member is a viewer.
-- Effective read access: project owner, project member (any role), workspace
-- admin, OR workspace member of a 'workspace'-visible project.
CREATE OR REPLACE FUNCTION public.is_project_readable(p_project_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND (
        p.owner_id = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = p.id AND pm.user_id = p_user_id
        )
        OR (p.visibility = 'workspace' AND public.user_is_workspace_member(p.workspace_id, p_user_id))
        OR public.user_is_workspace_admin(p.workspace_id, p_user_id)
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.is_project_readable(UUID, UUID) TO authenticated;

-- projects_select: workspace members can read 'workspace'-visible projects.
-- 051 narrowed projects_select to owner + project members + workspace admins
-- (workspace visibility "no longer grants read access to non-members"), which
-- silently undid the "every workspace member is a viewer" behaviour: implicit
-- viewers showed up in the members list but RLS returned no row for the
-- project, so they could not see it at all. Restore read access for workspace
-- members when the project is 'workspace'-visible.
DROP POLICY IF EXISTS "projects_select" ON public.projects;
CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (
    auth.uid() = owner_id
    OR is_project_member(id, auth.uid())
    OR is_workspace_admin(workspace_id)
    OR (visibility = 'workspace' AND is_workspace_member(workspace_id))
  );

-- tasks_select: workspace members can read tasks in 'workspace' projects
DROP POLICY IF EXISTS "tasks_select" ON public.tasks;
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT USING (
    auth.uid() = created_by
    OR is_task_assignee(id, auth.uid())
    OR (project_id IS NOT NULL AND is_project_readable(project_id))
    OR is_workspace_admin(workspace_id)
  );

-- Count: for 'workspace' projects, every workspace member counts as a viewer.
CREATE OR REPLACE FUNCTION public.get_project_member_count(p_project_id UUID) RETURNS BIGINT AS $$
DECLARE
  v_visibility TEXT;
  v_workspace_id UUID;
BEGIN
  SELECT visibility, workspace_id INTO v_visibility, v_workspace_id
  FROM projects WHERE id = p_project_id;

  IF v_visibility = 'workspace' THEN
    RETURN (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = v_workspace_id);
  END IF;

  RETURN (SELECT COUNT(*) FROM project_members WHERE project_id = p_project_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Members: explicit project members + implicit viewers (workspace members of a
-- 'workspace'-visible project, excluding the owner and existing members).
DROP FUNCTION IF EXISTS public.get_project_members(UUID);
CREATE OR REPLACE FUNCTION public.get_project_members(p_project_id UUID)
RETURNS TABLE(id UUID, user_id UUID, role TEXT, created_at TIMESTAMPTZ, display_name TEXT, avatar_url TEXT, email TEXT, is_implicit BOOLEAN) AS $$
BEGIN RETURN QUERY
  SELECT pm.id, pm.user_id, pm.role, pm.created_at, p.display_name, p.avatar_url, p.email, FALSE::BOOLEAN AS is_implicit
  FROM project_members pm
  LEFT JOIN profiles p ON p.id = pm.user_id
  WHERE pm.project_id = p_project_id
  UNION ALL
  SELECT wm.id, wm.user_id, 'viewer'::TEXT, wm.created_at, p.display_name, p.avatar_url, p.email, TRUE::BOOLEAN AS is_implicit
  FROM workspace_members wm
  JOIN projects pr ON pr.id = p_project_id AND pr.visibility = 'workspace' AND wm.workspace_id = pr.workspace_id AND wm.user_id <> pr.owner_id
  LEFT JOIN profiles p ON p.id = wm.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_members pm2 WHERE pm2.project_id = pr.id AND pm2.user_id = wm.user_id
  )
  ORDER BY is_implicit, created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_project_member_count(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_members(UUID) TO authenticated;


-- ==================== 053_message_link_mode.sql ====================
-- 053_message_link_mode.sql
-- Persist how a message displays embedded links: 'text', 'embed', or 'grid'.
-- NULL (legacy messages) is treated as 'embed' by the client.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_mode TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_link_mode_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_link_mode_check
  CHECK (link_mode IS NULL OR link_mode IN ('text', 'embed', 'grid'));

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS link_mode TEXT;

-- Carry the sender's chosen mode from a scheduled message into the delivered
-- message so the renderer shows it the same way.
CREATE OR REPLACE FUNCTION public.send_due_scheduled_messages()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  msg RECORD;
  target_channel_id uuid;
  inserted_message_id uuid;
  att RECORD;
  sent_count integer := 0;
BEGIN
  FOR msg IN
    SELECT * FROM scheduled_messages
    WHERE sent = false
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
  LOOP
    UPDATE scheduled_messages SET sent = true WHERE id = msg.id AND sent = false;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    target_channel_id := msg.channel_id;
    IF target_channel_id IS NULL AND msg.conversation_id IS NOT NULL THEN
      SELECT channel_id INTO target_channel_id
      FROM direct_conversations
      WHERE id = msg.conversation_id;
    END IF;

    IF target_channel_id IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO messages (channel_id, user_id, content, parent_id, link_mode)
      VALUES (target_channel_id, msg.user_id, msg.content, msg.parent_id, msg.link_mode)
      RETURNING id INTO inserted_message_id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE scheduled_messages SET sent = false WHERE id = msg.id;
      CONTINUE;
    END;

    FOR att IN
      SELECT * FROM scheduled_message_attachments
      WHERE scheduled_message_id = msg.id
    LOOP
      BEGIN
        INSERT INTO file_attachments (message_id, user_id, file_name, file_size, file_type, file_url)
        VALUES (inserted_message_id, att.user_id, att.file_name, att.file_size, att.file_type, att.file_url);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;

    DELETE FROM scheduled_message_attachments WHERE scheduled_message_id = msg.id;
    sent_count := sent_count + 1;
  END LOOP;

  RETURN sent_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO postgres;
GRANT EXECUTE ON FUNCTION public.send_due_scheduled_messages() TO service_role;




-- ==================== 054_workspace_theme.sql ====================
-- ============================================================
-- WORKSPACE THEME SETTINGS
-- Owner/manager-set typography + colors that reflect on all
-- members. Members can toggle "override owner" so owner
-- changes don't affect them.
-- ============================================================

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS typography JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS colors JSONB DEFAULT NULL;

-- Broadcast theme changes so members pick them up in real time
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_settings;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Update get_workspace_settings to return theme fields
CREATE OR REPLACE FUNCTION public.get_workspace_settings(p_workspace_id UUID) RETURNS JSON AS $$
DECLARE v_row workspace_settings%ROWTYPE;
BEGIN
  IF NOT is_workspace_member(p_workspace_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  SELECT * INTO v_row FROM workspace_settings WHERE workspace_id = p_workspace_id;
  IF v_row.workspace_id IS NULL THEN
    RETURN json_build_object(
      'workspace_id', p_workspace_id,
      'default_channel_ids', '{}'::json,
      'retention_days', 0,
      'quiet_hours_start', NULL::text,
      'quiet_hours_end', NULL::text,
      'typography', NULL::jsonb,
      'colors', NULL::jsonb
    );
  END IF;

  RETURN json_build_object(
    'workspace_id', v_row.workspace_id,
    'default_channel_ids', v_row.default_channel_ids,
    'retention_days', v_row.retention_days,
    'quiet_hours_start', v_row.quiet_hours_start,
    'quiet_hours_end', v_row.quiet_hours_end,
    'typography', v_row.typography,
    'colors', v_row.colors
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update upsert to accept theme fields (admin only)
-- null = leave unchanged; p_clear_typography/p_clear_colors = set to null
CREATE OR REPLACE FUNCTION public.upsert_workspace_settings(
  p_workspace_id UUID,
  p_default_channel_ids UUID[] DEFAULT NULL,
  p_retention_days INTEGER DEFAULT NULL,
  p_quiet_hours_start TEXT DEFAULT NULL,
  p_quiet_hours_end TEXT DEFAULT NULL,
  p_typography JSONB DEFAULT NULL,
  p_colors JSONB DEFAULT NULL,
  p_clear_typography BOOLEAN DEFAULT false,
  p_clear_colors BOOLEAN DEFAULT false
) RETURNS JSON AS $$
BEGIN
  IF NOT is_workspace_admin(p_workspace_id) THEN
    RETURN json_build_object('success', false, 'error', 'No permission.');
  END IF;

  INSERT INTO workspace_settings (workspace_id, default_channel_ids, retention_days, quiet_hours_start, quiet_hours_end, typography, colors, updated_by)
  VALUES (p_workspace_id, COALESCE(p_default_channel_ids, '{}'), COALESCE(p_retention_days, 0), p_quiet_hours_start, p_quiet_hours_end,
          CASE WHEN p_clear_typography THEN NULL ELSE p_typography END,
          CASE WHEN p_clear_colors THEN NULL ELSE p_colors END,
          auth.uid())
  ON CONFLICT (workspace_id) DO UPDATE SET
    default_channel_ids = COALESCE(EXCLUDED.default_channel_ids, workspace_settings.default_channel_ids),
    retention_days = COALESCE(EXCLUDED.retention_days, workspace_settings.retention_days),
    quiet_hours_start = COALESCE(EXCLUDED.quiet_hours_start, workspace_settings.quiet_hours_start),
    quiet_hours_end = COALESCE(EXCLUDED.quiet_hours_end, workspace_settings.quiet_hours_end),
    typography = CASE WHEN p_clear_typography THEN NULL ELSE COALESCE(p_typography, workspace_settings.typography) END,
    colors = CASE WHEN p_clear_colors THEN NULL ELSE COALESCE(p_colors, workspace_settings.colors) END,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  RETURN json_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          username: string | null;
          avatar_url: string | null;
          bio: string | null;
          role: string;
          status: string;
          onboarding_completed: boolean;
          timezone: string | null;
          forwarded_attachment_policy: string;
          last_active_at: string;
          presence_status: string;
          manual_status: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string;
          display_name?: string | null;
          username?: string | null;
          avatar_url?: string | null;
          bio?: string | null;
          role?: string;
          status?: string;
          onboarding_completed?: boolean;
          timezone?: string | null;
          forwarded_attachment_policy?: string;
          last_active_at?: string;
          presence_status?: string;
          manual_status?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          display_name?: string | null;
          username?: string | null;
          avatar_url?: string | null;
          bio?: string | null;
          role?: string;
          status?: string;
          onboarding_completed?: boolean;
          timezone?: string | null;
          forwarded_attachment_policy?: string;
          last_active_at?: string;
          presence_status?: string;
          manual_status?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          avatar_url: string | null;
          owner_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          description?: string | null;
          avatar_url?: string | null;
          owner_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          description?: string | null;
          avatar_url?: string | null;
          owner_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_members: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          role: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          user_id: string;
          role?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          user_id?: string;
          role?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      invitations: {
        Row: {
          id: string;
          workspace_id: string;
          invited_by: string;
          email: string;
          user_id: string | null;
          role: string;
          status: string;
          token: string;
          expires_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          invited_by: string;
          email: string;
          user_id?: string | null;
          role?: string;
          status?: string;
          token?: string;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          invited_by?: string;
          email?: string;
          user_id?: string | null;
          role?: string;
          status?: string;
          token?: string;
          expires_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invitations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invitations_invited_by_fkey";
            columns: ["invited_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invitations_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          slug: string;
          description: string | null;
          topic: string | null;
          type: string;
          is_private: boolean;
          created_by: string | null;
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          slug: string;
          description?: string | null;
          topic?: string | null;
          type?: string;
          is_private?: boolean;
          created_by?: string | null;
          archived_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          slug?: string;
          description?: string | null;
          topic?: string | null;
          type?: string;
          is_private?: boolean;
          created_by?: string | null;
          archived_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channels_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channels_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_members: {
        Row: {
          id: string;
          channel_id: string;
          user_id: string;
          role: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          channel_id: string;
          user_id: string;
          role?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          channel_id?: string;
          user_id?: string;
          role?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_members_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channel_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          channel_id: string;
          user_id: string;
          content: string;
          edited_at: string | null;
          deleted_at: string | null;
          parent_id: string | null;
          forwarded_from_message_id: string | null;
          created_at: string;
          attachments_layout: string | null;
          link_mode: string | null;
        };
        Insert: {
          id?: string;
          channel_id: string;
          user_id: string;
          content: string;
          edited_at?: string | null;
          deleted_at?: string | null;
          parent_id?: string | null;
          forwarded_from_message_id?: string | null;
          created_at?: string;
          attachments_layout?: string | null;
          link_mode?: string | null;
        };
        Update: {
          id?: string;
          channel_id?: string;
          user_id?: string;
          content?: string;
          edited_at?: string | null;
          deleted_at?: string | null;
          parent_id?: string | null;
          forwarded_from_message_id?: string | null;
          created_at?: string;
          attachments_layout?: string | null;
          link_mode?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      pinned_messages: {
        Row: {
          id: string;
          channel_id: string;
          message_id: string;
          pinned_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          channel_id: string;
          message_id: string;
          pinned_by: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          channel_id?: string;
          message_id?: string;
          pinned_by?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pinned_messages_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pinned_messages_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pinned_messages_pinned_by_fkey";
            columns: ["pinned_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      saved_messages: {
        Row: {
          id: string;
          user_id: string;
          message_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          message_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          message_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "saved_messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_messages_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      reactions: {
        Row: {
          id: string;
          message_id: string;
          user_id: string;
          emoji: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          message_id: string;
          user_id: string;
          emoji: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          message_id?: string;
          user_id?: string;
          emoji?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reactions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      file_attachments: {
        Row: {
          id: string;
          message_id: string;
          user_id: string;
          file_name: string;
          file_size: number;
          file_type: string;
          file_url: string;
          created_at: string;
          sort_order: number;
          workspace_id: string | null;
        };
        Insert: {
          id?: string;
          message_id: string;
          user_id: string;
          file_name: string;
          file_size: number;
          file_type: string;
          file_url: string;
          created_at?: string;
          sort_order?: number;
          workspace_id?: string | null;
        };
        Update: {
          id?: string;
          message_id?: string;
          user_id?: string;
          file_name?: string;
          file_size?: number;
          file_type?: string;
          file_url?: string;
          created_at?: string;
          sort_order?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "file_attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "file_attachments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          type: string;
          title: string;
          message: string;
          read: boolean;
          link: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type?: string;
          title: string;
          message?: string;
          read?: boolean;
          link?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: string;
          title?: string;
          message?: string;
          read?: boolean;
          link?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          icon: string | null;
          color: string | null;
          visibility: string;
          due_date: string | null;
          archived_at: string | null;
          deleted_at: string | null;
          owner_id: string;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          icon?: string | null;
          color?: string | null;
          visibility?: string;
          due_date?: string | null;
          archived_at?: string | null;
          deleted_at?: string | null;
          owner_id: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          icon?: string | null;
          color?: string | null;
          visibility?: string;
          due_date?: string | null;
          archived_at?: string | null;
          deleted_at?: string | null;
          owner_id?: string;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      project_columns: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          sort_order: number;
          color: string | null;
          created_at: string;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          sort_order?: number;
          color?: string | null;
          created_at?: string;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          name?: string;
          sort_order?: number;
          color?: string | null;
          created_at?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_columns_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          role: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id: string;
          role?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          user_id?: string;
          role?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      project_milestones: {
        Row: {
          id: string;
          project_id: string;
          title: string;
          description: string | null;
          due_date: string | null;
          status: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          title: string;
          description?: string | null;
          due_date?: string | null;
          status?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          title?: string;
          description?: string | null;
          due_date?: string | null;
          status?: string;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_milestones_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          workspace_id: string;
          title: string;
          description: string | null;
          status: string;
          priority: string;
          due_date: string | null;
          start_date: string | null;
          created_by: string;
          project_id: string | null;
          column_id: string | null;
          channel_id: string | null;
          message_id: string | null;
          milestone_id: string | null;
          sort_order: number;
          archived_at: string | null;
          deleted_at: string | null;
          status_order: string[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          title: string;
          description?: string | null;
          status?: string;
          priority?: string;
          due_date?: string | null;
          start_date?: string | null;
          created_by: string;
          project_id?: string | null;
          column_id?: string | null;
          channel_id?: string | null;
          message_id?: string | null;
          milestone_id?: string | null;
          sort_order?: number;
          archived_at?: string | null;
          deleted_at?: string | null;
          status_order?: string[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          title?: string;
          description?: string | null;
          status?: string;
          priority?: string;
          due_date?: string | null;
          start_date?: string | null;
          created_by?: string;
          project_id?: string | null;
          column_id?: string | null;
          channel_id?: string | null;
          message_id?: string | null;
          milestone_id?: string | null;
          sort_order?: number;
          archived_at?: string | null;
          deleted_at?: string | null;
          status_order?: string[] | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_column_id_fkey";
            columns: ["column_id"];
            isOneToOne: false;
            referencedRelation: "project_columns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"],
          },
          {
            foreignKeyName: "tasks_milestone_id_fkey";
            columns: ["milestone_id"];
            isOneToOne: false;
            referencedRelation: "project_milestones";
            referencedColumns: ["id"],
          },
        ];
      };
      task_assignees: {
        Row: {
          id: string;
          task_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_assignees_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_assignees_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      task_labels: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          color: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          color: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          color?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_labels_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      task_label_assignments: {
        Row: {
          id: string;
          task_id: string;
          label_id: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          label_id: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          label_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "task_label_assignments_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_label_assignments_label_id_fkey";
            columns: ["label_id"];
            isOneToOne: false;
            referencedRelation: "task_labels";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log: {
        Row: {
          id: string;
          workspace_id: string;
          actor_id: string | null;
          action: string;
          entity_type: string | null;
          entity_id: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          actor_id?: string | null;
          action: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          actor_id?: string | null;
          action?: string;
          entity_type?: string | null;
          entity_id?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_settings: {
        Row: {
          workspace_id: string;
          default_channel_ids: string[];
          retention_days: number;
          quiet_hours_start: string | null;
          quiet_hours_end: string | null;
          typography: Record<string, unknown> | null;
          colors: string | null;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          default_channel_ids?: string[];
          retention_days?: number;
          quiet_hours_start?: string | null;
          quiet_hours_end?: string | null;
          typography?: Record<string, unknown> | null;
          colors?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          default_channel_ids?: string[];
          retention_days?: number;
          quiet_hours_start?: string | null;
          quiet_hours_end?: string | null;
          typography?: Record<string, unknown> | null;
          colors?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_settings_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: true;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      scheduled_message_attachments: {
        Row: {
          id: string;
          scheduled_message_id: string;
          user_id: string;
          file_name: string;
          file_size: number;
          file_type: string;
          file_url: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          scheduled_message_id: string;
          user_id: string;
          file_name: string;
          file_size: number;
          file_type: string;
          file_url: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          scheduled_message_id?: string;
          user_id?: string;
          file_name?: string;
          file_size?: number;
          file_type?: string;
          file_url?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "scheduled_message_attachments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"],
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      update_task: {
        Args: { p_task_id: string; p_title: string | null; p_description: string | null; p_status: string | null; p_priority: string | null; p_due_date: string | null; p_start_date: string | null; p_project_id: string | null };
        Returns: void;
      };
      update_task_status: {
        Args: { p_task_id: string; p_status: string };
        Returns: void;
      };
      delete_task: {
        Args: { p_task_id: string };
        Returns: void;
      };
      archive_task: {
        Args: { p_task_id: string };
        Returns: void;
      };
      restore_task: {
        Args: { p_task_id: string };
        Returns: void;
      };
      add_project_member: {
        Args: { p_project_id: string; p_user_id: string; p_role?: string };
        Returns: void;
      };
      get_project_member_count: {
        Args: { p_project_id: string };
        Returns: number;
      };
      get_user_id_by_email: {
        Args: { p_email: string };
        Returns: { user_id: string }[];
      };
      get_last_messages_for_channels: {
        Args: { p_channel_ids: string[] };
        Returns: { channel_id: string; content: string; created_at: string; user_id: string }[];
      };
      get_project_members: {
        Args: { p_project_id: string };
        Returns: { id: string; user_id: string; role: string; created_at: string; display_name: string | null; avatar_url: string | null; email: string; is_implicit: boolean }[];
      };
      update_project_member_role: {
        Args: { p_member_id: string; p_role: string };
        Returns: void;
      };
      remove_project_member: {
        Args: { p_member_id: string };
        Returns: void;
      };
      move_task_to_column: {
        Args: { p_task_id: string; p_column_id: string; p_sort_order: number };
        Returns: void;
      };
      create_workspace_with_owner: {
        Args: { p_name: string; p_slug: string; p_owner_id: string; p_description: string | null };
        Returns: unknown;
      };
      accept_workspace_invitation: {
        Args: { p_invitation_id: string; p_user_id: string; p_user_email: string | null };
        Returns: void;
      };
      transfer_workspace_ownership: {
        Args: { p_workspace_id: string; p_current_owner_id: string; p_new_owner_id: string };
        Returns: void;
      };
      remove_workspace_member: {
        Args: { p_workspace_id: string; p_target_user_id: string; p_caller_id: string };
        Returns: void;
      };
      change_member_role: {
        Args: { p_workspace_id: string; p_target_user_id: string; p_new_role: string; p_caller_id: string };
        Returns: void;
      };
      mark_channel_read: {
        Args: { p_channel_id: string; p_user_id: string };
        Returns: void;
      };
      get_unread_count: {
        Args: { p_channel_id: string; p_user_id: string };
        Returns: number;
      };
      get_unread_counts: {
        Args: { p_user_id: string; p_channel_ids: string[] };
        Returns: { channel_id: string; unread_count: number }[];
      };
      mark_conversation_read: {
        Args: { p_conversation_id: string; p_user_id: string };
        Returns: void;
      };
      record_message_version: {
        Args: { p_message_id: string; p_user_id: string; p_content: string };
        Returns: void;
      };
      get_events_participants: {
        Args: { p_event_ids: string[] };
        Returns: unknown[];
      };
      add_event_participant: {
        Args: { p_event_id: string; p_user_id: string };
        Returns: string;
      };
      remove_event_participant_by_id: {
        Args: { p_participant_id: string };
        Returns: void;
      };
      get_execution_logs: {
        Args: { p_workspace_id: string; p_rule_id: string | null };
        Returns: unknown[];
      };
      create_notification: {
        Args: { p_user_id: string; p_type: string; p_title: string; p_message: string; p_link: string | null };
        Returns: void;
      };
      get_notification_unread_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      mark_notification_read: {
        Args: { p_notification_id: string };
        Returns: void;
      };
      mark_all_notifications_read: {
        Args: Record<string, never>;
        Returns: void;
      };
      mark_channel_read_up_to: {
        Args: { p_channel_id: string; p_message_id: string };
        Returns: void;
      };
      get_workspace_member_count: {
        Args: { p_workspace_id: string };
        Returns: number;
      };
      touch_presence: {
        Args: Record<string, never>;
        Returns: void;
      };
      set_user_offline: {
        Args: Record<string, never>;
        Returns: void;
      };
      write_audit_log: {
        Args: { p_workspace_id: string; p_action: string; p_entity_type?: string | null; p_entity_id?: string | null; p_metadata?: Record<string, unknown> | null };
        Returns: void;
      };
      get_workspace_settings: {
        Args: { p_workspace_id: string };
        Returns: unknown;
      };
      upsert_workspace_settings: {
        Args: { p_workspace_id: string; p_default_channel_ids?: string[] | null; p_retention_days?: number | null; p_quiet_hours_start?: string | null; p_quiet_hours_end?: string | null; p_typography?: Record<string, unknown> | null; p_colors?: string | null; p_clear_typography?: boolean; p_clear_colors?: boolean };
        Returns: unknown;
      };
      apply_message_retention: {
        Args: Record<string, never>;
        Returns: number;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

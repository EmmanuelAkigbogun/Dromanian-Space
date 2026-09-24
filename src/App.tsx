import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { LayoutProvider } from '@/app/providers/LayoutProvider';
import { AuthProvider } from '@/app/providers/AuthProvider';
import { ProfileProvider } from '@/app/providers/ProfileProvider';
import { WorkspaceProvider } from '@/app/providers/WorkspaceProvider';
import { WorkspaceThemeProvider } from '@/app/providers/WorkspaceThemeProvider';
import { ChannelProvider } from '@/app/providers/ChannelProvider';
import { ConversationProvider } from '@/app/providers/ConversationProvider';
import { ThreadProvider, useThread } from '@/app/providers/ThreadProvider';
import { MessageSelectionProvider } from '@/app/providers/MessageSelectionProvider';
import { MessageProvider } from '@/app/providers/MessageProvider';
import { PresenceProvider } from '@/app/providers/PresenceProvider';
import { CommandPaletteProvider } from '@/app/providers/CommandPaletteProvider';
import { NotificationProvider } from '@/app/providers/NotificationProvider/NotificationProvider';
import { CallProvider } from '@/app/providers/CallProvider/CallProvider';
import { ToastProvider } from '@/components/ui/Toast';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PublicRoute } from '@/components/auth/PublicRoute';
import { OnboardingWrapper } from '@/components/auth/OnboardingWrapper';
import { WorkspaceGuard } from '@/components/workspace';
import { ThreadPanel } from '@/components/message/ThreadPanel';
import { DmConversationView } from '@/components/dm';
import { CommandPalette } from '@/components/command-palette/CommandPalette';
import { CallOverlay } from '@/components/call';
import { Home } from '@/app/routes/Home';
import { Placeholder } from '@/app/routes/Placeholder';
import { Messages } from '@/app/routes/Messages';
import { Channels } from '@/app/routes/Channels';
import { ChannelView } from '@/app/routes/Channels/ChannelView';
import { Files } from '@/app/routes/Files';
import { Notifications } from '@/app/routes/Notifications';
import { Invitations } from '@/app/routes/Invitations';
import { Settings } from '@/app/routes/Settings';
import { Profile } from '@/app/routes/Profile';
import { SignIn } from '@/app/routes/auth/SignIn';
import { SignUp } from '@/app/routes/auth/SignUp';
import { ForgotPassword } from '@/app/routes/auth/ForgotPassword';
import { ResetPassword } from '@/app/routes/auth/ResetPassword';
import { EmailVerification } from '@/app/routes/auth/EmailVerification';
import { AuthCallback } from '@/app/routes/auth/AuthCallback';
import { Unauthorized } from '@/app/routes/auth/Unauthorized';
import { AcceptInvite } from '@/app/routes/auth/AcceptInvite';
import { JoinWorkspace } from '@/app/routes/JoinWorkspace';
import { TaskPage } from '@/app/routes/Tasks/TaskPage';
import { ProjectsPage, ProjectViewPage } from '@/app/routes/Projects';
import { CalendarPage } from '@/app/routes/Calendar';
import { AutomationPage } from '@/app/routes/Automation';
import { SavedPinnedPage } from '@/app/routes/SavedPinned';
import { CallsPage } from '@/app/routes/Calls';
import { HomeIcon, MessageIcon, UsersIcon, BellIcon, SettingsIcon, UserIcon, FolderIcon, MailIcon, TaskIcon, ProjectIcon, CalendarIcon, AutomationIcon, AiIcon, BookmarkIcon, PhoneIcon } from '@/components/shared/Icons';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAuth } from '@/hooks/useAuth';
import { useTabLeader } from '@/hooks/useTabLeader';
import { supabase } from '@/lib/supabase';
import { sendMessage } from '@/lib/message';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 55 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const primaryNavigation = [
  { to: '/', icon: <HomeIcon />, label: 'Home' },
  { to: '/ai', icon: <AiIcon />, label: 'AI' },
  { to: '/dm', icon: <MessageIcon />, label: 'Messages' },
  { to: '/channels', icon: <UsersIcon />, label: 'Channels' },
  { to: '/tasks', icon: <TaskIcon />, label: 'Tasks' },
  { to: '/projects', icon: <ProjectIcon />, label: 'Projects' },
  { to: '/calendar', icon: <CalendarIcon />, label: 'Calendar' },
  { to: '/files', icon: <FolderIcon />, label: 'Files' },
];

const secondaryNavigation = [
  { to: '/calls', icon: <PhoneIcon />, label: 'Calls' },
  { to: '/saved-pinned', icon: <BookmarkIcon />, label: 'Saved & Pinned' },
  { to: '/automation', icon: <AutomationIcon />, label: 'Automation' },
  { to: '/notifications', icon: <BellIcon />, label: 'Notifications' },
  { to: '/invitations', icon: <MailIcon />, label: 'Invitations' },
  { to: '/profile', icon: <UserIcon />, label: 'Profile' },
  { to: '/settings', icon: <SettingsIcon />, label: 'Settings' },
];

function AppLayoutWithThread() {
  const { activeThread, closeThread } = useThread();
  const { userId } = useAuth();
  const isLeaderTab = useTabLeader();
  useKeyboardShortcuts();

  useEffect(() => {
    if (!userId || !isLeaderTab) return;
    const poll = async () => {
      const now = new Date().toISOString();
      const { data } = await supabase
        .from('scheduled_messages' as never)
        .select('id, channel_id, conversation_id, user_id, content, parent_id')
        .eq('user_id', userId)
        .eq('sent', false)
        .lte('scheduled_at', now);
      if (!data || data.length === 0) return;
      const db = supabase as any;
      for (const msg of data as { id: string; channel_id: string | null; conversation_id: string | null; user_id: string; content: string; parent_id: string | null }[]) {
        // Atomically claim the row so the server cron never double-sends.
        const claim = await supabase
          .from('scheduled_messages' as never)
          .update({ sent: true } as never)
          .eq('id', msg.id)
          .eq('sent', false)
          .select('id')
          .maybeSingle();
        if (!claim.data) continue;
        let targetChannelId = msg.channel_id;
        if (!targetChannelId && msg.conversation_id) {
          const { data: conv } = await supabase
            .from('direct_conversations' as never)
            .select('channel_id')
            .eq('id', msg.conversation_id)
            .single();
          targetChannelId = (conv as { channel_id: string } | null)?.channel_id ?? null;
        }
        if (targetChannelId) {
          const sent = await sendMessage(targetChannelId, msg.user_id, msg.content, { parentId: msg.parent_id ?? undefined });
          // Move scheduled attachments to file_attachments
          if (sent) {
            const { data: attachments } = await db
              .from('scheduled_message_attachments')
              .select('*')
              .eq('scheduled_message_id', msg.id);
            if (attachments && attachments.length > 0) {
              for (const att of attachments) {
                await db.from('file_attachments').insert({
                  message_id: sent.id,
                  user_id: att.user_id,
                  file_name: att.file_name,
                  file_size: att.file_size,
                  file_type: att.file_type,
                  file_url: att.file_url,
                });
              }
              await db.from('scheduled_message_attachments').delete().eq('scheduled_message_id', msg.id);
            }
          }
        }
      }
    };
    poll();
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [userId, isLeaderTab]);

  return (
    <>
    <CommandPalette />
    <CallOverlay />
    <AppLayout
      primaryNavigation={primaryNavigation}
      secondaryNavigation={secondaryNavigation}
      headerTitle="Δαρκ space"
      rightPanelTitle={activeThread ? 'Thread' : undefined}
      rightPanelContent={activeThread ? <MessageProvider><ThreadPanel /></MessageProvider> : undefined}
      onRightPanelClose={closeThread}
    >
      <Routes>
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/invitations" element={<Invitations />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/dm" element={<DmConversationView />} />
        <Route path="/dm/:conversationId" element={<DmConversationView />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/saved-pinned" element={<SavedPinnedPage />} />
        <Route path="/calls" element={<CallsPage />} />
        <Route path="/new-call" element={<CallsPage />} />
        <Route path="/call-history" element={<CallsPage />} />
        <Route path="*" element={
          <WorkspaceGuard>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/ai" element={<Placeholder title="AI" description="AI assistant — coming soon." />} />
              <Route path="/messages" element={<Messages />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/channels/:slug" element={<ChannelView />} />
              <Route path="/files" element={<Files />} />
              <Route path="/tasks" element={<TaskPage />} />
              <Route path="/tasks/:taskId" element={<TaskPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectViewPage />} />
              <Route path="/automation" element={<AutomationPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </WorkspaceGuard>
        } />
      </Routes>
    </AppLayout>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              {/* Public auth routes - redirect to / if already authenticated */}
              <Route path="/signin" element={<PublicRoute><SignIn /></PublicRoute>} />
              <Route path="/signup" element={<PublicRoute><SignUp /></PublicRoute>} />
              <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
              <Route path="/auth/reset-password" element={<ResetPassword />} />
              <Route path="/auth/verify-email" element={<EmailVerification />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/unauthorized" element={<Unauthorized />} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/join/:token" element={<JoinWorkspace />} />

              {/* Protected app routes */}
              <Route
                path="*"
                element={
                  <ProtectedRoute>
                    <ProfileProvider>
                      <OnboardingWrapper>
                        <WorkspaceProvider>
                          <WorkspaceThemeProvider>
                          <PresenceProvider>
                            <ChannelProvider>
                              <ConversationProvider>
                                <LayoutProvider>
                                  <ThreadProvider>
                    <CommandPaletteProvider>
                    <NotificationProvider>
                    <CallProvider>
                      <MessageSelectionProvider>
                                      <AppLayoutWithThread />
                      </MessageSelectionProvider>
                    </CallProvider>
                    </NotificationProvider>
                    </CommandPaletteProvider>
                                  </ThreadProvider>
                                </LayoutProvider>
                              </ConversationProvider>
                            </ChannelProvider>
                          </PresenceProvider>
                          </WorkspaceThemeProvider>
                        </WorkspaceProvider>
                      </OnboardingWrapper>
                    </ProfileProvider>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

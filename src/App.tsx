import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, lazy, Suspense, Fragment, type ReactNode } from 'react';
import { useWorkspaceContext } from '@/app/providers/WorkspaceProvider';
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
import { Messages } from '@/app/routes/Messages';
import { Channels } from '@/app/routes/Channels';
import { ChannelView } from '@/app/routes/Channels/ChannelView';
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
import { supabase } from '@/lib/supabase';

const CRMPage = lazy(() => import('@/app/routes/CRM/CRMPage'));
const ThreadsPage = lazy(() => import('@/app/routes/Threads/ThreadsPage'));
const DrivePage = lazy(() => import('@/app/routes/Drive/DrivePage'));
const AgentsPage = lazy(() => import('@/app/routes/Agents/AgentsPage'));

function TenantBoundary({children}: {children: ReactNode}) {
  const {currentWorkspace} = useWorkspaceContext();
  const {userId} = useAuth();
  return <Fragment key={`${userId}:${currentWorkspace?.id}`}>{children}</Fragment>;
}

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
  { to: '/agents', icon: <AiIcon />, label: 'Agents' },
  { to: '/dm', icon: <MessageIcon />, label: 'Chat' },
  { to: '/channels', icon: <UsersIcon />, label: 'Channels' },
  { to: '/tasks', icon: <TaskIcon />, label: 'Tasks' },
  { to: '/projects', icon: <ProjectIcon />, label: 'Projects' },
  { to: '/calendar', icon: <CalendarIcon />, label: 'Calendar' },
  { to: '/drive', icon: <FolderIcon />, label: 'Drive' },
  { to: '/crm', icon: <UsersIcon />, label: 'CRM' },
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
  const { pathname } = useLocation();
  useEffect(() => {
    if (!/^\/(channels|dm|threads)(\/|$)/.test(pathname)) closeThread();
  }, [pathname, closeThread]);
  useKeyboardShortcuts();

  // Scheduled messages are delivered on the server only: by pg_cron, or by the
  // worker where pg_cron has no active job (never both). Browsers do not send them.

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
      <Suspense fallback={<p role="status">Loading workspace…</p>}><Routes>
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
              <Route path="/ai" element={<Navigate to="/agents" replace />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/:agentId" element={<AgentsPage />} />
              <Route path="/agents/conversations/:conversationId" element={<AgentsPage />} />
              <Route path="/agents/c/:conversationId" element={<AgentsPage />} />
              <Route path="/messages" element={<Messages />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/channels/:slug" element={<ChannelView />} />
              <Route path="/files" element={<Navigate to="/drive" replace />} />
              <Route path="/drive" element={<DrivePage />} />
              <Route path="/threads" element={<ThreadsPage />} />
              <Route path="/crm" element={<Navigate to="/crm/contacts" replace />} />
              <Route path="/crm/:kind" element={<CRMPage />} />
              <Route path="/crm/:kind/:recordId" element={<CRMPage />} />
              <Route path="/drive/item/:itemId" element={<DrivePage />} />
              <Route path="/drive/folder/:folderId" element={<DrivePage />} />
              <Route path="/tasks" element={<TaskPage />} />
              <Route path="/tasks/:taskId" element={<TaskPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectViewPage />} />
              <Route path="/automation" element={<AutomationPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </WorkspaceGuard>
        } />
      </Routes></Suspense>
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
                          <TenantBoundary><WorkspaceThemeProvider>
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
                          </WorkspaceThemeProvider></TenantBoundary>
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

import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
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
import { HomeIcon, MessageIcon, UsersIcon, BellIcon, SettingsIcon, UserIcon, FolderIcon, MailIcon, TaskIcon, ProjectIcon, CalendarIcon, AutomationIcon, AiIcon, BookmarkIcon, PhoneIcon, SocialIcon } from '@/components/shared/Icons';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useAuth } from '@/hooks/useAuth';
import { useFeatureAccess } from '@/lib/workspace/features';
import { CHAT_HOME, CHAT_ONLY, chatOnlyPath } from '@/lib/pwa';
import { PermissionsBanner } from '@/components/pwa/PermissionsBanner';
import { useDeliveryTracker } from '@/hooks/useChannelReceipts';


const CRMPage = lazy(() => import('@/app/routes/CRM/CRMPage'));
const ThreadsPage = lazy(() => import('@/app/routes/Threads/ThreadsPage'));
const DrivePage = lazy(() => import('@/app/routes/Drive/DrivePage'));
const AgentsPage = lazy(() => import('@/app/routes/Agents/AgentsPage'));
const ThreadPanel = lazy(() => import('@/components/message/ThreadPanel').then((m) => ({ default: m.ThreadPanel })));
const DmConversationView = lazy(() => import('@/components/dm').then((m) => ({ default: m.DmConversationView })));
const CommandPalette = lazy(() => import('@/components/command-palette/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const CallOverlay = lazy(() => import('@/components/call').then((m) => ({ default: m.CallOverlay })));
const Home = lazy(() => import('@/app/routes/Home').then((m) => ({ default: m.Home })));
const Messages = lazy(() => import('@/app/routes/Messages').then((m) => ({ default: m.Messages })));
const Channels = lazy(() => import('@/app/routes/Channels').then((m) => ({ default: m.Channels })));
const ChannelView = lazy(() => import('@/app/routes/Channels/ChannelView').then((m) => ({ default: m.ChannelView })));
const Notifications = lazy(() => import('@/app/routes/Notifications').then((m) => ({ default: m.Notifications })));
const Invitations = lazy(() => import('@/app/routes/Invitations').then((m) => ({ default: m.Invitations })));
const Settings = lazy(() => import('@/app/routes/Settings').then((m) => ({ default: m.Settings })));
const Profile = lazy(() => import('@/app/routes/Profile').then((m) => ({ default: m.Profile })));
const SignIn = lazy(() => import('@/app/routes/auth/SignIn').then((m) => ({ default: m.SignIn })));
const SignUp = lazy(() => import('@/app/routes/auth/SignUp').then((m) => ({ default: m.SignUp })));
const ForgotPassword = lazy(() => import('@/app/routes/auth/ForgotPassword').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('@/app/routes/auth/ResetPassword').then((m) => ({ default: m.ResetPassword })));
const EmailVerification = lazy(() => import('@/app/routes/auth/EmailVerification').then((m) => ({ default: m.EmailVerification })));
const Unauthorized = lazy(() => import('@/app/routes/auth/Unauthorized').then((m) => ({ default: m.Unauthorized })));
const AcceptInvite = lazy(() => import('@/app/routes/auth/AcceptInvite').then((m) => ({ default: m.AcceptInvite })));
const JoinWorkspace = lazy(() => import('@/app/routes/JoinWorkspace').then((m) => ({ default: m.JoinWorkspace })));
const TaskPage = lazy(() => import('@/app/routes/Tasks/TaskPage').then((m) => ({ default: m.TaskPage })));
const ProjectsPage = lazy(() => import('@/app/routes/Projects').then((m) => ({ default: m.ProjectsPage })));
const ProjectViewPage = lazy(() => import('@/app/routes/Projects').then((m) => ({ default: m.ProjectViewPage })));
const CalendarPage = lazy(() => import('@/app/routes/Calendar').then((m) => ({ default: m.CalendarPage })));
const AutomationPage = lazy(() => import('@/app/routes/Automation').then((m) => ({ default: m.AutomationPage })));
const SavedPinnedPage = lazy(() => import('@/app/routes/SavedPinned').then((m) => ({ default: m.SavedPinnedPage })));
const CallsPage = lazy(() => import('@/app/routes/Calls').then((m) => ({ default: m.CallsPage })));
const SocialPage = lazy(() => import('@/app/routes/Social').then((m) => ({ default: m.SocialPage })));

function DesktopIntegration() {
  const navigate = useNavigate();
  useEffect(() => {
    const desktop = window.darkspaceDesktop;
    if (!desktop) return;
    return desktop.onNotificationClick(({ route }) => {
      if (route.startsWith('/') && !route.startsWith('//')) navigate(route);
    });
  }, [navigate]);
  return null;
}

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
  { to: '/social', icon: <SocialIcon />, label: 'Social' },
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
  const features = useFeatureAccess();
  const shown = (n: { to: string }) => !features.pathHidden(n.to) && (!CHAT_ONLY || chatOnlyPath(n.to));
  const visiblePrimary = primaryNavigation.filter(shown);
  const visibleSecondary = secondaryNavigation.filter(shown);
  const pageHidden = CHAT_ONLY ? !chatOnlyPath(pathname) : !features.loading && features.pathHidden(pathname);
  useEffect(() => {
    if (!/^\/(channels|dm|threads)(\/|$)/.test(pathname)) closeThread();
  }, [pathname, closeThread]);
  useKeyboardShortcuts();
  useDeliveryTracker();

  // Scheduled messages are delivered on the server only: by pg_cron, or by the
  // worker where pg_cron has no active job (never both). Browsers do not send them.

  return (
    <>
    <Suspense fallback={null}><CommandPalette /></Suspense>
    <Suspense fallback={null}><CallOverlay /></Suspense>
    <AppLayout
      primaryNavigation={visiblePrimary}
      secondaryNavigation={visibleSecondary}
      headerTitle="Darkspace"
      rightPanelTitle={activeThread ? 'Thread' : undefined}
      rightPanelContent={activeThread ? <MessageProvider><ThreadPanel /></MessageProvider> : undefined}
      onRightPanelClose={closeThread}
    >
      <PermissionsBanner />
      {pageHidden ? <Navigate to={CHAT_ONLY ? CHAT_HOME : '/'} replace /> : (
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
              <Route path="/crm" element={<Navigate to="/crm/companies" replace />} />
              <Route path="/crm/:kind" element={<CRMPage />} />
              <Route path="/crm/:kind/:recordId" element={<CRMPage />} />
              <Route path="/drive/item/:itemId" element={<DrivePage />} />
              <Route path="/drive/folder/:folderId" element={<DrivePage />} />
              <Route path="/tasks" element={<TaskPage />} />
              <Route path="/tasks/:taskId" element={<TaskPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectViewPage />} />
              <Route path="/automation" element={<AutomationPage />} />
              <Route path="/social" element={<SocialPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </WorkspaceGuard>
        } />
      </Routes></Suspense>
      )}
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
          <DesktopIntegration />
          <AuthProvider>
            <Routes>
              {/* Public auth routes - redirect to / if already authenticated */}
              <Route path="/signin" element={<PublicRoute><SignIn /></PublicRoute>} />
              <Route path="/signup" element={<PublicRoute><SignUp /></PublicRoute>} />
              <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
              <Route path="/auth/reset-password" element={<ResetPassword />} />
              <Route path="/auth/verify-email" element={<EmailVerification />} />
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
                                      <Suspense fallback={<p role="status">Loading workspace…</p>}><AppLayoutWithThread /></Suspense>
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

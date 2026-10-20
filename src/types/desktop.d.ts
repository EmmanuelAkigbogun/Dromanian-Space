interface DarkspaceDesktopNotification {
  title: string;
  body: string;
  route?: string;
  kind?: 'call' | 'message' | 'system';
}

interface DarkspaceDesktopBridge {
  readonly isDesktop: true;
  notify: (payload: DarkspaceDesktopNotification) => Promise<boolean>;
  setRinging: (value: boolean) => void;
  setUnreadCount: (value: number) => void;
  onNotificationClick: (callback: (payload: { route: string }) => void) => () => void;
  onSoundsChanged: (callback: (enabled: boolean) => void) => () => void;
}

interface Window {
  darkspaceDesktop?: DarkspaceDesktopBridge;
}

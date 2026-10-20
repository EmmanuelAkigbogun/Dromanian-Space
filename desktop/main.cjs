const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, Menu, nativeImage, Notification,
  powerSaveBlocker, session, shell, Tray,
} = require('electron');

const APP_ID = 'pro.purplehive.darkspace';
const APP_URL = process.env.DARKSPACE_URL || 'https://darkspace.purplehive.pro';
const APP_ORIGIN = new URL(APP_URL).origin;
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');
const START_HIDDEN = process.argv.includes('--hidden');
let mainWindow = null;
let tray = null;
let isQuitting = false;
let soundsEnabled = true;
let isRinging = false;
let powerSaveBlockerId = null;

app.setAppUserModelId(APP_ID);
// Incoming calls must ring even when the tray app has not been focused since
// Windows started. This affects only media from the single trusted app origin.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function isTrustedUrl(rawUrl) {
  try { return new URL(rawUrl).origin === APP_ORIGIN; } catch { return false; }
}

function isTrustedSender(event) {
  return Boolean(event.senderFrame?.url && isTrustedUrl(event.senderFrame.url));
}

function safeRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value.slice(0, 500);
}

function showAndFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.flashFrame(false);
}

function sendNotificationClick(route) {
  showAndFocusWindow();
  mainWindow?.webContents.send('desktop:notification-click', { route: safeRoute(route) });
}

function setRinging(nextValue) {
  isRinging = Boolean(nextValue);
  if (isRinging) {
    mainWindow?.flashFrame(true);
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else {
    mainWindow?.flashFrame(false);
    if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
    }
    powerSaveBlockerId = null;
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(isRinging ? 'Darkspace — incoming call' : 'Darkspace');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: isRinging ? 'Open incoming call' : 'Open Darkspace', click: showAndFocusWindow },
    { type: 'separator' },
    {
      label: 'Notification sounds', type: 'checkbox', checked: soundsEnabled,
      click: (item) => {
        soundsEnabled = item.checked;
        mainWindow?.webContents.send('desktop:sounds-changed', soundsEnabled);
      },
    },
    {
      label: 'Launch at startup', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({
        openAtLogin: item.checked,
        path: app.getPath('exe'),
        args: item.checked ? ['--hidden'] : [],
      }),
    },
    { type: 'separator' },
    { label: 'Quit Darkspace', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.on('click', showAndFocusWindow);
  updateTrayMenu();
}

function configurePermissions() {
  const allowedPermissions = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    isTrustedUrl(requestingOrigin) && allowedPermissions.has(permission)
  ));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isTrustedUrl(contents.getURL()) && allowedPermissions.has(permission));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 940, minWidth: 960, minHeight: 640, show: false,
    backgroundColor: '#0A0C14', icon: ICON_PATH, title: 'Darkspace', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('desktop:sounds-changed', soundsEnabled);
  });
  mainWindow.once('ready-to-show', () => { if (!START_HIDDEN) mainWindow?.show(); });
  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow?.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadURL(APP_URL);
}

ipcMain.handle('desktop:notify', (event, payload) => {
  if (!isTrustedSender(event) || !Notification.isSupported() || !payload || typeof payload !== 'object') return false;
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : 'Darkspace';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 500) : '';
  const route = safeRoute(payload.route);
  const notification = new Notification({
    title, body, icon: ICON_PATH, silent: payload.kind === 'call' || !soundsEnabled,
    urgency: payload.kind === 'call' ? 'critical' : 'normal',
  });
  notification.on('click', () => sendNotificationClick(route));
  notification.show();
  return true;
});

ipcMain.on('desktop:set-ringing', (event, value) => {
  if (isTrustedSender(event)) setRinging(value);
});

ipcMain.on('desktop:set-unread-count', (event, value) => {
  if (!isTrustedSender(event)) return;
  const count = Number.isFinite(value) ? Math.max(0, Math.min(9999, Math.floor(value))) : 0;
  app.setBadgeCount(count);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showAndFocusWindow);
  app.whenReady().then(() => { configurePermissions(); createWindow(); createTray(); });
}

app.on('activate', () => { if (!mainWindow) createWindow(); else showAndFocusWindow(); });
app.on('before-quit', () => { isQuitting = true; setRinging(false); });
app.on('window-all-closed', () => { /* Keep the tray app alive for calls and notifications. */ });

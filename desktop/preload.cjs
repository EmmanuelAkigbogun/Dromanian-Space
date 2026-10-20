const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darkspaceDesktop', Object.freeze({
  isDesktop: true,
  notify: (payload) => ipcRenderer.invoke('desktop:notify', payload),
  setRinging: (value) => ipcRenderer.send('desktop:set-ringing', Boolean(value)),
  setUnreadCount: (value) => ipcRenderer.send('desktop:set-unread-count', value),
  onNotificationClick: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:notification-click', listener);
    return () => ipcRenderer.removeListener('desktop:notification-click', listener);
  },
  onSoundsChanged: (callback) => {
    const listener = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on('desktop:sounds-changed', listener);
    return () => ipcRenderer.removeListener('desktop:sounds-changed', listener);
  },
}));

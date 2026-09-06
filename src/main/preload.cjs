const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('monitorApi', {
  getSnapshot: () => ipcRenderer.invoke('monitor:get-snapshot'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (draft) => ipcRenderer.invoke('settings:save', draft),
  getHistory: () => ipcRenderer.invoke('history:get'),
  setHistoryActive: (active) => ipcRenderer.send('history:active', active),
  saveHistorySettings: (draft) => ipcRenderer.invoke('history:save-settings', draft),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  installPawnIo: () => ipcRenderer.invoke('support:install-pawnio'),
  resetOverlayPosition: () => ipcRenderer.invoke('overlay:reset-position'),
  resizeOverlay: (size) => ipcRenderer.send('overlay:resize', size),
  onMonitorUpdate: (callback) => subscribe('monitor:update', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onHistoryChanged: (callback) => subscribe('history:changed', callback),
  onHistorySettingsChanged: (callback) => subscribe('history:settings-changed', callback)
});

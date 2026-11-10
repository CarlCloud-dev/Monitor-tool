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
  getHistory: (query) => ipcRenderer.invoke('history:get', query),
  setHistoryActive: (active) => ipcRenderer.send('history:active', active),
  saveHistorySettings: (draft) => ipcRenderer.invoke('history:save-settings', draft),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  getUpdateState: () => ipcRenderer.invoke('updates:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  showUpdateDialog: () => ipcRenderer.invoke('updates:show'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('updates:cancel'),
  manualDownloadUpdate: () => ipcRenderer.invoke('updates:manual-download'),
  closeUpdateDialog: () => ipcRenderer.send('updates:close'),
  installPawnIo: () => ipcRenderer.invoke('support:install-pawnio'),
  resetOverlayPosition: () => ipcRenderer.invoke('overlay:reset-position'),
  resizeOverlay: (size) => ipcRenderer.send('overlay:resize', size),
  resizeTaskbar: (size) => ipcRenderer.send('taskbar:resize', size),
  onMonitorUpdate: (callback) => subscribe('monitor:update', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onHistoryChanged: (callback) => subscribe('history:changed', callback),
  onHistorySettingsChanged: (callback) => subscribe('history:settings-changed', callback),
  onUpdateState: (callback) => subscribe('updates:state', callback)
});

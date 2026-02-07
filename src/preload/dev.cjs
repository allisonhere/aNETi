const { contextBridge, ipcRenderer } = require('electron');

const preloadVersion = '0.1.0-dev';

contextBridge.exposeInMainWorld('anetiMeta', {
  preload: true,
  version: preloadVersion,
});

ipcRenderer.send('preload:ready', { version: preloadVersion });

contextBridge.exposeInMainWorld('aneti', {
  startScan: (options) => ipcRenderer.invoke('scanner:start', options),
  stopScan: () => ipcRenderer.invoke('scanner:stop'),
  listDevices: () => ipcRenderer.invoke('scanner:list'),
  diagnostics: (options) => ipcRenderer.invoke('scanner:diagnostics', options),
  onDevices: (callback) => {
    const handler = (_event, devices) => callback(devices);
    ipcRenderer.on('scanner:devices', handler);
    return () => ipcRenderer.off('scanner:devices', handler);
  },
  onSummary: (callback) => {
    const handler = (_event, summary) => callback(summary);
    ipcRenderer.on('ai:summary', handler);
    return () => ipcRenderer.off('ai:summary', handler);
  },
  listStoredDevices: () => ipcRenderer.invoke('db:devices'),
  listAlerts: (limit) => ipcRenderer.invoke('db:alerts', limit),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsUpdate: (provider, key) => ipcRenderer.invoke('settings:update', provider, key),
});

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aneti', {
  startScan: (options?: { intervalMs?: number; maxHosts?: number }) => ipcRenderer.invoke('scanner:start', options),
  stopScan: () => ipcRenderer.invoke('scanner:stop'),
  listDevices: () => ipcRenderer.invoke('scanner:list'),
  diagnostics: (options?: { maxHosts?: number }) => ipcRenderer.invoke('scanner:diagnostics', options),
  onDevices: (callback: (devices: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, devices: unknown) => callback(devices);
    ipcRenderer.on('scanner:devices', handler);
    return () => ipcRenderer.off('scanner:devices', handler);
  },
  listStoredDevices: () => ipcRenderer.invoke('db:devices'),
  listAlerts: (limit?: number) => ipcRenderer.invoke('db:alerts', limit),
});

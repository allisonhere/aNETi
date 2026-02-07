import { clipboard, contextBridge, ipcRenderer } from 'electron';

const preloadVersion = '0.1.0';

contextBridge.exposeInMainWorld('anetiMeta', {
  preload: true,
  version: preloadVersion,
});

ipcRenderer.send('preload:ready', { version: preloadVersion });

contextBridge.exposeInMainWorld('aneti', {
  startScan: (options?: {
    intervalMs?: number;
    maxHosts?: number;
    progressive?: boolean;
    batchSize?: number;
  }) => ipcRenderer.invoke('scanner:start', options),
  stopScan: () => ipcRenderer.invoke('scanner:stop'),
  listDevices: () => ipcRenderer.invoke('scanner:list'),
  diagnostics: (options?: { maxHosts?: number }) => ipcRenderer.invoke('scanner:diagnostics', options),
  onDevices: (callback: (devices: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, devices: unknown) => callback(devices);
    ipcRenderer.on('scanner:devices', handler);
    return () => ipcRenderer.off('scanner:devices', handler);
  },
  onSummary: (callback: (summary: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, summary: unknown) => callback(summary);
    ipcRenderer.on('ai:summary', handler);
    return () => ipcRenderer.off('ai:summary', handler);
  },
  listStoredDevices: () => ipcRenderer.invoke('db:devices'),
  listAlerts: (limit?: number) => ipcRenderer.invoke('db:alerts', limit),
  listSightings: (deviceId: string, limit?: number) =>
    ipcRenderer.invoke('db:sightings', deviceId, limit),
  updateDeviceLabel: (id: string, label: string | null) => ipcRenderer.invoke('db:label', id, label),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsUpdate: (provider: 'openai' | 'gemini' | 'claude', key: string | null) =>
    ipcRenderer.invoke('settings:update', provider, key),
  settingsUpdateAccent: (accentId: string | null) => ipcRenderer.invoke('settings:accent', accentId),
  settingsUpdateAlerts: (patch: { osNotifications?: boolean; unknownOnly?: boolean }) =>
    ipcRenderer.invoke('settings:alerts', patch),
  settingsSetDeviceMuted: (deviceId: string, muted: boolean) =>
    ipcRenderer.invoke('settings:mute-device', deviceId, muted),
  copyText: (value: string) => clipboard.writeText(String(value ?? '')),
});

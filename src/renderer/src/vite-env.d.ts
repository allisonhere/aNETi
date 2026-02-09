/// <reference types="vite/client" />

declare global {
  interface Window {
    anetiMeta?: {
      preload: boolean;
      version: string;
    };
    aneti?: {
      startScan: (options?: {
        intervalMs?: number;
        maxHosts?: number;
        progressive?: boolean;
        batchSize?: number;
      }) => Promise<unknown>;
      stopScan: () => Promise<void>;
      listDevices: () => Promise<unknown>;
      listStoredDevices: () => Promise<unknown>;
      listAlerts: (limit?: number) => Promise<unknown>;
      listSightings: (deviceId: string, limit?: number) => Promise<unknown>;
      updateDeviceLabel: (id: string, label: string | null) => Promise<unknown>;
      diagnostics: (options?: { maxHosts?: number }) => Promise<unknown>;
      onDevices: (callback: (devices: unknown) => void) => () => void;
      onSummary: (callback: (summary: unknown) => void) => () => void;
      settingsGet: () => Promise<unknown>;
      settingsUpdate: (provider: 'openai' | 'gemini' | 'claude', key: string | null) => Promise<unknown>;
      settingsUpdateAccent: (accentId: string | null) => Promise<unknown>;
      settingsUpdateAlerts: (patch: {
        osNotifications?: boolean;
        unknownOnly?: boolean;
        startupWarmupMs?: number;
        globalCooldownMs?: number;
        perDeviceCooldownMs?: number;
      }) => Promise<unknown>;
      settingsSetDeviceMuted: (deviceId: string, muted: boolean) => Promise<unknown>;
      settingsSetDeviceTrusted: (deviceId: string, trusted: boolean) => Promise<unknown>;
      settingsUpdateIntegration: (patch: { apiEnabled?: boolean; apiPort?: number }) => Promise<unknown>;
      settingsApiToken: () => Promise<unknown>;
      settingsRotateApiToken: () => Promise<unknown>;
      settingsTestNotification: () => Promise<unknown>;
      wakeDevice: (mac: string) => Promise<unknown>;
      systemInfo: () => Promise<unknown>;
      updateCheck: () => Promise<unknown>;
      updateStart: () => Promise<unknown>;
      updateStatus: () => Promise<unknown>;
      copyText: (value: string) => void;
    };
  }
}

export {};

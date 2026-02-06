/// <reference types="vite/client" />

declare global {
  interface Window {
    aneti?: {
      startScan: (options?: { intervalMs?: number; maxHosts?: number }) => Promise<unknown>;
      stopScan: () => Promise<void>;
      listDevices: () => Promise<unknown>;
      listStoredDevices: () => Promise<unknown>;
      listAlerts: (limit?: number) => Promise<unknown>;
      diagnostics: (options?: { maxHosts?: number }) => Promise<unknown>;
      onDevices: (callback: (devices: unknown) => void) => () => void;
    };
  }
}

export {};

/// <reference types="vite/client" />

declare global {
  interface Window {
    aneti?: {
      startScan: (options?: { intervalMs?: number }) => Promise<unknown>;
      stopScan: () => Promise<void>;
      listDevices: () => Promise<unknown>;
      onDevices: (callback: (devices: unknown) => void) => () => void;
    };
  }
}

export {};

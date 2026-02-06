import { randomUUID } from 'node:crypto';
import type { Device } from './types';

export type DeviceStatus = 'online' | 'offline';

type DevicesListener = (devices: Device[]) => void;

type ScannerOptions = {
  intervalMs?: number;
};

const now = () => Date.now();

const deviceId = (ip: string, mac?: string) => (mac ? `mac:${mac}` : `ip:${ip}`);

const seedDevices = (): Device[] => {
  const timestamp = now();
  return [
    {
      id: deviceId('192.168.1.1', 'AA:BB:CC:DD:EE:01'),
      ip: '192.168.1.1',
      mac: 'AA:BB:CC:DD:EE:01',
      hostname: 'gateway',
      vendor: 'NetGear',
      firstSeen: timestamp,
      lastSeen: timestamp,
      status: 'online',
      latencyMs: 2,
    },
    {
      id: deviceId('192.168.1.42', 'AA:BB:CC:DD:EE:42'),
      ip: '192.168.1.42',
      mac: 'AA:BB:CC:DD:EE:42',
      hostname: 'workstation',
      vendor: 'Apple',
      firstSeen: timestamp,
      lastSeen: timestamp,
      status: 'online',
      latencyMs: 8,
    },
  ];
};

export const createScanner = () => {
  let devices: Device[] = seedDevices();
  let timer: NodeJS.Timeout | null = null;
  const listeners = new Set<DevicesListener>();

  const emit = () => {
    for (const listener of listeners) {
      listener([...devices]);
    }
  };

  const simulateScan = () => {
    const timestamp = now();

    devices = devices.map((device) => {
      const jitter = Math.random() * 6 + 2;
      return {
        ...device,
        lastSeen: timestamp,
        latencyMs: Math.round(jitter),
        status: Math.random() > 0.05 ? 'online' : 'offline',
      };
    });

    if (Math.random() > 0.75) {
      const ip = `192.168.1.${Math.floor(Math.random() * 120) + 100}`;
      const mac = `AA:BB:CC:DD:EE:${Math.floor(Math.random() * 90 + 10)}`;
      devices = [
        ...devices,
        {
          id: deviceId(ip, mac),
          ip,
          mac,
          hostname: 'new-device',
          vendor: 'Unknown',
          firstSeen: timestamp,
          lastSeen: timestamp,
          status: 'online',
          latencyMs: Math.round(Math.random() * 10 + 5),
        },
      ];
    }

    emit();
  };

  const start = (options?: ScannerOptions) => {
    const intervalMs = options?.intervalMs ?? 8000;
    if (timer) return devices;
    timer = setInterval(simulateScan, intervalMs);
    emit();
    return devices;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const list = () => devices;

  const onDevices = (listener: DevicesListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    start,
    stop,
    list,
    onDevices,
  };
};

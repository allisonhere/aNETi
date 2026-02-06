import { randomUUID } from 'node:crypto';

export type DeviceStatus = 'online' | 'offline';

export type Device = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  firstSeen: number;
  lastSeen: number;
  status: DeviceStatus;
  latencyMs?: number;
};

type DevicesListener = (devices: Device[]) => void;

type ScannerOptions = {
  intervalMs?: number;
};

const now = () => Date.now();

const seedDevices = (): Device[] => [
  {
    id: randomUUID(),
    ip: '192.168.1.1',
    mac: 'AA:BB:CC:DD:EE:01',
    hostname: 'gateway',
    vendor: 'NetGear',
    firstSeen: now(),
    lastSeen: now(),
    status: 'online',
    latencyMs: 2,
  },
  {
    id: randomUUID(),
    ip: '192.168.1.42',
    mac: 'AA:BB:CC:DD:EE:42',
    hostname: 'workstation',
    vendor: 'Apple',
    firstSeen: now(),
    lastSeen: now(),
    status: 'online',
    latencyMs: 8,
  },
];

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
      devices = [
        ...devices,
        {
          id: randomUUID(),
          ip: `192.168.1.${Math.floor(Math.random() * 120) + 100}`,
          mac: `AA:BB:CC:DD:EE:${Math.floor(Math.random() * 90 + 10)}`,
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

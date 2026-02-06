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

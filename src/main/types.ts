export type DeviceStatus = 'online' | 'offline';

export type Device = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  mdnsName?: string;
  label?: string;
  securityState?: 'trusted' | 'anomaly' | null;
  firstSeen: number;
  lastSeen: number;
  status: DeviceStatus;
  latencyMs?: number;
  openPorts?: number[];
};

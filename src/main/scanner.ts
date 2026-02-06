import os from 'node:os';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Device } from './types';

export type DeviceStatus = 'online' | 'offline';

type DevicesListener = (devices: Device[]) => void;

type ScannerOptions = {
  intervalMs?: number;
  maxHosts?: number;
};

type Subnet = {
  cidr: string;
  network: number;
  broadcast: number;
  prefix: number;
};

const execFileAsync = promisify(execFile);
const now = () => Date.now();

const ipToInt = (ip: string) =>
  ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const intToIp = (value: number) =>
  [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');

const netmaskToPrefix = (mask: string) =>
  mask
    .split('.')
    .map((octet) => Number(octet).toString(2).padStart(8, '0'))
    .join('')
    .split('1').length - 1;

const detectSubnets = (): Subnet[] => {
  const subnets: Subnet[] = [];
  const nets = os.networkInterfaces();

  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const prefix = netmaskToPrefix(addr.netmask);
      const ipInt = ipToInt(addr.address);
      const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const network = ipInt & maskInt;
      const broadcast = network | (~maskInt >>> 0);
      subnets.push({
        cidr: `${intToIp(network)}/${prefix}`,
        network,
        broadcast,
        prefix,
      });
    }
  }

  return subnets;
};

const expandSubnet = (subnet: Subnet, maxHosts: number) => {
  const hosts: string[] = [];
  const start = subnet.network + 1;
  const end = subnet.broadcast - 1;
  const total = end - start + 1;
  const limit = Math.min(total, maxHosts);

  for (let i = 0; i < limit; i += 1) {
    hosts.push(intToIp(start + i));
  }

  return hosts;
};

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

const pingHost = async (ip: string) => {
  try {
    const platform = process.platform;
    const args = platform === 'win32'
      ? ['-n', '1', '-w', '1000', ip]
      : ['-c', '1', '-W', platform === 'darwin' ? '1000' : '1', ip];

    const { stdout } = await execFileAsync('ping', args, { timeout: 1500 });
    const output = stdout.toString();
    const timeMatch = output.match(/time[=<]([\d.]+)\s*ms/i);
    if (timeMatch) {
      const value = Number(timeMatch[1]);
      return Number.isFinite(value) ? Math.round(value) : 1;
    }
    return 1;
  } catch {
    return null;
  }
};

const parseArpOutput = (output: string) => {
  const map = new Map<string, string>();
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const linuxMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})/i);
    if (linuxMatch) {
      map.set(linuxMatch[1], linuxMatch[2]);
      continue;
    }
    const unixMatch = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{17})/i);
    if (unixMatch) {
      map.set(unixMatch[1], unixMatch[2]);
      continue;
    }
    const winMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})/i);
    if (winMatch) {
      map.set(winMatch[1], winMatch[2].replace(/-/g, ':'));
    }
  }
  return map;
};

const readNeighborTable = async () => {
  const commands: Array<[string, string[]]> = [
    ['ip', ['neigh']],
    ['arp', ['-a']],
  ];

  for (const [cmd, args] of commands) {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 2000 });
      const map = parseArpOutput(stdout.toString());
      if (map.size) return map;
    } catch {
      // ignore and try next
    }
  }

  return new Map<string, string>();
};

const resolveHostname = async (ip: string) => {
  try {
    const names = await withTimeout(dns.reverse(ip), 400);
    if (Array.isArray(names) && names.length > 0) {
      return names[0];
    }
  } catch {
    // ignore
  }
  return undefined;
};

const mapWithConcurrency = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await worker(items[current]);
    }
  });

  await Promise.all(runners);
  return results;
};

const deviceId = (ip: string, mac?: string) => (mac ? `mac:${mac}` : `ip:${ip}`);

export const createScanner = () => {
  let devices: Device[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  const listeners = new Set<DevicesListener>();
  const hostnameCache = new Map<string, string>();

  const emit = () => {
    for (const listener of listeners) {
      listener([...devices]);
    }
  };

  const scanOnce = async (options: ScannerOptions) => {
    const subnets = detectSubnets();
    if (subnets.length === 0) {
      return devices;
    }

    const maxHosts = options.maxHosts ?? 256;
    const hosts = subnets.flatMap((subnet) => expandSubnet(subnet, maxHosts));

    const pingResults = await mapWithConcurrency(hosts, 64, async (ip) => {
      const latency = await pingHost(ip);
      return { ip, latency };
    });

    const arpMap = await readNeighborTable();
    const seen = new Map<string, { latency?: number | null }>();

    for (const result of pingResults) {
      if (result.latency !== null) {
        seen.set(result.ip, { latency: result.latency });
      }
    }

    for (const [ip, _mac] of arpMap.entries()) {
      if (!seen.has(ip)) {
        seen.set(ip, { latency: null });
      }
    }

    const existingById = new Map(devices.map((device) => [device.id, device]));
    const existingByIp = new Map(devices.map((device) => [device.ip, device]));
    const timestamp = now();
    const next: Device[] = [];

    const hostnameLookups: Array<{ ip: string; target: Device }> = [];

    for (const [ip, meta] of seen.entries()) {
      const mac = arpMap.get(ip);
      const id = deviceId(ip, mac);
      const existing = existingById.get(id) ?? existingByIp.get(ip);

      const record: Device = {
        id,
        ip,
        mac: mac ?? existing?.mac,
        hostname: existing?.hostname,
        vendor: existing?.vendor,
        firstSeen: existing?.firstSeen ?? timestamp,
        lastSeen: timestamp,
        status: 'online',
        latencyMs: meta.latency ?? existing?.latencyMs,
      };

      if (!record.hostname && !hostnameCache.has(ip)) {
        hostnameLookups.push({ ip, target: record });
      } else if (!record.hostname && hostnameCache.has(ip)) {
        record.hostname = hostnameCache.get(ip);
      }

      next.push(record);
    }

    const toLookup = hostnameLookups.slice(0, 8);
    await mapWithConcurrency(toLookup, 4, async ({ ip, target }) => {
      const hostname = await resolveHostname(ip);
      if (hostname) {
        hostnameCache.set(ip, hostname);
        target.hostname = hostname;
      }
      return null;
    });

    const offlineAfter = (options.intervalMs ?? 8000) * 2;
    for (const device of devices) {
      if (!next.find((candidate) => candidate.id === device.id)) {
        if (timestamp - device.lastSeen < offlineAfter) {
          next.push({ ...device, status: 'offline' });
        }
      }
    }

    return next.sort((a, b) => b.lastSeen - a.lastSeen);
  };

  const start = (options: ScannerOptions = {}) => {
    if (timer) return devices;

    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        devices = await scanOnce(options);
        emit();
      } finally {
        inFlight = false;
      }
    };

    void run();
    timer = setInterval(run, options.intervalMs ?? 8000);
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

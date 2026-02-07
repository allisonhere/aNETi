import os from 'node:os';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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
  localIp: string;
  localIpInt: number;
};

type InterfaceInfo = { name: string; ip: string; netmask: string; family: string };

type ScannerDiagnostics = {
  interfaces: InterfaceInfo[];
  ipv4Interfaces: InterfaceInfo[];
  subnets: string[];
  hostCount: number;
  tools: {
    ping: boolean;
    ip: boolean;
    arp: boolean;
    procArp: boolean;
  };
};

type EnrichmentPlan = {
  hostnameLookups: Array<{ ip: string; id: string }>;
  vendorTargets: Map<string, string[]>;
};

type ScanResult = {
  devices: Device[];
  enrichment: EnrichmentPlan;
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

const getInterfaces = () => {
  const nets = os.networkInterfaces();
  const results: InterfaceInfo[] = [];

  for (const [name, iface] of Object.entries(nets)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.internal) continue;
      results.push({
        name,
        ip: addr.address,
        netmask: addr.netmask,
        family: addr.family,
      });
    }
  }

  return results;
};

const getIpv4Interfaces = (interfaces: InterfaceInfo[]) =>
  interfaces.filter((iface) => iface.family === 'IPv4');

const detectSubnets = (interfaces: InterfaceInfo[]): Subnet[] => {
  const subnets: Subnet[] = [];
  for (const addr of interfaces) {
    const prefix = netmaskToPrefix(addr.netmask);
    const ipInt = ipToInt(addr.ip);
    const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const network = ipInt & maskInt;
    const broadcast = network | (~maskInt >>> 0);
    subnets.push({
      cidr: `${intToIp(network)}/${prefix}`,
      network,
      broadcast,
      prefix,
      localIp: addr.ip,
      localIpInt: ipInt,
    });
  }

  return subnets;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const expandSubnet = (subnet: Subnet, maxHosts: number) => {
  const hosts: string[] = [];
  const start = subnet.network + 1;
  const end = subnet.broadcast - 1;
  const total = Math.max(0, end - start + 1);
  const limit = Math.min(total, maxHosts);

  if (limit <= 0) return hosts;

  let rangeStart = start;
  if (total > limit) {
    const half = Math.floor(limit / 2);
    rangeStart = clamp(subnet.localIpInt - half, start, end - limit + 1);
  }

  for (let i = 0; i < limit; i += 1) {
    hosts.push(intToIp(rangeStart + i));
  }

  return hosts;
};

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

const pingCandidates = process.platform === 'win32'
  ? ['ping']
  : ['ping', '/usr/bin/ping', '/bin/ping', '/usr/sbin/ping', '/sbin/ping'];

const ipCandidates = process.platform === 'win32'
  ? []
  : ['ip', '/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip'];

const arpCandidates = process.platform === 'win32'
  ? ['arp']
  : ['arp', '/usr/sbin/arp', '/sbin/arp', '/usr/bin/arp'];

const pathHasExecutable = (cmd: string) => {
  if (cmd.includes('/')) {
    return existsSync(cmd);
  }
  const pathEnv = process.env.PATH ?? '';
  return pathEnv.split(delimiter).some((segment) => existsSync(join(segment, cmd)));
};

const hasAnyExecutable = (candidates: string[]) => candidates.some(pathHasExecutable);

const execFirstAvailable = async (candidates: string[], args: string[], timeout: number) => {
  let lastError: unknown;
  for (const cmd of candidates) {
    try {
      return await execFileAsync(cmd, args, { timeout });
    } catch (error: any) {
      lastError = error;
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw lastError ?? new Error('command not found');
};

const pingHost = async (ip: string) => {
  try {
    const platform = process.platform;
    const args = platform === 'win32'
      ? ['-n', '1', '-w', '1000', ip]
      : ['-c', '1', '-W', platform === 'darwin' ? '1000' : '1', ip];

    const { stdout } = await execFirstAvailable(pingCandidates, args, 1500);
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
  const commands: Array<[string[], string[]]> = [
    [ipCandidates, ['neigh']],
    [arpCandidates, ['-a']],
  ];

  for (const [candidateList, args] of commands) {
    for (const cmd of candidateList) {
      try {
        const { stdout } = await execFileAsync(cmd, args, { timeout: 2000 });
        const map = parseArpOutput(stdout.toString());
        if (map.size) return map;
      } catch {
        // ignore and try next
      }
    }
  }

  if (process.platform === 'linux' && existsSync('/proc/net/arp')) {
    try {
      const output = readFileSync('/proc/net/arp', 'utf8');
      const map = new Map<string, string>();
      const lines = output.split(/\r?\n/).slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const ip = parts[0];
        const mac = parts[3];
        if (!ip || !mac || mac === '00:00:00:00:00:00') continue;
        map.set(ip, mac.toLowerCase());
      }
      if (map.size) return map;
    } catch {
      // ignore
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

const normalizeMac = (mac?: string) => (mac ? mac.toLowerCase().replace(/[^0-9a-f]/g, '') : undefined);
const macPrefix = (mac?: string) => (mac && mac.length >= 6 ? mac.slice(0, 6) : undefined);
const formatMacPrefix = (prefix: string) => prefix.match(/.{1,2}/g)?.join(':') ?? prefix;

const vendorCache = new Map<string, string | null>();
let lastVendorRequestAt = 0;
const vendorRateLimitMs = 1100;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchVendor = async (prefix: string) => {
  const formatted = formatMacPrefix(prefix);
  const elapsed = Date.now() - lastVendorRequestAt;
  if (elapsed < vendorRateLimitMs) {
    await delay(vendorRateLimitMs - elapsed);
  }
  lastVendorRequestAt = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`https://api.macvendors.com/${formatted}`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const text = (await response.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

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

  const applyDeviceUpdates = (updates: Map<string, Partial<Device>>) => {
    if (updates.size === 0) return;
    let changed = false;
    const next = devices.map((device) => {
      const update = updates.get(device.id);
      if (!update) return device;
      const updated = { ...device, ...update };
      if (updated.hostname !== device.hostname || updated.vendor !== device.vendor) {
        changed = true;
      }
      return updated;
    });
    if (changed) {
      devices = next;
      emit();
    }
  };

  const enrichDevices = async (plan: EnrichmentPlan) => {
    const { hostnameLookups, vendorTargets } = plan;

    if (hostnameLookups.length > 0) {
      const toLookup = hostnameLookups.slice(0, 8);
      const hostnameUpdates = new Map<string, Partial<Device>>();

      await mapWithConcurrency(toLookup, 4, async ({ ip, id }) => {
        const hostname = await resolveHostname(ip);
        if (hostname) {
          hostnameCache.set(ip, hostname);
          hostnameUpdates.set(id, { hostname });
        }
        return null;
      });

      applyDeviceUpdates(hostnameUpdates);
    }

    if (vendorTargets.size > 0) {
      const prefixes = Array.from(vendorTargets.keys());
      const vendorUpdates = new Map<string, Partial<Device>>();

      await mapWithConcurrency(prefixes, 2, async (prefix) => {
        const vendor = await fetchVendor(prefix);
        vendorCache.set(prefix, vendor);
        if (vendor) {
          const ids = vendorTargets.get(prefix) ?? [];
          for (const id of ids) {
            vendorUpdates.set(id, { vendor });
          }
        }
        return null;
      });

      applyDeviceUpdates(vendorUpdates);
    }
  };

  const scanOnce = async (options: ScannerOptions): Promise<ScanResult> => {
    const interfaces = getInterfaces();
    const localInterfaces = getIpv4Interfaces(interfaces);
    const subnets = detectSubnets(localInterfaces);

    if (subnets.length === 0) {
      const timestamp = now();
      const fallbackInterfaces = localInterfaces.length > 0
        ? localInterfaces
        : interfaces.filter((iface) => iface.family === 'IPv6');
      return {
        devices: fallbackInterfaces.map((iface) => ({
          id: deviceId(iface.ip),
          ip: iface.ip,
          hostname: os.hostname(),
          firstSeen: timestamp,
          lastSeen: timestamp,
          status: 'online',
          latencyMs: 0,
        })),
        enrichment: { hostnameLookups: [], vendorTargets: new Map() },
      };
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

    for (const subnet of subnets) {
      if (!seen.has(subnet.localIp)) {
        seen.set(subnet.localIp, { latency: 0 });
      }
    }

    for (const iface of localInterfaces) {
      if (!seen.has(iface.ip)) {
        seen.set(iface.ip, { latency: 0 });
      }
    }

    const existingById = new Map(devices.map((device) => [device.id, device]));
    const existingByIp = new Map(devices.map((device) => [device.ip, device]));
    const timestamp = now();
    const next: Device[] = [];

    const hostnameLookups: Array<{ ip: string; id: string }> = [];

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
        hostnameLookups.push({ ip, id: record.id });
      } else if (!record.hostname && hostnameCache.has(ip)) {
        record.hostname = hostnameCache.get(ip);
      }

      next.push(record);
    }

    const vendorTargets = new Map<string, string[]>();
    for (const device of next) {
      if (device.vendor || !device.mac) continue;
      const normalized = normalizeMac(device.mac);
      const prefix = macPrefix(normalized);
      if (!prefix) continue;
      if (vendorCache.has(prefix)) {
        const cached = vendorCache.get(prefix);
        if (cached) device.vendor = cached;
        continue;
      }
      const list = vendorTargets.get(prefix) ?? [];
      list.push(device.id);
      vendorTargets.set(prefix, list);
    }

    const offlineAfter = (options.intervalMs ?? 8000) * 2;
    for (const device of devices) {
      if (!next.find((candidate) => candidate.id === device.id)) {
        if (timestamp - device.lastSeen < offlineAfter) {
          next.push({ ...device, status: 'offline' });
        }
      }
    }

    return {
      devices: next.sort((a, b) => b.lastSeen - a.lastSeen),
      enrichment: { hostnameLookups, vendorTargets },
    };
  };

  const diagnostics = (options: ScannerOptions = {}): ScannerDiagnostics => {
    const interfaces = getInterfaces();
    const ipv4Interfaces = getIpv4Interfaces(interfaces);
    const subnets = detectSubnets(ipv4Interfaces);
    const maxHosts = options.maxHosts ?? 256;
    const hosts = subnets.flatMap((subnet) => expandSubnet(subnet, maxHosts));

    return {
      interfaces,
      ipv4Interfaces,
      subnets: subnets.map((subnet) => subnet.cidr),
      hostCount: hosts.length,
      tools: {
        ping: hasAnyExecutable(pingCandidates),
        ip: hasAnyExecutable(ipCandidates),
        arp: hasAnyExecutable(arpCandidates),
        procArp: process.platform === 'linux' && existsSync('/proc/net/arp'),
      },
    };
  };

  const start = (options: ScannerOptions = {}) => {
    if (timer) return devices;

    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await scanOnce(options);
        devices = result.devices;
        emit();
        void enrichDevices(result.enrichment);
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
    diagnostics,
  };
};

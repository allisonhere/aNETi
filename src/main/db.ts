import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

export type DeviceRecord = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  mdnsName?: string;
  label?: string;
  firstSeen: number;
  lastSeen: number;
  status: 'online' | 'offline';
  latencyMs?: number | null;
  openPorts?: number[];
};

export type AlertRecord = {
  id: number;
  type: string;
  message: string;
  deviceId?: string | null;
  createdAt: number;
  acknowledgedAt?: number | null;
};

const createMemoryDatabase = () => {
  const deviceMap = new Map<string, DeviceRecord>();
  const alerts: AlertRecord[] = [];
  const sightings: Array<{
    id: number;
    deviceId: string;
    seenAt: number;
    ip: string;
    latencyMs?: number | null;
    status: 'online' | 'offline';
  }> = [];
  let alertId = 1;
  let sightingId = 1;

  const syncDevices = (devices: DeviceRecord[]) => {
    for (const device of devices) {
      const existing = deviceMap.get(device.id);
      const label = device.label ?? existing?.label;
      const mdnsName = device.mdnsName ?? existing?.mdnsName;
      const openPorts = device.openPorts ?? existing?.openPorts;
      deviceMap.set(device.id, { ...existing, ...device, label, mdnsName, openPorts });
      sightings.unshift({
        id: sightingId++,
        deviceId: device.id,
        seenAt: device.lastSeen,
        ip: device.ip,
        latencyMs: device.latencyMs ?? null,
        status: device.status,
      });
    }
  };

  const listDevices = () => Array.from(deviceMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);

  const addAlert = (alert: Omit<AlertRecord, 'id'>) => {
    alerts.unshift({ ...alert, id: alertId++ });
  };

  const listAlerts = (limit = 50) => alerts.slice(0, limit);

  const listSightingsByDevice = (deviceId: string, limit = 50) =>
    sightings.filter((item) => item.deviceId === deviceId).slice(0, limit);

  return {
    db: null,
    syncDevices,
    listDevices,
    addAlert,
    listAlerts,
    listSightingsByDevice,
    updateDeviceLabel: (id: string, label: string | null) => {
      const existing = deviceMap.get(id);
      if (!existing) return null;
      const normalized = label && label.trim().length > 0 ? label.trim() : null;
      const next = { ...existing, label: normalized ?? undefined };
      deviceMap.set(id, next);
      return { id, label: normalized };
    },
  };
};

export const createDatabase = async (dbPath: string) => {
  const require = createRequire(import.meta.url);
  let initSqlJs: any = null;

  try {
    initSqlJs = require('sql.js');
  } catch (error) {
    console.warn('sql.js not available, using in-memory store.', error);
  }

  if (!initSqlJs) {
    return createMemoryDatabase();
  }

  let SQL: any;
  try {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await initSqlJs({ locateFile: () => wasmPath });
  } catch (error) {
    console.warn('sql.js WASM init failed, using in-memory store.', error);
    return createMemoryDatabase();
  }

  let db: any;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    if (existsSync(dbPath)) {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
  } catch (error) {
    console.warn('sql.js failed to open database, using in-memory store.', error);
    return createMemoryDatabase();
  }

  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');

  const saveToDisk = () => {
    try {
      const data = db.export();
      writeFileSync(dbPath, Buffer.from(data));
    } catch (error) {
      console.error('Failed to save database to disk:', error);
    }
  };

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      mac TEXT,
      hostname TEXT,
      vendor TEXT,
      mdns_name TEXT,
      label TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sightings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      ip TEXT NOT NULL,
      latency_ms INTEGER,
      status TEXT,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_sightings_device ON sightings(device_id);');
  db.run('CREATE INDEX IF NOT EXISTS idx_sightings_seen_at ON sightings(seen_at);');
  db.run('CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);');

  const ensureColumn = (table: string, name: string, type: string) => {
    const result = db.exec(`PRAGMA table_info('${table}');`);
    const columns: string[] = result.length > 0
      ? result[0].values.map((row: any[]) => row[1])
      : [];
    if (!columns.includes(name)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type};`);
    }
  };

  ensureColumn('devices', 'label', 'TEXT');
  ensureColumn('devices', 'mdns_name', 'TEXT');
  ensureColumn('devices', 'open_ports', 'TEXT');
  ensureColumn('sightings', 'status', 'TEXT');

  saveToDisk();

  const syncDevices = (devices: DeviceRecord[]) => {
    const now = Date.now();
    db.run('BEGIN TRANSACTION;');
    try {
      for (const device of devices) {
        db.run(
          `INSERT INTO devices (
            id, ip, mac, hostname, vendor, mdns_name, label, first_seen, last_seen, status, latency_ms, open_ports
          ) VALUES (
            $id, $ip, $mac, $hostname, $vendor, $mdnsName, $label, $firstSeen, $lastSeen, $status, $latencyMs, $openPorts
          )
          ON CONFLICT(id) DO UPDATE SET
            ip = excluded.ip,
            mac = excluded.mac,
            hostname = excluded.hostname,
            vendor = excluded.vendor,
            mdns_name = COALESCE(excluded.mdns_name, devices.mdns_name),
            label = COALESCE(excluded.label, devices.label),
            last_seen = excluded.last_seen,
            status = excluded.status,
            latency_ms = excluded.latency_ms,
            open_ports = COALESCE(excluded.open_ports, devices.open_ports);`,
          {
            $id: device.id,
            $ip: device.ip,
            $mac: device.mac ?? null,
            $hostname: device.hostname ?? null,
            $vendor: device.vendor ?? null,
            $mdnsName: device.mdnsName ?? null,
            $label: device.label ?? null,
            $firstSeen: device.firstSeen ?? now,
            $lastSeen: device.lastSeen ?? now,
            $status: device.status,
            $latencyMs: device.latencyMs ?? null,
            $openPorts: device.openPorts ? JSON.stringify(device.openPorts) : null,
          }
        );

        db.run(
          `INSERT INTO sightings (device_id, seen_at, ip, latency_ms, status)
          VALUES ($deviceId, $seenAt, $ip, $latencyMs, $status);`,
          {
            $deviceId: device.id,
            $seenAt: device.lastSeen ?? now,
            $ip: device.ip,
            $latencyMs: device.latencyMs ?? null,
            $status: device.status,
          }
        );
      }
      db.run('COMMIT;');
    } catch (error) {
      db.run('ROLLBACK;');
      throw error;
    }
    saveToDisk();
  };

  const queryAll = (sql: string, params?: any): any[] => {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  };

  const listDevices = (): DeviceRecord[] => {
    const rows = queryAll(
      `SELECT id, ip, mac, hostname, vendor, mdns_name as mdnsName, label,
              first_seen as firstSeen, last_seen as lastSeen, status, latency_ms as latencyMs,
              open_ports as openPortsJson
       FROM devices ORDER BY last_seen DESC;`
    );
    return rows.map((row: any) => {
      const { openPortsJson, ...rest } = row;
      const openPorts = openPortsJson ? JSON.parse(openPortsJson) : undefined;
      return { ...rest, openPorts };
    });
  };

  const listSightingsByDevice = (deviceId: string, limit = 50) =>
    queryAll(
      `SELECT id, device_id as deviceId, seen_at as seenAt, ip, latency_ms as latencyMs, status
       FROM sightings WHERE device_id = $deviceId ORDER BY seen_at DESC LIMIT $limit;`,
      { $deviceId: deviceId, $limit: limit }
    );

  const addAlert = (alert: Omit<AlertRecord, 'id'>) => {
    db.run(
      `INSERT INTO alerts (type, message, device_id, created_at, acknowledged_at)
       VALUES ($type, $message, $deviceId, $createdAt, $acknowledgedAt);`,
      {
        $type: alert.type,
        $message: alert.message,
        $deviceId: alert.deviceId ?? null,
        $createdAt: alert.createdAt,
        $acknowledgedAt: alert.acknowledgedAt ?? null,
      }
    );
    saveToDisk();
  };

  const listAlerts = (limit = 50): AlertRecord[] =>
    queryAll(
      `SELECT id, type, message, device_id as deviceId, created_at as createdAt,
              acknowledged_at as acknowledgedAt
       FROM alerts ORDER BY created_at DESC LIMIT $limit;`,
      { $limit: limit }
    );

  const updateDeviceLabel = (id: string, label: string | null) => {
    const normalized = label && label.trim().length > 0 ? label.trim() : null;
    db.run('UPDATE devices SET label = $label WHERE id = $id;', {
      $id: id,
      $label: normalized,
    });
    saveToDisk();
    return { id, label: normalized };
  };

  return {
    db,
    syncDevices,
    listDevices,
    addAlert,
    listAlerts,
    listSightingsByDevice,
    updateDeviceLabel,
  };
};

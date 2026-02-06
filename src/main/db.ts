import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

export type DeviceRecord = {
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  firstSeen: number;
  lastSeen: number;
  status: 'online' | 'offline';
  latencyMs?: number | null;
};

export type AlertRecord = {
  id: number;
  type: string;
  message: string;
  deviceId?: string | null;
  createdAt: number;
  acknowledgedAt?: number | null;
};

export const createDatabase = (dbPath: string) => {
  const require = createRequire(import.meta.url);
  let Sqlite: any = null;

  try {
    Sqlite = require('better-sqlite3');
  } catch (error) {
    console.warn('better-sqlite3 not available, using in-memory store.', error);
  }

  if (!Sqlite) {
    const deviceMap = new Map<string, DeviceRecord>();
    const alerts: AlertRecord[] = [];
    let alertId = 1;

    const syncDevices = (devices: DeviceRecord[]) => {
      for (const device of devices) {
        deviceMap.set(device.id, { ...device });
      }
    };

    const listDevices = () => Array.from(deviceMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);

    const addAlert = (alert: Omit<AlertRecord, 'id'>) => {
      alerts.unshift({ ...alert, id: alertId++ });
    };

    const listAlerts = (limit = 50) => alerts.slice(0, limit);

    return {
      db: null,
      syncDevices,
      listDevices,
      addAlert,
      listAlerts,
    };
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Sqlite(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      ip TEXT NOT NULL,
      mac TEXT,
      hostname TEXT,
      vendor TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS sightings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      ip TEXT NOT NULL,
      latency_ms INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sightings_device ON sightings(device_id);
    CREATE INDEX IF NOT EXISTS idx_sightings_seen_at ON sightings(seen_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `);

  const upsertDeviceStmt = db.prepare(`
    INSERT INTO devices (
      id, ip, mac, hostname, vendor, first_seen, last_seen, status, latency_ms
    ) VALUES (
      @id, @ip, @mac, @hostname, @vendor, @firstSeen, @lastSeen, @status, @latencyMs
    )
    ON CONFLICT(id) DO UPDATE SET
      ip = excluded.ip,
      mac = excluded.mac,
      hostname = excluded.hostname,
      vendor = excluded.vendor,
      last_seen = excluded.last_seen,
      status = excluded.status,
      latency_ms = excluded.latency_ms;
  `);

  const insertSightingStmt = db.prepare(`
    INSERT INTO sightings (device_id, seen_at, ip, latency_ms)
    VALUES (@deviceId, @seenAt, @ip, @latencyMs);
  `);

  const insertAlertStmt = db.prepare(`
    INSERT INTO alerts (type, message, device_id, created_at, acknowledged_at)
    VALUES (@type, @message, @deviceId, @createdAt, @acknowledgedAt);
  `);

  const listDevicesStmt = db.prepare(`
    SELECT id, ip, mac, hostname, vendor, first_seen as firstSeen, last_seen as lastSeen, status, latency_ms as latencyMs
    FROM devices
    ORDER BY last_seen DESC;
  `);

  const listAlertsStmt = db.prepare(`
    SELECT id, type, message, device_id as deviceId, created_at as createdAt, acknowledged_at as acknowledgedAt
    FROM alerts
    ORDER BY created_at DESC
    LIMIT ?;
  `);

  const syncDevices = (devices: DeviceRecord[]) => {
    const now = Date.now();
    const tx = db.transaction((items: DeviceRecord[]) => {
      for (const device of items) {
        upsertDeviceStmt.run({
          id: device.id,
          ip: device.ip,
          mac: device.mac ?? null,
          hostname: device.hostname ?? null,
          vendor: device.vendor ?? null,
          firstSeen: device.firstSeen ?? now,
          lastSeen: device.lastSeen ?? now,
          status: device.status,
          latencyMs: device.latencyMs ?? null,
        });

        insertSightingStmt.run({
          deviceId: device.id,
          seenAt: device.lastSeen ?? now,
          ip: device.ip,
          latencyMs: device.latencyMs ?? null,
        });
      }
    });

    tx(devices);
  };

  const listDevices = (): DeviceRecord[] => listDevicesStmt.all();

  const addAlert = (alert: Omit<AlertRecord, 'id'>) => {
    insertAlertStmt.run({
      type: alert.type,
      message: alert.message,
      deviceId: alert.deviceId ?? null,
      createdAt: alert.createdAt,
      acknowledgedAt: alert.acknowledgedAt ?? null,
    });
  };

  const listAlerts = (limit = 50): AlertRecord[] => listAlertsStmt.all(limit);

  return {
    db,
    syncDevices,
    listDevices,
    addAlert,
    listAlerts,
  };
};

import { Notification, app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createScanner } from './scanner';
import { createDatabase } from './db';
import { createSettingsStore, type ProviderId } from './settings';
import { createAiClient } from './ai';
import type { Device } from './types';

let mainWindow: BrowserWindow | null = null;
const scanner = createScanner();
let db: ReturnType<typeof createDatabase> | null = null;
let settings: ReturnType<typeof createSettingsStore> | null = null;
let ai: ReturnType<typeof createAiClient> | null = null;
const baselineDeviceIds = new Set<string>();
const lastStatusById = new Map<string, Device['status']>();
const lastSummaryAtById = new Map<string, number>();
const lastSeenById = new Map<string, number>();
const labelById = new Map<string, string>();
const aiQueue: Device[] = [];
let aiWorking = false;
const aiSummaryCooldownMs = 60_000;
const aiReappearThresholdMs = 20_000;
const lastAlertAtById = new Map<string, number>();
const lastSecurityAlertAtById = new Map<string, number>();
let lastGlobalAlertAt = 0;
let alertWarmupUntil = 0;
const securityAlertCooldownMs = 5 * 60_000;

const processAiQueue = async () => {
  if (aiWorking || !ai) return;
  aiWorking = true;

  try {
    while (aiQueue.length > 0) {
      const device = aiQueue.shift();
      if (!device) continue;
      const snapshot = scanner.list();
      const onlineDevices = snapshot.filter((item) => item.status === 'online').length;
      const totalDevices = snapshot.length;
      const detectedAt = device.lastSeen ?? Date.now();

      const summary = await ai.summarizeNewDevice({
        device,
        totalDevices,
        onlineDevices,
        detectedAt,
      });

      if (!summary) continue;
      const createdAt = Date.now();
      db?.addAlert({
        type: 'ai_summary',
        message: summary.text,
        deviceId: device.id,
        createdAt,
      });
      mainWindow?.webContents.send('ai:summary', {
        ...summary,
        deviceId: device.id,
        createdAt,
      });
    }
  } finally {
    aiWorking = false;
  }
};

const resolvePreloadPath = () => {
  const envPreload = process.env.ELECTRON_PRELOAD;
  if (envPreload) {
    const resolved = envPreload.startsWith('/')
      ? envPreload
      : join(process.cwd(), envPreload);
    if (existsSync(resolved)) {
      console.log('Using preload from ELECTRON_PRELOAD:', resolved);
      return resolved;
    }
  }

  const preloadCandidates = [
    join(__dirname, '../preload/index.cjs'),
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js'),
    join(process.cwd(), 'out/preload/index.cjs'),
    join(process.cwd(), 'out/preload/index.mjs'),
    join(process.cwd(), 'out/preload/index.js'),
    join(app.getAppPath(), 'out/preload/index.cjs'),
    join(app.getAppPath(), 'out/preload/index.mjs'),
    join(app.getAppPath(), 'out/preload/index.js'),
  ];
  const preloadPath = preloadCandidates.find((candidate) => existsSync(candidate));
  if (!preloadPath) {
    console.error('Preload not found. Tried:', preloadCandidates);
  } else {
    console.log('Using preload:', preloadPath);
  }
  return preloadPath;
};

const createMainWindow = () => {
  const preloadPath = resolvePreloadPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0b1020',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents
      .executeJavaScript('window.anetiMeta')
      .then((value) => {
        console.log('Renderer preload meta:', value);
      })
      .catch((error) => {
        console.log('Renderer preload meta check failed:', error);
      });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  scanner.onDevices((devices) => {
    const alertPrefs = settings?.getAlerts();
    const securityPrefs = settings?.getSecurity();
    const trustedIds = new Set(securityPrefs?.trustedDeviceIds ?? []);
    const labeledDevices = (devices as Device[]).map((device) => {
      const label = labelById.get(device.id);
      return {
        ...device,
        label: label ?? device.label,
        securityState: trustedIds.has(device.id) ? 'trusted' : null,
      };
    });

    db?.syncDevices(labeledDevices as Device[]);
    mainWindow?.webContents.send('scanner:devices', labeledDevices);

    const now = Date.now();
    const perDeviceCooldownMs = alertPrefs?.perDeviceCooldownMs ?? 60_000;
    const globalCooldownMs = alertPrefs?.globalCooldownMs ?? 20_000;
    const osAlertCandidates: Device[] = [];

    for (const device of labeledDevices as Device[]) {
      const prevStatus = lastStatusById.get(device.id);
      const prevSeen = lastSeenById.get(device.id);
      lastStatusById.set(device.id, device.status);
      lastSeenById.set(device.id, device.lastSeen ?? now);

      if (device.status !== 'online') continue;

      const isNew = !baselineDeviceIds.has(device.id) && prevStatus === undefined;
      const cameOnline = prevStatus !== undefined && prevStatus !== 'online';
      const reappeared =
        prevSeen !== undefined && (device.lastSeen ?? now) - prevSeen >= aiReappearThresholdMs;
      const lastSummaryAt = lastSummaryAtById.get(device.id) ?? 0;
      const lastAlertAt = lastAlertAtById.get(device.id) ?? 0;
      const lastSecurityAlertAt = lastSecurityAlertAtById.get(device.id) ?? 0;
      const isMuted = alertPrefs?.mutedDeviceIds.includes(device.id) ?? false;
      const isDiscoveryEvent = isNew || cameOnline || reappeared;
      const isInStartupWarmup = now < alertWarmupUntil;
      const isTrusted = trustedIds.has(device.id);

      if (isNew && !isTrusted) {
        device.securityState = 'anomaly';
        if (now - lastSecurityAlertAt >= securityAlertCooldownMs) {
          lastSecurityAlertAtById.set(device.id, now);
          db?.addAlert({
            type: 'security_anomaly',
            message: `Untrusted new device detected: ${device.label ?? device.hostname ?? device.ip} (${device.ip})`,
            deviceId: device.id,
            createdAt: now,
          });
        }
      }

      const shouldNotify =
        Boolean(alertPrefs?.osNotifications) &&
        !isMuted &&
        now - lastAlertAt >= perDeviceCooldownMs &&
        !isInStartupWarmup &&
        (alertPrefs?.unknownOnly ? isNew : isDiscoveryEvent);

      if (shouldNotify) {
        lastAlertAtById.set(device.id, now);
        osAlertCandidates.push(device);
      }

      if ((isNew || cameOnline || reappeared) && now - lastSummaryAt >= aiSummaryCooldownMs) {
        lastSummaryAtById.set(device.id, now);
        baselineDeviceIds.add(device.id);
        aiQueue.push(device);
      }
    }

    if (
      osAlertCandidates.length > 0 &&
      Notification.isSupported() &&
      now - lastGlobalAlertAt >= globalCooldownMs
    ) {
      lastGlobalAlertAt = now;
      const title =
        osAlertCandidates.length > 1 ? 'AnetI alert summary' : 'AnetI alert';
      const body =
        osAlertCandidates.length > 1
          ? `${osAlertCandidates.length} discovery events detected. Open AnetI for details.`
          : `Device detected: ${
              osAlertCandidates[0].label ??
              osAlertCandidates[0].hostname ??
              osAlertCandidates[0].mdnsName ??
              osAlertCandidates[0].ip
            } (${osAlertCandidates[0].ip})`;

      const notification = new Notification({
        title,
        body,
        silent: false,
      });
      notification.on('click', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      });
      notification.show();
    }

    void processAiQueue();
  });
};

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'aneti.sqlite');
  db = createDatabase(dbPath);
  settings = createSettingsStore(join(app.getPath('userData'), 'settings.json'));
  ai = createAiClient((provider) => settings?.getSecret(provider));
  alertWarmupUntil = Date.now() + (settings?.getAlerts().startupWarmupMs ?? 45_000);

  ipcMain.on('preload:ready', (_event, payload) => {
    console.log('Preload ready:', payload);
  });

  createMainWindow();

  ipcMain.handle('scanner:start', (_event, options) => scanner.start(options));
  ipcMain.handle('scanner:stop', () => scanner.stop());
  ipcMain.handle('scanner:list', () => scanner.list());
  ipcMain.handle('scanner:diagnostics', (_event, options) => scanner.diagnostics(options));
  ipcMain.handle('db:devices', () => db?.listDevices() ?? []);
  ipcMain.handle('db:alerts', (_event, limit?: number) => db?.listAlerts(limit ?? 50) ?? []);
  ipcMain.handle('db:sightings', (_event, deviceId: string, limit?: number) =>
    db?.listSightingsByDevice(deviceId, limit ?? 30) ?? []
  );
  ipcMain.handle('db:label', (_event, id: string, label: string | null) => {
    if (!db) return null;
    const normalized = label && label.trim().length > 0 ? label.trim() : null;
    const result = db.updateDeviceLabel(id, normalized);
    if (normalized) {
      labelById.set(id, normalized);
    } else {
      labelById.delete(id);
    }
    return result;
  });
  ipcMain.handle('settings:get', () => settings?.getPublic() ?? null);
  ipcMain.handle('settings:update', (_event, provider: ProviderId, key: string | null) =>
    settings?.updateProvider(provider, key) ?? null
  );
  ipcMain.handle('settings:accent', (_event, accentId: string | null) =>
    settings?.updateAccent(accentId) ?? null
  );
  ipcMain.handle(
    'settings:alerts',
    (
      _event,
      patch: {
        osNotifications?: boolean;
        unknownOnly?: boolean;
        startupWarmupMs?: number;
        globalCooldownMs?: number;
        perDeviceCooldownMs?: number;
      }
    ) => {
      const updated = settings?.updateAlerts(patch) ?? null;
      if (updated) {
        const warmup = updated.alerts.startupWarmupMs ?? 45_000;
        alertWarmupUntil = Date.now() + warmup;
      }
      return updated;
    }
  );
  ipcMain.handle('settings:mute-device', (_event, deviceId: string, muted: boolean) =>
    settings?.setDeviceMuted(deviceId, muted) ?? null
  );
  ipcMain.handle('settings:trust-device', (_event, deviceId: string, trusted: boolean) =>
    settings?.setDeviceTrusted(deviceId, trusted) ?? null
  );
  ipcMain.handle('settings:test-notification', () => {
    if (!Notification.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    const notification = new Notification({
      title: 'AnetI test alert',
      body: 'Notifications are working.',
      silent: false,
    });
    notification.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    });
    notification.show();
    return { ok: true };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  const seedKnownDevices = () => {
    const existing = db?.listDevices() ?? [];
    for (const device of existing as Device[]) {
      baselineDeviceIds.add(device.id);
      if (device.label) {
        labelById.set(device.id, device.label);
      }
    }
  };

  seedKnownDevices();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

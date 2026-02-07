import { app, BrowserWindow, ipcMain, shell } from 'electron';
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
const aiQueue: Device[] = [];
let aiWorking = false;
const aiSummaryCooldownMs = 60_000;
const aiReappearThresholdMs = 20_000;

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
    db?.syncDevices(devices as Device[]);
    mainWindow?.webContents.send('scanner:devices', devices);

    const now = Date.now();
    for (const device of devices as Device[]) {
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

      if ((isNew || cameOnline || reappeared) && now - lastSummaryAt >= aiSummaryCooldownMs) {
        lastSummaryAtById.set(device.id, now);
        baselineDeviceIds.add(device.id);
        aiQueue.push(device);
      }
    }

    void processAiQueue();
  });
};

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'aneti.sqlite');
  db = createDatabase(dbPath);
  settings = createSettingsStore(join(app.getPath('userData'), 'settings.json'));
  ai = createAiClient((provider) => settings?.getSecret(provider));

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
  ipcMain.handle('settings:get', () => settings?.getPublic() ?? null);
  ipcMain.handle('settings:update', (_event, provider: ProviderId, key: string | null) =>
    settings?.updateProvider(provider, key) ?? null
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  const seedKnownDevices = () => {
    const existing = db?.listDevices() ?? [];
    for (const device of existing as Device[]) {
      baselineDeviceIds.add(device.id);
    }
  };

  seedKnownDevices();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

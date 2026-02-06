import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { createScanner } from './scanner';
import { createDatabase } from './db';
import type { Device } from './types';

let mainWindow: BrowserWindow | null = null;
const scanner = createScanner();
let db: ReturnType<typeof createDatabase> | null = null;

const createMainWindow = () => {
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
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

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
  });
};

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'aneti.sqlite');
  db = createDatabase(dbPath);

  createMainWindow();

  ipcMain.handle('scanner:start', (_event, options) => scanner.start(options));
  ipcMain.handle('scanner:stop', () => scanner.stop());
  ipcMain.handle('scanner:list', () => scanner.list());
  ipcMain.handle('db:devices', () => db?.listDevices() ?? []);
  ipcMain.handle('db:alerts', (_event, limit?: number) => db?.listAlerts(limit ?? 50) ?? []);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

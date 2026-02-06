import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { createScanner } from './scanner';

let mainWindow: BrowserWindow | null = null;
const scanner = createScanner();

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
    mainWindow?.webContents.send('scanner:devices', devices);
  });
};

app.whenReady().then(() => {
  createMainWindow();

  ipcMain.handle('scanner:start', (_event, options) => scanner.start(options));
  ipcMain.handle('scanner:stop', () => scanner.stop());
  ipcMain.handle('scanner:list', () => scanner.list());

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

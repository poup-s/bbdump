import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { backupManager } from './backup';
import { cronManager } from './cron';
import { logger } from './logger';
import { pathManager } from './paths';

// Import IPC registrars
import { registerConfigHandlers, loadConfig, saveConfig, getConfig } from './ipc/configIpc';
import { registerDbViewerHandlers, closeAllPools } from './ipc/dbViewerIpc';
import { registerSystemHandlers } from './ipc/systemIpc';
import { registerDatabaseCreationHandlers } from './ipc/databaseCreationIpc';
import { encryptionManager } from './encryption';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;
let handlersRegistered = false;
let isQuitting = false;

// Créer la fenêtre principale
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false // Required for some node modules if not fully sandboxed
    }
  });

  // En développement, charger depuis le serveur de dev
  // En production, charger le fichier HTML
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // Pour le développement, on utilisera un serveur local
    mainWindow.loadFile(path.join(process.cwd(), 'src/renderer/index.html'));
  }

  // Ouvrir les DevTools en développement
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Configurer le backupManager avec la référence à mainWindow
  backupManager.setMainWindow(mainWindow);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    } else {
      mainWindow = null;
      backupManager.setMainWindow(null);
      cronManager.setMainWindow(null);
    }
  });

  mainWindow.on('minimize', (e: Electron.Event) => {
    e.preventDefault();
    mainWindow?.hide();
  });

  // Passer la référence de la fenêtre au cron manager pour les notifications
  cronManager.setMainWindow(mainWindow);

  // Configurer le callback pour mettre à jour lastBackup
  cronManager.setBackupCompleteCallback((dbName: string, timestamp: string) => {
    const config = getConfig();
    const db = config.databases.find(d => d.name === dbName);
    if (db) {
      db.lastBackup = timestamp;
      saveConfig(config);
    }
  });

  // Add context menu for copy/paste
  mainWindow.webContents.on('context-menu', (_, props) => {
    const { Menu } = require('electron');
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: props.editFlags.canCut },
      { role: 'copy', enabled: props.editFlags.canCopy },
      { role: 'paste', enabled: props.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: props.editFlags.canSelectAll }
    ]);
    if (props.isEditable && mainWindow) {
      menu.popup({ window: mainWindow });
    }
  });

  // Register Window-dependent handlers (only once)
  if (!handlersRegistered) {
    registerSystemHandlers(mainWindow);
    registerDatabaseCreationHandlers(mainWindow);
    handlersRegistered = true;
  }
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createTrayPopup(): void {
  trayPopup = new BrowserWindow({
    width: 320,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  const trayPath = path.join(__dirname, '../renderer/tray.html');
  if (fs.existsSync(trayPath)) {
    trayPopup.loadFile(trayPath);
  } else {
    trayPopup.loadFile(path.join(process.cwd(), 'src/renderer/tray.html'));
  }

  trayPopup.on('blur', () => {
    trayPopup?.hide();
  });
}

function toggleTrayPopup(): void {
  if (!trayPopup) return;
  if (trayPopup.isVisible()) {
    trayPopup.hide();
    return;
  }
  // Reload data each time popup is shown
  trayPopup.webContents.send('tray-refresh');

  const trayBounds = tray!.getBounds();
  const popupBounds = trayPopup.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - popupBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  trayPopup.setPosition(x, y);
  trayPopup.show();
}

function createTray(): void {
  const iconPath = path.join(__dirname, 'assets', 'trayIconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('bbdump');

  tray.on('click', toggleTrayPopup);
  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open bbdump', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quit(); } }
    ]);
    tray!.popUpContextMenu(contextMenu);
  });

  // IPC: open full app from tray popup
  ipcMain.on('tray-open-app', () => {
    trayPopup?.hide();
    showWindow();
  });

  // IPC: open db viewer from tray popup
  ipcMain.on('tray-open-dbviewer', (_, dbName: string) => {
    trayPopup?.hide();
    showWindow();
    mainWindow?.webContents.send('open-dbviewer', dbName);
  });

  // IPC: edit database from tray popup
  ipcMain.on('tray-edit-db', (_, dbName: string) => {
    trayPopup?.hide();
    showWindow();
    mainWindow?.webContents.send('edit-db', dbName);
  });
}

// Initialisation de l'application
app.whenReady().then(() => {
  // Initialiser les managers
  // pathManager.ensureDirectories(); // Called in constructor

  // Charger la configuration
  const config = loadConfig();

  // Initialiser le gestionnaire de tâches planifiées avec mots de passe déchiffrés
  const decryptedDatabases = (config.databases || []).map(db => {
    try {
      return {
        ...db,
        password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
      };
    } catch (error) {
      logger.error(`Failed to decrypt password for ${db.name} during startup: ${error}`);
      return { ...db, enabled: false }; // Désactiver la DB si déchiffrement échoue
    }
  });
  cronManager.rescheduleAll(decryptedDatabases);

  // Register IPC handlers
  registerConfigHandlers(); // Config handlers don't need window
  registerDbViewerHandlers(); // DbViewer handlers don't need window

  createWindow();
  createTrayPopup();
  createTray();

  app.on('activate', () => {
    showWindow();
  });
});

app.on('before-quit', async () => {
  isQuitting = true;
  logger.info('Application shutting down, cleaning up...');
  cronManager.cancelAllBackups();
  try {
    await closeAllPools();
  } catch (error) {
    logger.error(`Error closing connection pools: ${error}`);
  }
  logger.info('Cleanup complete');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

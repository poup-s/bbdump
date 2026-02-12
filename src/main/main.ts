import { app, BrowserWindow, ipcMain } from 'electron';
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
let handlersRegistered = false;

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

  mainWindow.on('closed', () => {
    mainWindow = null;
    backupManager.setMainWindow(null);
    cronManager.setMainWindow(null);
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async () => {
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

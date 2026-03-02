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
import { initAutoUpdater, setUpdaterWindow } from './updateChecker';
import { startConfirmServer, onConfirmRequest, stopConfirmServer } from './mcpConfirmServer';
import { registerProxyHandlers } from './ipc/proxyIpc';
import { tcpProxyManager } from './tcpProxy';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;
let handlersRegistered = false;
let isQuitting = false;
let mcpConfirmActive = false;
const isMcpConfirmLaunch = process.argv.includes('--mcp-confirm');

// Créer la fenêtre principale
function createWindow(): void {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: !isMcpConfirmLaunch,
    // macOS: hidden titlebar with custom traffic light position
    // Linux/Windows: default system titlebar
    ...(isMac ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 20 },
    } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true
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

  // Initialiser l'auto-updater
  initAutoUpdater(mainWindow);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
    } else {
      mainWindow = null;
      backupManager.setMainWindow(null);
      cronManager.setMainWindow(null);
      setUpdaterWindow(null);
    }
  });

  mainWindow.on('minimize', (e: Electron.Event) => {
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  // Passer la référence de la fenêtre au cron manager pour les notifications
  cronManager.setMainWindow(mainWindow);

  // Configurer le callback pour mettre à jour lastBackup
  cronManager.setBackupCompleteCallback((dbId: string, timestamp: string) => {
    const config = getConfig();
    const db = config.databases.find(d => d.id === dbId);
    if (db) {
      db.lastBackup = timestamp;
      saveConfig(config);
    }
  });

  // Add context menu for copy/paste
  mainWindow.webContents.on('context-menu', (_, props) => {
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow = null;
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
      sandbox: true
    }
  });

  const trayPath = path.join(__dirname, '../renderer/tray.html');
  if (fs.existsSync(trayPath)) {
    trayPopup.loadFile(trayPath);
  } else {
    trayPopup.loadFile(path.join(process.cwd(), 'src/renderer/tray.html'));
  }

  trayPopup.on('blur', () => {
    // Don't auto-hide while an MCP confirmation is pending
    if (mcpConfirmActive) return;
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
  ipcMain.on('tray-open-dbviewer', (_, dbId: string) => {
    trayPopup?.hide();
    showWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-dbviewer', dbId);
    }
  });

  // IPC: edit database from tray popup
  ipcMain.on('tray-edit-db', (_, dbId: string) => {
    trayPopup?.hide();
    showWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('edit-db', dbId);
    }
  });
}

// Initialisation de l'application
app.whenReady().then(async () => {
  // Fix PATH pour macOS/Linux : quand l'app est lancée depuis Finder/Dock,
  // le PATH ne contient pas les chemins Homebrew/usr/local
  if (process.platform === 'darwin') {
    const additionalPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];
    const currentPath = process.env.PATH || '';
    const missingPaths = additionalPaths.filter(p => !currentPath.includes(p));
    if (missingPaths.length > 0) {
      process.env.PATH = [...missingPaths, currentPath].join(':');
    }
  } else if (process.platform === 'linux') {
    const additionalPaths = ['/usr/local/bin', '/usr/bin', '/snap/bin'];
    const currentPath = process.env.PATH || '';
    const missingPaths = additionalPaths.filter(p => !currentPath.includes(p));
    if (missingPaths.length > 0) {
      process.env.PATH = [...missingPaths, currentPath].join(':');
    }
  }

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
  registerProxyHandlers(); // Proxy handlers don't need window

  // Restore TCP proxies that were enabled before shutdown
  for (const project of config.projects || []) {
    if (project.proxyEnabled && project.proxyPort && project.proxyTargetDbId) {
      const db = config.databases.find(d => d.id === project.proxyTargetDbId);
      if (db) {
        // Decrypt password for proxy target
        let password = db.password || '';
        if (password && db.encrypted) {
          try { password = encryptionManager.decrypt(password); } catch { /* use raw */ }
        }

        let target = { host: db.host || 'localhost', port: db.port || 5432, user: db.user || 'postgres', password, database: db.name || 'postgres', ssl: db.ssl };
        if (db.connectionString) {
          try {
            const url = new URL(db.connectionString);
            target = {
              host: url.hostname || 'localhost',
              port: parseInt(url.port) || 5432,
              user: decodeURIComponent(url.username) || 'postgres',
              password: decodeURIComponent(url.password) || password,
              database: url.pathname.replace(/^\//, '') || db.name || 'postgres',
              ssl: db.ssl || url.searchParams.get('sslmode') === 'require',
            };
          } catch { /* fallback to individual fields */ }
        }
        const dbName = db.displayName || db.name;
        tcpProxyManager.startProxy(project.id, project.proxyPort, target, dbName).catch(err => {
          logger.error(`Failed to restore proxy for project ${project.name}: ${err.message}`);
          project.proxyEnabled = false;
          saveConfig(config);
        });
      }
    }
  }

  createWindow();
  createTrayPopup();
  createTray();

  // Start MCP confirmation HTTP server and write port file
  try {
    const confirmPort = await startConfirmServer();

    // Register callback: show tray popup when a MCP mutation needs confirmation
    onConfirmRequest(async (_data) => {
      if (!trayPopup || trayPopup.isDestroyed()) return null;

      mcpConfirmActive = true;

      // Wait for tray popup to finish loading if needed
      if (trayPopup.webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          trayPopup!.webContents.once('did-finish-load', () => resolve());
        });
      }

      // Resize tray popup to accommodate the confirmation UI
      trayPopup.setSize(320, 520);

      // Position near the tray icon
      if (tray) {
        const trayBounds = tray.getBounds();
        const popupBounds = trayPopup.getBounds();
        const x = Math.round(trayBounds.x + trayBounds.width / 2 - popupBounds.width / 2);
        const y = Math.round(trayBounds.y + trayBounds.height + 4);
        trayPopup.setPosition(x, y);
      }

      trayPopup.show();
      return trayPopup;
    });

    // When the tray popup responds to a confirmation, reset state
    ipcMain.on('mcp-confirm-done', () => {
      mcpConfirmActive = false;
      if (trayPopup && !trayPopup.isDestroyed()) {
        trayPopup.setSize(320, 420);
        trayPopup.hide();
      }
    });

    const portFilePath = path.join(pathManager.appDataPath, '.mcp-confirm-port');
    fs.writeFileSync(portFilePath, String(confirmPort), 'utf-8');
    logger.info(`MCP confirm port file written: ${portFilePath} (port ${confirmPort})`);
  } catch (error) {
    logger.error(`Failed to start MCP confirm server: ${error}`);
  }

  app.on('activate', () => {
    if (!isMcpConfirmLaunch) {
      showWindow();
    }
  });
});

app.on('before-quit', async () => {
  isQuitting = true;
  logger.info('Application shutting down, cleaning up...');
  stopConfirmServer();
  tcpProxyManager.stopAll();
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

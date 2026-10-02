import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { backupManager } from './backup';
import { cronManager } from './cron';
import { logger } from './logger';
import { pathManager } from './paths';

// Import IPC registrars
import { registerConfigHandlers, loadConfig, saveConfig, getConfig, repairLocalDatabaseUsers } from './ipc/configIpc';
import { registerCloudHandlers } from './ipc/cloudIpc';
import { registerDbViewerHandlers, closeAllPools } from './ipc/dbViewerIpc';
import { registerSystemHandlers } from './ipc/systemIpc';
import { registerSetupHandlers } from './ipc/setupIpc';
import { registerDatabaseCreationHandlers } from './ipc/databaseCreationIpc';
import { initAutoUpdater, setUpdaterWindow } from './updateChecker';
import { startConfirmServer, onConfirmRequest, stopConfirmServer, getConfirmToken, writePortFile } from './mcpConfirmServer';
import { registerProxyHandlers, resolveProxyTarget, releaseProxyTunnel } from './ipc/proxyIpc';
import { closeAllTunnels, cleanUpOrphanTunnels } from './sshTunnel';
import { registerSshHandlers } from './ipc/sshIpc';
import { prepareMcpRuntime } from './mcpLaunch';
import { tcpProxyManager } from './tcpProxy';
import { wasStartedHidden } from './loginItem';
import { toRuntimeDatabase } from './dbSecrets';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPopup: BrowserWindow | null = null;
let handlersRegistered = false;
let isQuitting = false;
let mcpConfirmActive = false;
const isMcpConfirmLaunch = process.argv.includes('--mcp-confirm');

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

// Every window only ever shows the bundled renderer: links open in the system browser,
// and nothing (target=_blank, window.open, navigation) may load remote content in-app,
// where it would inherit the preload and its IPC access.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
  });
});

// Create the main window
function createWindow(): void {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Started at login: stay in the tray, scheduled backups run in the background
    show: !isMcpConfirmLaunch && !wasStartedHidden(),
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

  // In development, load from the dev server
  // In production, load the HTML file
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // For development, use a local server
    mainWindow.loadFile(path.join(process.cwd(), 'src/renderer/index.html'));
  }

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Configure backupManager with the mainWindow reference
  backupManager.setMainWindow(mainWindow);

  // Initialize the auto-updater
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

  // 'minimize' cannot be cancelled: the window is minimized, then hidden to the tray.
  // showWindow() restores it.
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  // Pass the window reference to the cron manager for notifications
  cronManager.setMainWindow(mainWindow);

  // Configure the callback to update lastBackup
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
    // Handlers outlive the window (it is re-created after being destroyed): resolve it on each use
    registerSystemHandlers(getMainWindow);
    registerSetupHandlers(getMainWindow);
    registerDatabaseCreationHandlers(getMainWindow);
    handlersRegistered = true;
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function showWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
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

/**
 * Places the tray popup under the tray icon. Tray bounds are only known on macOS/Windows
 * (Linux returns an empty rectangle), so fall back to the cursor position, kept inside the
 * work area. On Wayland windows cannot position themselves and the compositor decides.
 */
function positionTrayPopup(): void {
  if (!trayPopup || trayPopup.isDestroyed()) return;
  try {
    const popup = trayPopup.getBounds();
    const trayBounds = tray && !tray.isDestroyed() ? tray.getBounds() : null;
    const anchor = trayBounds && trayBounds.width > 0 && trayBounds.height > 0
      ? { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y + trayBounds.height + 4, below: true }
      : { ...screen.getCursorScreenPoint(), below: false };
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
    let x = Math.round(anchor.x - popup.width / 2);
    let y = Math.round(anchor.below ? anchor.y : anchor.y - popup.height - 4);
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - popup.width);
    y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - popup.height);
    trayPopup.setPosition(x, y);
  } catch (error) {
    logger.warn(`Unable to position the tray popup: ${error}`);
  }
}

function toggleTrayPopup(): void {
  if (!trayPopup) return;
  if (trayPopup.isVisible()) {
    trayPopup.hide();
    return;
  }
  // Reload data each time popup is shown
  trayPopup.webContents.send('tray-refresh');

  positionTrayPopup();
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

// Application initialization
app.whenReady().then(async () => {
  // Fix PATH for macOS/Linux: when the app is launched from Finder/Dock,
  // the PATH does not include Homebrew/usr/local paths
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

  // Load the configuration
  loadConfig();
  // Logs written by v1.0.2 may contain connection URIs with passwords
  logger.scrubSecretsFromLogs();
  await repairLocalDatabaseUsers();
  const config = getConfig();

  // Initialize the scheduled task manager with decrypted passwords
  const decryptedDatabases = (config.databases || []).map(db => {
    try {
      return toRuntimeDatabase(db);
    } catch (error) {
      logger.error(`Failed to decrypt password for ${db.name} during startup: ${error}`);
      return { ...db, enabled: false }; // Disable the DB if decryption fails
    }
  });
  cronManager.rescheduleAll(decryptedDatabases);

  // Backups scheduled while the app was closed: run them once, shortly after startup
  if (!isMcpConfirmLaunch) {
    setTimeout(() => {
      cronManager.catchUpMissedBackups(decryptedDatabases).catch(error =>
        logger.error(`Catch-up of missed backups failed: ${error}`));
    }, 30_000);
  }

  // Register IPC handlers
  registerConfigHandlers(); // Config handlers don't need window
  ipcMain.handle('open-external', async (_e, url: string) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
      throw new Error('Only https/mailto URLs can be opened');
    }
    await shell.openExternal(url);
  });
  ipcMain.handle('show-item-in-folder', async (_e, itemPath: string) => {
    if (typeof itemPath === 'string' && path.isAbsolute(itemPath) && fs.existsSync(itemPath)) {
      shell.showItemInFolder(itemPath);
    }
  });
  registerDbViewerHandlers(); // DbViewer handlers don't need window
  registerProxyHandlers(); // Proxy handlers don't need window
  registerCloudHandlers();
  registerSshHandlers();
  cleanUpOrphanTunnels().catch(() => { /* best effort */ });

  // Restore TCP proxies that were enabled before shutdown
  for (const project of config.projects || []) {
    if (project.proxyEnabled && project.proxyPort && project.proxyTargetDbId) {
      const db = config.databases.find(d => d.id === project.proxyTargetDbId);
      if (db) {
        const dbName = db.displayName || db.name;
        const port = project.proxyPort;
        resolveProxyTarget(db.id, project.id)
          .then(target => {
            if (!target) throw new Error('Target database not found');
            return tcpProxyManager.startProxy(project.id, port, target, dbName);
          })
          .catch(err => {
            logger.error(`Failed to restore proxy for project ${project.name}: ${err.message}`);
            releaseProxyTunnel(project.id);
            project.proxyEnabled = false;
            saveConfig(config);
          });
      }
    }
  }

  createWindow();
  createTrayPopup();
  createTray();

  // AppImage only: keep a copy of the MCP server outside the ephemeral mount
  prepareMcpRuntime();

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

      positionTrayPopup();

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

    const portFilePath = pathManager.mcpConfirmPortFilePath;
    writePortFile(portFilePath, confirmPort, getConfirmToken());
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
  backupManager.killAllActiveProcesses();
  try {
    await closeAllPools();
  } catch (error) {
    logger.error(`Error closing connection pools: ${error}`);
  }
  closeAllTunnels();
  logger.info('Cleanup complete');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

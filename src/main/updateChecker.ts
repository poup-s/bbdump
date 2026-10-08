import { autoUpdater, UpdateInfo as ElectronUpdateInfo } from 'electron-updater';
import { getErrorMessage } from './utils';
import { app, BrowserWindow, shell } from 'electron';
import { logger } from './logger';
import { downloadMacUpdate, installMacUpdateAndQuit, macUpdatableBundle } from './macSelfUpdate';

export interface UpdateInfo {
  updateAvailable: boolean;
  version: string;
  url: string;
  releaseNotes: string;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let latestVersion = '';
let listenersRegistered = false;
/** The new macOS bundle, downloaded and checked, waiting for the app to quit */
let pendingMacApp: string | null = null;

const RELEASES_URL = 'https://github.com/poup-s/bbdump/releases';

const isAppImage = () => process.platform === 'linux' && !!process.env.APPIMAGE;

/**
 * In-place updates: electron-updater for the Linux AppImage, bbdump's own updater on macOS
 * (Squirrel.Mac rejects unsigned apps) when the app sits in a folder it can write to.
 * .deb installs, and Macs where the bundle cannot be replaced, get the release page.
 */
export function supportsAutoInstall(): boolean {
  return isAppImage() || macUpdatableBundle() !== null;
}

function sendToWindow(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function releaseUrl(version: string): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`;
}

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;
  // Called again when the main window is re-created: only swap the target window
  if (listenersRegistered) return;
  listenersRegistered = true;

  autoUpdater.autoDownload = false;
  // Never on macOS: Squirrel.Mac would try (and fail) to install on quit
  autoUpdater.autoInstallOnAppQuit = isAppImage();

  autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
    logger.info(`Update available: ${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('No update available');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-not-available');
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    logger.info('Update downloaded, ready to install');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded');
    }
  });

  autoUpdater.on('error', (error) => {
    logger.error(`Auto-updater error: ${error.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', error.message);
    }
  });
}

export function setUpdaterWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      return { updateAvailable: false, version: '', url: '', releaseNotes: '' };
    }
    const info = result.updateInfo;
    const currentVersion = autoUpdater.currentVersion.version;
    const updateAvailable = isNewerVersion(info.version, currentVersion);
    latestVersion = info.version;
    return {
      updateAvailable,
      version: info.version,
      url: releaseUrl(info.version),
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    };
  } catch (error) {
    logger.error(`Update check failed: ${getErrorMessage(error)}`);
    return {
      updateAvailable: false,
      version: '',
      url: '',
      releaseNotes: '',
      error: getErrorMessage(error),
    };
  }
}

export async function downloadUpdate(): Promise<{ manual: boolean }> {
  const macBundle = process.platform === 'darwin' ? macUpdatableBundle() : null;
  if (macBundle && latestVersion) {
    try {
      pendingMacApp = await downloadMacUpdate(latestVersion, percent => sendToWindow('update-download-progress', { percent }));
      sendToWindow('update-downloaded');
    } catch (error) {
      logger.error(`macOS update download failed: ${getErrorMessage(error)}`);
      sendToWindow('update-error', getErrorMessage(error));
    }
    return { manual: false };
  }
  if (!isAppImage()) {
    await shell.openExternal(releaseUrl(latestVersion));
    return { manual: true };
  }
  await autoUpdater.downloadUpdate();
  return { manual: false };
}

export function quitAndInstall(): void {
  const macBundle = process.platform === 'darwin' ? macUpdatableBundle() : null;
  if (macBundle && pendingMacApp) {
    installMacUpdateAndQuit(pendingMacApp, macBundle);
    return;
  }
  if (!isAppImage()) {
    // Tearing down the windows before a doomed install left the app with no window
    shell.openExternal(releaseUrl(latestVersion));
    return;
  }
  logger.info('Quitting and installing update...');
  
  // Allow time for IPC to return the response to the renderer
  // before triggering the shutdown and update procedure
  setTimeout(() => {
    // Force cleanup to ensure Electron quits properly
    // (electron-updater can sometimes block if windows remain active)
    app.removeAllListeners('window-all-closed');
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(w => {
      w.removeAllListeners('close');
      w.destroy();
    });

    // isSilent=false (show installer), isForceRunAfter=true (relaunch app after install)
    autoUpdater.quitAndInstall(false, true);
  }, 1000);
}

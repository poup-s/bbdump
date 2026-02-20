import { autoUpdater, UpdateInfo as ElectronUpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { logger } from './logger';

export interface UpdateInfo {
  updateAvailable: boolean;
  version: string;
  url: string;
  releaseNotes: string;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
    logger.info(`Update available: ${info.version}`);
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    });
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('No update available');
    mainWindow?.webContents.send('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-download-progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    logger.info('Update downloaded, ready to install');
    mainWindow?.webContents.send('update-downloaded');
  });

  autoUpdater.on('error', (error) => {
    logger.error(`Auto-updater error: ${error.message}`);
    mainWindow?.webContents.send('update-error', error.message);
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
    const updateAvailable = info.version !== currentVersion;
    return {
      updateAvailable,
      version: info.version,
      url: `https://github.com/poup-s/bbDump-app/releases/tag/v${info.version}`,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    };
  } catch (error: any) {
    logger.error(`Update check failed: ${error.message}`);
    return {
      updateAvailable: false,
      version: '',
      url: '',
      releaseNotes: '',
      error: error.message,
    };
  }
}

export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

export function quitAndInstall(): void {
  logger.info('Quitting and installing update...');
  // Remove listeners that prevent the app from quitting
  app.removeAllListeners('window-all-closed');
  // Force-close all windows so the app can actually quit
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(w => w.removeAllListeners('close'));
  windows.forEach(w => w.close());
  // isSilent=false (show installer), isForceRunAfter=true (relaunch app after install)
  autoUpdater.quitAndInstall(false, true);
}

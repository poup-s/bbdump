import { autoUpdater, UpdateInfo as ElectronUpdateInfo } from 'electron-updater';
import { getErrorMessage } from './utils';
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
    const updateAvailable = info.version !== currentVersion;
    return {
      updateAvailable,
      version: info.version,
      url: `https://github.com/poup-s/bbDump-app/releases/tag/v${info.version}`,
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

export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate();
}

export function quitAndInstall(): void {
  logger.info('Quitting and installing update...');
  
  // On laisse le temps à l'IPC de retourner la réponse au renderer
  // avant de déclencher la procédure de fermeture et mise à jour
  setTimeout(() => {
    // Nettoyage forcé pour s'assurer qu'Electron quitte bien
    // (electron-updater peut parfois bloquer si des fenêtres restent actives)
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

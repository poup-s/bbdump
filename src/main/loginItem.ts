import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';
import { getErrorMessage } from './utils';

const HIDDEN_ARG = '--hidden';

function linuxAutostartPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'bbdump.desktop');
}

/**
 * Starts bbdump at login, hidden in the tray, so scheduled backups run without the
 * user opening the app. macOS uses the login items API; Linux has no Electron API
 * for it, so an XDG autostart entry is written instead.
 */
export function applyLaunchAtLogin(enabled: boolean): void {
  try {
    if (process.platform === 'linux') {
      const desktopFile = linuxAutostartPath();
      if (enabled) {
        // AppImage: APPIMAGE points to the file to launch; execPath is inside a temp mount
        const executable = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
        fs.writeFileSync(desktopFile, [
          '[Desktop Entry]',
          'Type=Application',
          'Name=bbdump',
          `Exec="${executable}" ${HIDDEN_ARG}`,
          'X-GNOME-Autostart-enabled=true',
          ''
        ].join('\n'), 'utf8');
      } else if (fs.existsSync(desktopFile)) {
        fs.unlinkSync(desktopFile);
      }
    } else {
      // macOS 13+ (SMAppService) ignores `args`; wasStartedHidden() relies on wasOpenedAtLogin there.
      // `openAsHidden` was removed in Electron 44 (it only worked on macOS 12 and below).
      app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
    }
    logger.info(`Launch at login ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    logger.error(`Unable to update launch at login: ${getErrorMessage(error)}`);
  }
}

/** True when the app was started by the login item and should stay in the tray. */
export function wasStartedHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true;
  if (process.platform === 'darwin') {
    const settings = app.getLoginItemSettings();
    return settings.wasOpenedAtLogin === true;
  }
  return false;
}

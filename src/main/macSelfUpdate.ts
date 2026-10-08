/**
 * Downloads, checks and installs a macOS update without Squirrel (see macUpdate.ts for why).
 */
import { app, BrowserWindow, net } from 'electron';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { logger } from './logger';
import { pathManager } from './paths';
import { INSTALL_SCRIPT, appBundleFromExe, isTranslocated, parseUpdateManifest, pickMacArchive } from './macUpdate';

const execFileAsync = promisify(execFile);
const RELEASE_DOWNLOADS = 'https://github.com/poup-s/bbdump/releases/download';

/** The installed bundle, when bbdump can replace it (packaged, not translocated, writable) */
export function macUpdatableBundle(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const bundle = appBundleFromExe(app.getPath('exe'));
  if (!bundle || isTranslocated(bundle)) return null;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return bundle;
  } catch {
    return null;
  }
}

/**
 * Downloads the zip of `version` for this Mac, checks its sha512 and unpacks it.
 * Returns the new bundle, ready to be swapped in.
 */
export async function downloadMacUpdate(version: string, onProgress: (percent: number) => void): Promise<string> {
  const base = `${RELEASE_DOWNLOADS}/v${version}`;
  const manifestResponse = await net.fetch(`${base}/latest-mac.yml`);
  if (!manifestResponse.ok) throw new Error(`Could not read the update manifest (HTTP ${manifestResponse.status})`);
  const manifest = parseUpdateManifest(await manifestResponse.text());
  if (manifest.version !== version) throw new Error(`The manifest is for ${manifest.version || 'an unknown version'}, not ${version}`);
  const archive = pickMacArchive(manifest.files, process.arch);
  if (!archive) throw new Error(`No macOS archive for ${process.arch} in this release`);

  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'bbdump-update-'));
  try {
    const zipPath = path.join(dir, path.basename(archive.url));
    const response = await net.fetch(`${base}/${encodeURIComponent(archive.url)}`);
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
    const total = archive.size || Number(response.headers.get('content-length')) || 0;
    const hash = createHash('sha512');
    const out = fs.createWriteStream(zipPath);
    const reader = response.body.getReader();
    let received = 0;
    let lastPercent = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>(resolve => out.once('drain', () => resolve()));
      received += value.length;
      const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress(percent);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    if (hash.digest('base64') !== archive.sha512) throw new Error('The downloaded update does not match its published checksum');

    const extractDir = path.join(dir, 'extract');
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
    fs.rmSync(zipPath, { force: true });
    const appName = fs.readdirSync(extractDir).find(name => name.endsWith('.app'));
    if (!appName) throw new Error('The update archive holds no application');
    const newApp = path.join(extractDir, appName);
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(newApp, 'Contents', 'Info.plist')]);
    if (stdout.trim() !== version) throw new Error(`The archive holds version ${stdout.trim()}, not ${version}`);
    await execFileAsync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => undefined);
    onProgress(100);
    logger.info(`Update ${version} downloaded and checked: ${newApp}`);
    return newApp;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Quits bbdump; a detached script swaps in the new bundle and reopens it */
export function installMacUpdateAndQuit(newApp: string, bundle: string): void {
  const scriptPath = path.join(path.dirname(path.dirname(newApp)), 'install-update.sh');
  fs.writeFileSync(scriptPath, INSTALL_SCRIPT, { mode: 0o700 });
  const logFile = path.join(pathManager.logsPath, 'app.log');
  const child = spawn('/bin/sh', [scriptPath, String(process.pid), bundle, newApp, logFile], { detached: true, stdio: 'ignore' });
  child.unref();
  logger.info(`Installing the update over ${bundle} after quitting`);

  // Let the IPC answer reach the window, then quit for real (closing the window only hides it)
  setTimeout(() => {
    app.removeAllListeners('window-all-closed');
    for (const win of BrowserWindow.getAllWindows()) {
      win.removeAllListeners('close');
      win.destroy();
    }
    app.quit();
  }, 500);
}

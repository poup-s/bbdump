/**
 * Where backups live. A backup is written to its database's `output`, else to the
 * default folder (chosen in the onboarding / settings), else to the internal folder.
 * Listing, download and delete must therefore look in all of these, not only in
 * pathManager.backupsPath.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type { AppConfig } from '../types/config';
import { pathManager } from './paths';

type BackupConfig = Pick<AppConfig, 'defaultBackupPath' | 'databases'>;

/**
 * Suggested folder when the user picked none. Linux: ~/Documents/bbdump (the XDG documents
 * folder), easy to find and back up. macOS / Windows keep the internal folder.
 */
export function platformDefaultBackupDir(): string {
  if (process.platform === 'linux') {
    const home = os.homedir();
    let documents = path.join(home, 'Documents');
    try {
      // XDG documents folder (localized, e.g. ~/Dokumente). Without user-dirs.dirs,
      // Electron answers the home folder itself: keep ~/Documents then.
      const xdg = app.getPath('documents');
      if (xdg && path.resolve(xdg) !== path.resolve(home)) documents = xdg;
    } catch {
      // Keep ~/Documents
    }
    return path.join(documents, 'bbdump');
  }
  return pathManager.backupsPath;
}

/** The default backup folder: the user's choice, else the platform suggestion. */
export function defaultBackupDir(config: Pick<AppConfig, 'defaultBackupPath'>): string {
  return config.defaultBackupPath?.trim() || platformDefaultBackupDir();
}

/** Directory a database `output` writes into (mirrors BackupManager.executeBackup). */
export function outputDirectory(output: string, appDataPath: string): string {
  const absolute = path.isAbsolute(output) ? output : path.join(appDataPath, output);
  const lastSegment = path.basename(output);
  const isFile = lastSegment.includes('.') && !lastSegment.startsWith('.');
  return isFile ? path.dirname(absolute) : absolute;
}

/** All folders that may hold backups, resolved and without duplicates. Pure. */
export function collectBackupDirectories(
  config: BackupConfig,
  internalDir: string,
  appDataPath: string,
  platformDefault: string,
): string[] {
  const dirs = [internalDir, config.defaultBackupPath?.trim() || platformDefault];
  for (const db of config.databases || []) {
    if (db.output && db.output.trim()) dirs.push(outputDirectory(db.output.trim(), appDataPath));
  }
  return [...new Set(dirs.filter(Boolean).map((dir) => path.resolve(dir)))];
}

export function backupDirectories(config: BackupConfig): string[] {
  return collectBackupDirectories(config, pathManager.backupsPath, pathManager.appDataPath, platformDefaultBackupDir());
}

/**
 * Resolves a backup reference from the renderer: an absolute path directly inside one of
 * the backup folders, or a bare filename in the internal folder (older renderers).
 * Returns null for anything else, so delete/download cannot reach other files. Pure.
 */
export function resolveBackupReference(reference: string, dirs: string[], internalDir: string): string | null {
  if (typeof reference !== 'string' || !reference || reference.includes('\0')) return null;
  const file = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(internalDir, reference);
  if (!file.endsWith('.backup')) return null;
  const parent = path.dirname(file);
  return dirs.some((dir) => path.resolve(dir) === parent) ? file : null;
}

export function resolveBackupFile(config: BackupConfig, reference: string): string | null {
  return resolveBackupReference(reference, backupDirectories(config), pathManager.backupsPath);
}

/** `.backup` files found in the backup folders (missing folders are skipped). */
export function listBackupFiles(config: BackupConfig): string[] {
  const files: string[] = [];
  for (const dir of backupDirectories(config)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.backup')) continue;
      const file = path.join(dir, entry);
      try {
        if (fs.statSync(file).isFile()) files.push(file);
      } catch {
        // Vanished between readdir and stat
      }
    }
  }
  return files;
}

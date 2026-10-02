/**
 * "Back up now" and the list of backup files, shared by the renderer (IPC) and the
 * MCP server (local HTTP routes of mcpConfirmServer).
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { pathManager } from './paths';
import { fileEncryptionManager } from './fileEncryption';
import { backupManager } from './backup';
import { toRuntimeDatabase } from './dbSecrets';
import { listBackupFiles } from './backupLocations';
import { getConfig, saveConfig } from './ipc/configIpc';
import type { AppConfig, BackupResult } from '../types/config';

export interface BackupEntry {
  filename: string;
  /** Absolute path: what delete / download / restore act on */
  file: string;
  databaseId: string;
  database?: string;
  name: string;
  path: string;
  size: number;
  created: string;
  encrypted: boolean;
}

/** Every backup file bbdump knows (all backup folders), newest first; optionally one database's */
export function listBackupEntries(config: AppConfig, databaseId?: string): BackupEntry[] {
  return listBackupFiles(config)
    .map(filePath => {
      const file = path.basename(filePath);
      const stats = fs.statSync(filePath);
      const prefix = file.replace('.backup', '').split('_')[0] || 'unknown';
      // Match by id first, then by name (files of older versions)
      const matchedDb = config.databases.find(d => d.id === prefix) || config.databases.find(d => d.name === prefix);
      return {
        filename: file,
        file: filePath,
        databaseId: matchedDb ? matchedDb.id : prefix,
        database: matchedDb ? (matchedDb.displayName || matchedDb.name) : undefined,
        name: file,
        path: path.relative(pathManager.appDataPath, filePath),
        size: stats.size,
        created: stats.birthtime.toISOString(),
        encrypted: fileEncryptionManager.isFileEncrypted(filePath),
      };
    })
    .filter(entry => !databaseId || entry.databaseId === databaseId)
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
}

export type BackupEvents = (channel: 'backup-started' | 'backup-complete', payload: unknown) => void;

/** Backs up a saved database now and records lastBackup; never throws */
export async function runBackupNow(id: string, notify?: BackupEvents): Promise<BackupResult> {
  try {
    const config = getConfig();
    const db = config.databases.find(d => d.id === id);
    if (!db) {
      const error = `Database not found: ${id}`;
      logger.error(error);
      return { success: false, database: id, timestamp: new Date().toISOString(), error };
    }

    let runtimeDb = { ...db };
    try {
      runtimeDb = toRuntimeDatabase(db);
    } catch (error) {
      const msg = `Failed to decrypt password for ${db.name}: ${error}`;
      logger.error(msg);
      return { success: false, database: db.name, timestamp: new Date().toISOString(), error: msg };
    }

    notify?.('backup-started', id);
    const result = await backupManager.backupDatabase(runtimeDb);

    if (result.success) {
      // Re-read: the config may have changed during a long backup
      const latest = getConfig();
      const index = latest.databases.findIndex(d => d.id === id);
      if (index !== -1) {
        latest.databases[index].lastBackup = result.timestamp;
        saveConfig(latest);
      }
    }

    notify?.('backup-complete', { ...result, databaseId: id });
    return result;
  } catch (error) {
    const msg = `Unexpected error during backup of ${id}: ${error}`;
    logger.error(msg);
    return { success: false, database: id, timestamp: new Date().toISOString(), error: msg };
  }
}

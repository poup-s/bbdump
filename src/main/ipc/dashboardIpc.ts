/**
 * Dashboards: kept encrypted apart from config.json (see dashboardStore). Their queries run
 * through 'execute-sql' (read only); their AI edits through the database chat ('ai-chat-send').
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from '../paths';
import { logger } from '../logger';
import { encryptionManager } from '../encryption';
import { getConfig } from './configIpc';
import { DashboardStore, fromDashboardFile, sanitizeDashboard, sanitizeFilters, toDashboardFile } from '../dashboards/dashboardStore';

let instance: DashboardStore | null = null;
function dashboards(): DashboardStore {
  instance ??= new DashboardStore(path.join(pathManager.appDataPath, 'dashboards'), {
    encrypt: text => encryptionManager.encrypt(text),
    decrypt: text => encryptionManager.decrypt(text),
  });
  return instance;
}

/** A database removed from bbdump: its dashboards go with it */
export function forgetDashboards(databaseId: string): void {
  try {
    dashboards().clear(databaseId);
  } catch (error) {
    logger.warn(`Dashboards of ${databaseId} not removed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const knownDatabase = (id: unknown): id is string => typeof id === 'string' && getConfig().databases.some(db => db.id === id);

/** A file name the user can keep: no path, no odd characters */
const safeName = (name: unknown, fallback: string) => [...(typeof name === 'string' ? name : fallback)]
  .map(c => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c)).join('').replace(/\s+/g, ' ').trim().slice(0, 100) || fallback;

export function registerDashboardHandlers(getMainWindow: () => BrowserWindow | null) {
  /** Asks where to save, then writes; null when the user cancelled */
  const saveAs = async (defaultName: string, filters: Electron.FileFilter[], write: (file: string) => Promise<void> | void): Promise<{ success: boolean; path?: string; error?: string } | null> => {
    const win = getMainWindow();
    const options = { defaultPath: defaultName, filters };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    try {
      await write(result.filePath);
      return { success: true, path: result.filePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  ipcMain.handle('dashboards-save-filters', (_e, databaseId: unknown, id: unknown, filters: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return false;
    try {
      return dashboards().saveFilters(databaseId, id, sanitizeFilters(filters));
    } catch {
      return false;
    }
  });

  ipcMain.handle('dashboards-cache-get', (_e, databaseId: unknown, id: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return null;
    try {
      return dashboards().getCache(databaseId, id);
    } catch {
      return null;
    }
  });

  ipcMain.handle('dashboards-cache-set', (_e, databaseId: unknown, id: unknown, results: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return false;
    try {
      dashboards().setCache(databaseId, id, results && typeof results === 'object' ? results as Record<string, unknown> : null);
      return true;
    } catch {
      return false;
    }
  });

  /** A block's rows as CSV */
  ipcMain.handle('dashboards-save-csv', (_e, name: unknown, content: unknown) => {
    if (typeof content !== 'string' || content.length > 20 * 1024 * 1024) return { success: false, error: 'Invalid content' };
    return saveAs(`${safeName(name, 'dashboard')}.csv`, [{ name: 'CSV', extensions: ['csv'] }], file => fs.promises.writeFile(file, `\ufeff${content}`, 'utf8'));
  });

  /** Blocks' rows as an Excel workbook (built by the window) */
  ipcMain.handle('dashboards-save-xlsx', (_e, name: unknown, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 50 * 1024 * 1024) return { success: false, error: 'Invalid content' };
    return saveAs(`${safeName(name, 'dashboard')}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }], file => fs.promises.writeFile(file, Buffer.from(bytes)));
  });

  /** The dashboard as a file (program and settings, no data) */
  ipcMain.handle('dashboards-export-file', (_e, databaseId: unknown, id: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return { success: false, error: 'Invalid dashboard' };
    const dashboard = dashboards().get(databaseId, id);
    if (!dashboard) return { success: false, error: 'Dashboard not found' };
    return saveAs(`${safeName(dashboard.title, 'dashboard')}.bbdump-dashboard.json`, [{ name: 'bbdump dashboard', extensions: ['json'] }],
      file => fs.promises.writeFile(file, JSON.stringify(toDashboardFile(dashboard), null, 2), 'utf8'));
  });

  /** A dashboard file chosen by the user, read back (the page then creates it on a database) */
  ipcMain.handle('dashboards-import-file', async () => {
    const win = getMainWindow();
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'bbdump dashboard', extensions: ['json'] }] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    try {
      const stat = await fs.promises.stat(result.filePaths[0]);
      if (stat.size > 2 * 1024 * 1024) return { success: false, error: 'This file is too large' };
      const parsed = fromDashboardFile(JSON.parse(await fs.promises.readFile(result.filePaths[0], 'utf8')));
      return parsed ? { success: true, dashboard: parsed } : { success: false, error: 'Not a bbdump dashboard' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /** The window printed to PDF (the page shows only the dashboard while printing) */
  ipcMain.handle('dashboards-export-pdf', async (_e, name: unknown) => {
    const win = getMainWindow();
    if (!win) return { success: false, error: 'No window' };
    const pdf = await win.webContents.printToPDF({ printBackground: true, landscape: true, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    return saveAs(`${safeName(name, 'dashboard')}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }], file => fs.promises.writeFile(file, pdf));
  });

  ipcMain.handle('dashboards-list', () => dashboards().list(getConfig().databases.map(db => db.id)));

  ipcMain.handle('dashboards-get', (_e, databaseId: unknown, id: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return null;
    try {
      return dashboards().get(databaseId, id);
    } catch {
      return null;
    }
  });

  ipcMain.handle('dashboards-save', (_e, input: unknown) => {
    const dashboard = sanitizeDashboard(input, new Date().toISOString());
    if (!dashboard || !knownDatabase(dashboard.databaseId)) return { success: false, error: 'Invalid dashboard' };
    try {
      dashboards().save(dashboard);
      return { success: true, updatedAt: dashboard.updatedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Dashboard not saved: ${message}`);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('dashboards-delete', (_e, databaseId: unknown, id: unknown) => {
    if (!knownDatabase(databaseId) || typeof id !== 'string') return false;
    try {
      dashboards().delete(databaseId, id);
      return true;
    } catch {
      return false;
    }
  });
}

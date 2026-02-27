import { ipcMain, app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger';
import { pathManager } from '../paths';
import { fileEncryptionManager } from '../fileEncryption';
import { backupManager } from '../backup';
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../updateChecker';
import { DatabaseConfig } from '../../types/config';
import { encryptionManager } from '../encryption';
import * as databaseCreator from '../databaseCreator';
import { getConfig, saveConfig } from './configIpc';
import { sanitizeDatabaseConfig, sanitizeAppConfig } from '../configHelper';
import { cronManager } from '../cron';
import { resolveConfirmation } from '../mcpConfirmServer';

export function registerSystemHandlers(mainWindow: BrowserWindow | null) {

    // Prerequisites Handlers
    ipcMain.handle('check-prerequisites', async () => {
        try {
            const { checkPrerequisites } = await import('../prerequisites/prerequisitesManager');
            const prerequisites = await checkPrerequisites();

            return {
                pgDump: {
                    installed: prerequisites.pgDump.installed,
                    path: prerequisites.pgDump.path,
                    error: prerequisites.pgDump.error
                },
                psql: {
                    installed: prerequisites.psql.installed,
                    path: prerequisites.psql.path,
                    error: prerequisites.psql.error
                },
                homebrew: prerequisites.homebrew ? {
                    installed: prerequisites.homebrew.installed,
                    path: prerequisites.homebrew.path,
                    error: prerequisites.homebrew.error
                } : { installed: true },
                postgresServer: prerequisites.postgresServer
            };
        } catch (error: any) {
            logger.error(`Error checking prerequisites: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('install-homebrew', async () => {
        try {
            const { installHomebrew } = await import('../tools/toolInstaller');
            const onProgress = (progress: { step: string; message: string; progress: number }) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('install-progress', progress);
                }
            };
            return await installHomebrew(onProgress);
        } catch (error: any) {
            logger.error(`Error installing Homebrew: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('install-postgresql', async () => {
        try {
            const { installPostgreSQL } = await import('../tools/toolInstaller');
            const { detectHomebrew } = await import('../tools/toolDetector');

            // Détecter le chemin complet de brew pour le passer à l'installateur
            let brewPath: string | undefined;
            const homebrewResult = await detectHomebrew();
            if (homebrewResult.installed && homebrewResult.path) {
                brewPath = homebrewResult.path;
            }

            const onProgress = (progress: { step: string; message: string; progress: number }) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('install-progress', progress);
                }
            };
            return await installPostgreSQL(onProgress, { brewPath });
        } catch (error: any) {
            logger.error(`Error installing PostgreSQL: ${error.message}`);
            throw error;
        }
    });



    // MCP Confirmation Handler
    ipcMain.handle('mcp-confirm-response', (_, { id, approved }: { id: string; approved: boolean }) => {
        resolveConfirmation(id, approved);
    });

    // Backup & Restore Handlers
    ipcMain.handle('backup-now', async (_, id: string) => {
        try {
            const config = getConfig();
            const db = config.databases.find(d => d.id === id);
            if (!db) {
                const error = `Database not found: ${id}`;
                logger.error(error);
                return { success: false, database: id, timestamp: new Date().toISOString(), error };
            }

            let decryptedDb = { ...db };
            try {
                if (db.encrypted) {
                    decryptedDb.password = encryptionManager.decrypt(db.password);
                }
            } catch (error) {
                const msg = `Failed to decrypt password for ${db.name}: ${error}`;
                logger.error(msg);
                return { success: false, database: db.name, timestamp: new Date().toISOString(), error: msg };
            }

            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backup-started', id);

            const result = await backupManager.backupDatabase(decryptedDb);

            if (result.success) {
                const dbIndex = config.databases.findIndex(d => d.id === id);
                if (dbIndex !== -1) {
                    config.databases[dbIndex].lastBackup = result.timestamp;
                    saveConfig(config);
                }
            }

            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backup-complete', { ...result, databaseId: id });
            return result;
        } catch (error) {
            const msg = `Unexpected error during backup of ${id}: ${error}`;
            logger.error(msg);
            return { success: false, database: id, timestamp: new Date().toISOString(), error: msg };
        }
    });

    ipcMain.handle('restore-backup', async (_, payload: { backupFile: string; target: { name: string; host: string; port: number; user: string; password: string } }) => {
        const { backupFile, target } = payload;
        logger.info(`Restore request: ${backupFile} to ${target.name}@${target.host}:${target.port}`);

        try {
            return await backupManager.restoreBackup(backupFile, target);
        } catch (error) {
            logger.error(`Error during restore: ${error}`);
            return {
                success: false,
                database: target.name,
                timestamp: new Date().toISOString(),
                error: `Unexpected error: ${error}`
            };
        }
    });

    ipcMain.handle('get-backups', async () => {
        try {
            const backupDir = pathManager.backupsPath;
            if (!fs.existsSync(backupDir)) {
                return { backups: [], stats: { total: 0, totalSize: 0 } };
            }

            const config = getConfig();
            const files = fs.readdirSync(backupDir);
            const backups = files
                .filter(file => file.endsWith('.backup'))
                .map(file => {
                    const filePath = path.join(backupDir, file);
                    const stats = fs.statSync(filePath);
                    const isEncrypted = fileEncryptionManager.isFileEncrypted(filePath);

                    const fileNameWithoutExt = file.replace('.backup', '');
                    const parts = fileNameWithoutExt.split('_');
                    const prefix = parts[0] || 'unknown';

                    // Try to match by id first, then by name (backwards compatibility)
                    const matchedDb = config.databases.find(d => d.id === prefix) ||
                                     config.databases.find(d => d.name === prefix);
                    const databaseId = matchedDb ? matchedDb.id : prefix;

                    return {
                        filename: file,
                        databaseId: databaseId,
                        name: file,
                        path: path.relative(pathManager.appDataPath, filePath),
                        size: stats.size,
                        created: stats.birthtime.toISOString(),
                        encrypted: isEncrypted
                    };
                })
                .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

            const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);

            return { backups, stats: { total: backups.length, totalSize } };
        } catch (error) {
            logger.error(`Error retrieving backups: ${error}`);
            return { backups: [], stats: { total: 0, totalSize: 0 } };
        }
    });

    ipcMain.handle('delete-backup', async (_, filename: string) => {
        try {
            const backupDir = pathManager.backupsPath;
            const filePath = path.resolve(backupDir, filename);
            const normalizedDir = path.resolve(backupDir) + path.sep;

            if (!filePath.startsWith(normalizedDir)) throw new Error('Invalid path');

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                logger.info(`Backup deleted: ${filename}`);
                return { success: true };
            } else {
                throw new Error('File not found');
            }
        } catch (error) {
            logger.error(`Error deleting ${filename}: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('download-backup', async (_, filename: string) => {
        try {
            const { dialog } = require('electron');
            const backupDir = pathManager.backupsPath;
            const filePath = path.resolve(backupDir, filename);
            const normalizedDir = path.resolve(backupDir) + path.sep;

            if (!filePath.startsWith(normalizedDir)) throw new Error('Invalid path');
            if (!fs.existsSync(filePath)) throw new Error('File not found');
            if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Window not available');

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'Download backup',
                defaultPath: filename,
                filters: [
                    { name: 'Backup files', extensions: ['backup'] },
                    { name: 'All files', extensions: ['*'] }
                ]
            });

            if (result.canceled || !result.filePath) return { success: false, cancelled: true };

            fs.copyFileSync(filePath, result.filePath);
            logger.info(`Backup downloaded to: ${result.filePath}`);
            return { success: true, path: result.filePath };
        } catch (error) {
            logger.error(`Error downloading backup ${filename}: ${error}`);
            throw error;
        }
    });

    // Logs Handlers
    ipcMain.handle('get-logs', async (_, limit?: number) => {
        return logger.getLogs(limit);
    });

    ipcMain.handle('clear-logs', async () => {
        logger.clearLogs();
    });

    ipcMain.handle('get-scheduled-tasks', async () => {
        return cronManager.getScheduledTasks();
    });

    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('get-default-path', () => pathManager.backupsPath);

    ipcMain.handle('select-directory', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    // Updates
    ipcMain.handle('check-for-updates', async () => {
        return await checkForUpdates();
    });

    ipcMain.handle('download-update', async () => {
        await downloadUpdate();
    });

    ipcMain.handle('install-update', () => {
        quitAndInstall();
    });

    // Encryption Key Handlers
    ipcMain.handle('check-encryption-key', async () => {
        const keyPath = pathManager.encryptionKeyPath;
        return { exists: fs.existsSync(keyPath), path: keyPath };
    });

    // Aliases for compatibility
    ipcMain.handle('check-key-status', async () => {
        const keyPath = pathManager.encryptionKeyPath;
        return { exists: fs.existsSync(keyPath), path: keyPath };
    });

    ipcMain.handle('export-encryption-key', async () => {
        try {
            const { dialog } = require('electron');
            const keyPath = pathManager.encryptionKeyPath;

            if (!fs.existsSync(keyPath)) return { success: false, error: 'Encryption key not found' };
            if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'Window not available' };

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'Export encryption key',
                defaultPath: `encryption-key-backup-${new Date().toISOString().split('T')[0]}.key`,
                filters: [{ name: 'Key file', extensions: ['key'] }, { name: 'All files', extensions: ['*'] }]
            });

            if (result.canceled || !result.filePath) return { success: false, cancelled: true };

            fs.copyFileSync(keyPath, result.filePath);
            logger.info(`Encryption key exported to: ${result.filePath}`);

            return { success: true, path: result.filePath };
        } catch (error) {
            logger.error(`Error exporting key: ${error}`);
            return { success: false, error: String(error) };
        }
    });

    ipcMain.handle('import-encryption-key', async () => {
        try {
            const { dialog } = require('electron');
            const keyPath = pathManager.encryptionKeyPath;

            if (!mainWindow || mainWindow.isDestroyed()) return { success: false, error: 'Window not available' };

            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Import encryption key',
                filters: [{ name: 'Key file', extensions: ['key'] }, { name: 'All files', extensions: ['*'] }],
                properties: ['openFile']
            });

            if (result.canceled || result.filePaths.length === 0) return { success: false, cancelled: true };

            const importPath = result.filePaths[0];
            const importedKey = fs.readFileSync(importPath, 'utf8').trim();
            if (importedKey.length !== 64) return { success: false, error: 'Invalid key file (incorrect size)' };

            if (fs.existsSync(keyPath)) {
                const backupPath = path.join(pathManager.appDataPath, `.encryption.key.backup-${Date.now()}`);
                fs.copyFileSync(keyPath, backupPath);
            }

            fs.copyFileSync(importPath, keyPath);
            try { fs.chmodSync(keyPath, 0o600); } catch (e) { logger.warn(`Unable to set permissions: ${e}`); }

            logger.info('Encryption key imported successfully');
            return { success: true };
        } catch (error) {
            logger.error(`Error importing key: ${error}`);
            return { success: false, error: String(error) };
        }
    });

    // MCP Server Handlers
    ipcMain.handle('get-mcp-status', async () => {
        try {
            const configPath = pathManager.claudeDesktopConfigPath;
            const serverPath = pathManager.mcpServerPath;
            const configExists = fs.existsSync(configPath);
            let installed = false;

            if (configExists) {
                const raw = fs.readFileSync(configPath, 'utf-8');
                const config = JSON.parse(raw);
                installed = !!(config.mcpServers && config.mcpServers['bbdump-postgres']);
            }

            // Detect if Claude Desktop is installed
            let claudeDesktopDetected = false;
            if (process.platform === 'darwin') {
                claudeDesktopDetected = fs.existsSync('/Applications/Claude.app');
            } else if (process.platform === 'win32') {
                const localAppData = process.env.LOCALAPPDATA || '';
                claudeDesktopDetected = fs.existsSync(path.join(localAppData, 'Programs', 'claude-desktop'))
                    || fs.existsSync(path.join(localAppData, 'AnthropicClaude'));
            } else {
                // Linux: check if config dir exists (created on first run)
                claudeDesktopDetected = fs.existsSync(path.dirname(configPath));
            }

            return { installed, configExists, configPath, serverPath, claudeDesktopDetected, bbdumpConfigPath: pathManager.configPath, bbdumpKeyPath: pathManager.encryptionKeyPath };
        } catch (error: any) {
            logger.error(`Error checking MCP status: ${error.message}`);
            return { installed: false, configExists: false, configPath: pathManager.claudeDesktopConfigPath, serverPath: pathManager.mcpServerPath, claudeDesktopDetected: false, bbdumpConfigPath: pathManager.configPath, bbdumpKeyPath: pathManager.encryptionKeyPath };
        }
    });

    ipcMain.handle('install-mcp-claude-desktop', async () => {
        try {
            const configPath = pathManager.claudeDesktopConfigPath;
            const serverPath = pathManager.mcpServerPath;

            // Ensure directory exists
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // Read existing config or create empty
            let config: any = {};
            if (fs.existsSync(configPath)) {
                const raw = fs.readFileSync(configPath, 'utf-8');
                config = JSON.parse(raw);
            }

            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            // Pass bbdump config and encryption key paths
            // The MCP server reads database connections from bbdump's config
            const env: Record<string, string> = {
                BBDUMP_CONFIG_PATH: pathManager.configPath,
                BBDUMP_KEY_PATH: pathManager.encryptionKeyPath,
                MCP_CONFIRM_PORT_FILE: path.join(pathManager.appDataPath, '.mcp-confirm-port'),
                BBDUMP_APP_PATH: app.isPackaged
                    ? (process.platform === 'darwin' ? app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '') : app.getPath('exe'))
                    : '',
            };

            config.mcpServers['bbdump-postgres'] = {
                command: 'node',
                args: [serverPath],
                env
            };

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            logger.info(`MCP server installed in Claude Desktop config: ${configPath}`);

            return { success: true, configPath };
        } catch (error: any) {
            logger.error(`Error installing MCP for Claude Desktop: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('uninstall-mcp-claude-desktop', async () => {
        try {
            const configPath = pathManager.claudeDesktopConfigPath;

            if (!fs.existsSync(configPath)) {
                return { success: true };
            }

            const raw = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw);

            if (config.mcpServers && config.mcpServers['bbdump-postgres']) {
                delete config.mcpServers['bbdump-postgres'];
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
                logger.info('MCP server removed from Claude Desktop config');
            }

            return { success: true };
        } catch (error: any) {
            logger.error(`Error uninstalling MCP from Claude Desktop: ${error.message}`);
            return { success: false, error: error.message };
        }
    });
}

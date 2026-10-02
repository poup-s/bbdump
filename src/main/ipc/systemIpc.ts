import { ipcMain, app, BrowserWindow, dialog, nativeImage } from 'electron';
import { getErrorMessage } from '../utils';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { pathManager } from '../paths';
import { backupManager } from '../backup';
import { checkForUpdates, downloadUpdate, quitAndInstall, supportsAutoInstall } from '../updateChecker';
import { toRuntimeDatabase } from '../dbSecrets';
import { listBackupEntries, runBackupNow } from '../backupActions';
import { defaultBackupDir, resolveBackupFile } from '../backupLocations';
import { getConfig } from './configIpc';
import { cronManager } from '../cron';
import { withTunnel } from '../sshTunnel';
import * as nodeCron from 'node-cron';
import { nextRun, previousRun } from '../cronSchedule';
import { resolveConfirmation } from '../mcpConfirmServer';
import {
    McpClientId, getClientDefs, getClientStatus, listClientStatuses,
    installClient, uninstallClient, buildCustomSnippet,
} from '../mcpClients';
import { getMcpClientContext, getMcpLaunchSpec, isAppTranslocated } from '../mcpLaunch';

function isKnownMcpClient(id: unknown): id is McpClientId {
    return typeof id === 'string' && getClientDefs().some((c) => c.id === id);
}

export function registerSystemHandlers(getMainWindow: () => BrowserWindow | null) {

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
                pgRestore: {
                    installed: prerequisites.pgRestore.installed,
                    path: prerequisites.pgRestore.path,
                    error: prerequisites.pgRestore.error
                },
                homebrew: prerequisites.homebrew ? {
                    installed: prerequisites.homebrew.installed,
                    path: prerequisites.homebrew.path,
                    error: prerequisites.homebrew.error
                } : { installed: true },
                postgresServer: prerequisites.postgresServer
            };
        } catch (error) {
            logger.error(`Error checking prerequisites: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('install-homebrew', async () => {
        try {
            const { installHomebrew } = await import('../tools/toolInstaller');
            const onProgress = (progress: { step: string; message: string; progress: number }) => {
                getMainWindow()?.webContents.send('install-progress', progress);
            };
            return await installHomebrew(onProgress);
        } catch (error) {
            logger.error(`Error installing Homebrew: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('install-postgresql', async () => {
        try {
            const { installPostgreSQL } = await import('../tools/toolInstaller');
            const { detectHomebrew } = await import('../tools/toolDetector');

            // Detect the full brew path to pass to the installer
            let brewPath: string | undefined;
            const homebrewResult = await detectHomebrew();
            if (homebrewResult.installed && homebrewResult.path) {
                brewPath = homebrewResult.path;
            }

            const onProgress = (progress: { step: string; message: string; progress: number }) => {
                getMainWindow()?.webContents.send('install-progress', progress);
            };
            return await installPostgreSQL(onProgress, { brewPath });
        } catch (error) {
            logger.error(`Error installing PostgreSQL: ${getErrorMessage(error)}`);
            throw error;
        }
    });



    // MCP Confirmation Handler
    ipcMain.handle('mcp-confirm-response', (_, { id, approved }: { id: string; approved: boolean }) => {
        resolveConfirmation(id, approved);
    });

    // Backup & Restore Handlers
    ipcMain.handle('backup-now', async (_, id: string) =>
        runBackupNow(id, (channel, payload) => getMainWindow()?.webContents.send(channel, payload)));

    ipcMain.handle('restore-backup', async (_, payload: { backupFile: string; target: { name: string; host: string; port: number; user: string; password: string; connectionString?: string }; replace?: boolean }) => {
        const { backupFile, target } = payload;
        logger.info(`Restore request: ${backupFile} to ${target.name}@${target.host}:${target.port}`);

        try {
            // The renderer only has masked passwords and no SSL settings: take the
            // credentials (decrypted, injected into the URI) from the matching saved database
            const saved = getConfig().databases.find(d =>
                d.name === target.name && d.host === target.host && d.port === target.port);
            let fromSaved = {};
            if (saved) {
                const runtime = toRuntimeDatabase(saved);
                fromSaved = {
                    password: runtime.password,
                    connectionString: runtime.connectionString ?? target.connectionString,
                    ssl: saved.ssl, sslMode: saved.sslMode, sslRootCert: saved.sslRootCert,
                };
            }
            // A database on a server: through its SSH tunnel, kept open for the whole restore
            const merged = { ...target, ...fromSaved, ssh: saved?.ssh };
            // The target's content is replaced unless the caller says otherwise
            return await withTunnel(merged, reached => backupManager.restoreBackup(backupFile, reached, { replace: payload.replace !== false }));
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
            // Every folder backups are written to (database output, default folder, internal)
            const backups = listBackupEntries(getConfig());
            const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);
            return { backups, stats: { total: backups.length, totalSize } };
        } catch (error) {
            logger.error(`Error retrieving backups: ${error}`);
            return { backups: [], stats: { total: 0, totalSize: 0 } };
        }
    });

    ipcMain.handle('delete-backup', async (_, filename: string) => {
        try {
            const filePath = resolveBackupFile(getConfig(), filename);
            if (!filePath) throw new Error('Invalid path');

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
            const filePath = resolveBackupFile(getConfig(), filename);
            if (!filePath) throw new Error('Invalid path');
            if (!fs.existsSync(filePath)) throw new Error('File not found');
            const mainWindow = getMainWindow();
            if (!mainWindow) throw new Error('Window not available');

            const result = await dialog.showSaveDialog(mainWindow, {
                title: 'Download backup',
                defaultPath: path.basename(filePath),
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
    ipcMain.handle('logs-read', async (_, from?: { offset: number; fileId: number }) => {
        const valid = from && Number.isSafeInteger(from.offset) && from.offset >= 0 && Number.isSafeInteger(from.fileId);
        return logger.readLogs(valid ? from : undefined);
    });

    ipcMain.handle('clear-logs', async () => {
        logger.clearLogs();
    });

    /**
     * Tasks and Backups pages: per database, its schedule (next run, missed run, paused),
     * its last runs (successes and failures), its retention and its backup files.
     */
    ipcMain.handle('schedule-overview', async () => {
        const config = getConfig();
        const now = new Date();
        const files = listBackupEntries(config);
        const history = backupManager.backupHistory();
        const databases = config.databases.map(db => {
            const cronText = (db.cron || '').trim();
            const enabled = db.enabled !== false;
            let next: string | null = null;
            let missed = false;
            if (cronText && nodeCron.validate(cronText)) {
                try {
                    if (enabled) next = nextRun(cronText, now)?.toISOString() ?? null;
                    const expected = enabled ? previousRun(cronText, now) : null;
                    const last = db.lastBackup ? new Date(db.lastBackup) : null;
                    // Only after the app had a chance to run it (the catch-up runs at startup)
                    missed = !!expected && (!last || last < expected) && now.getTime() - expected.getTime() > 5 * 60 * 1000;
                } catch (error) {
                    logger.warn(`Schedule "${cronText}" cannot be evaluated: ${getErrorMessage(error)}`, db.name);
                }
            }
            const own = files.filter(f => f.databaseId === db.id);
            return {
                id: db.id,
                cron: cronText,
                cronValid: !cronText || nodeCron.validate(cronText),
                enabled,
                scheduled: cronManager.isScheduled(db.id),
                running: backupManager.isRunning(db.id),
                nextRun: next,
                missed,
                lastBackup: db.lastBackup ?? null,
                runs: history.runs(db.id).slice(0, 12),
                retentionCount: db.retentionCount ?? null,
                verifyBackups: db.verifyBackups !== false,
                encryptBackups: !!db.encryptBackups,
                backupCount: own.length,
                backupSize: own.reduce((sum, f) => sum + f.size, 0),
            };
        });
        return { databases, launchAtLogin: !!config.launchAtLogin };
    });

    ipcMain.handle('get-scheduled-tasks', async () => {
        return cronManager.getScheduledTasks();
    });

    ipcMain.handle('get-app-version', () => app.getVersion());
    /** Info page: versions, system, PostgreSQL tools and where bbdump keeps its files */
    ipcMain.handle('get-about-info', async () => {
        let pgDump: { version?: string; path?: string } | null = null;
        try {
            const { detectPostgresTools } = await import('../tools/toolDetector');
            const tools = await detectPostgresTools();
            if (tools.pgDump.installed) pgDump = { version: tools.pgDump.version, path: tools.pgDump.path };
        } catch (error) {
            logger.warn(`Info page: pg_dump detection failed: ${getErrorMessage(error)}`);
        }
        return {
            version: app.getVersion(),
            packaged: app.isPackaged,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            osVersion: process.getSystemVersion(),
            pgDump,
            dataPath: pathManager.appDataPath,
            logsPath: pathManager.logsPath,
            configPath: pathManager.configPath,
            home: app.getPath('home'),
            autoInstallUpdates: supportsAutoInstall(),
        };
    });
    // The user's default folder if set (Settings showed the internal one even after a change)
    ipcMain.handle('get-default-path', () => defaultBackupDir(getConfig()));

    ipcMain.handle('select-ssl-root-cert', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
                { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    // Updates
    ipcMain.handle('check-for-updates', async () => {
        return await checkForUpdates();
    });

    ipcMain.handle('download-update', async () => {
        return await downloadUpdate();
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
            const keyPath = pathManager.encryptionKeyPath;

            if (!fs.existsSync(keyPath)) return { success: false, error: 'Encryption key not found' };
            const mainWindow = getMainWindow();
            if (!mainWindow) return { success: false, error: 'Window not available' };

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
            const keyPath = pathManager.encryptionKeyPath;

            const mainWindow = getMainWindow();
            if (!mainWindow) return { success: false, error: 'Window not available' };

            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Import encryption key',
                filters: [{ name: 'Key file', extensions: ['key'] }, { name: 'All files', extensions: ['*'] }],
                properties: ['openFile']
            });

            if (result.canceled || result.filePaths.length === 0) return { success: false, cancelled: true };

            const importPath = result.filePaths[0];
            const importedKey = fs.readFileSync(importPath, 'utf8').trim();
            if (importedKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(importedKey)) return { success: false, error: 'Invalid key file (incorrect size or format)' };

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
    // Real app icons of installed AI clients (read from the system, never bundled)
    const iconCache = new Map<string, string>();
    ipcMain.handle('mcp-client-icons', async () => {
        const icons: Record<string, string> = {};
        const statuses = listClientStatuses(getMcpClientContext(), getMcpLaunchSpec());
        for (const client of statuses) {
            if (!client.appPath) continue;
            try {
                let dataUrl = iconCache.get(client.appPath);
                if (!dataUrl) {
                    // QuickLook thumbnail: Retina-sharp app icon on macOS; getFileIcon as fallback
                    const image = process.platform === 'darwin'
                        ? await nativeImage.createThumbnailFromPath(client.appPath, { width: 64, height: 64 })
                            .catch(() => app.getFileIcon(client.appPath!, { size: 'normal' }))
                        : await app.getFileIcon(client.appPath, { size: 'normal' });
                    dataUrl = image.isEmpty() ? '' : image.toDataURL();
                    iconCache.set(client.appPath, dataUrl);
                }
                if (dataUrl) icons[client.id] = dataUrl;
            } catch (error) {
                logger.warn(`No icon for ${client.name}: ${getErrorMessage(error)}`);
            }
        }
        return icons;
    });

    ipcMain.handle('mcp-list-clients', async () => {
        try {
            return listClientStatuses(getMcpClientContext(), getMcpLaunchSpec());
        } catch (error) {
            logger.error(`Error listing MCP clients: ${getErrorMessage(error)}`);
            return [];
        }
    });

    ipcMain.handle('mcp-install-client', async (_, id: unknown) => {
        if (!isKnownMcpClient(id)) return { success: false, error: 'Unknown MCP client' };
        try {
            const configPath = installClient(id, getMcpClientContext(), getMcpLaunchSpec());
            logger.info(`MCP server installed for ${id}: ${configPath}`);
            return { success: true, configPath };
        } catch (error) {
            logger.error(`Error installing MCP for ${id}: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('mcp-uninstall-client', async (_, id: unknown) => {
        if (!isKnownMcpClient(id)) return { success: false, error: 'Unknown MCP client' };
        try {
            const configPath = uninstallClient(id, getMcpClientContext());
            logger.info(`MCP server removed for ${id}: ${configPath}`);
            return { success: true, configPath };
        } catch (error) {
            logger.error(`Error uninstalling MCP for ${id}: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('mcp-get-custom-config', async () => {
        const spec = getMcpLaunchSpec();
        return { snippet: buildCustomSnippet(spec), spec, translocated: isAppTranslocated() };
    });

    // Legacy channels (Claude Desktop only), kept for compatibility
    ipcMain.handle('get-mcp-status', async () => {
        const spec = getMcpLaunchSpec();
        const status = getClientStatus('claude-desktop', getMcpClientContext(), spec);
        return {
            installed: status.installed,
            state: status.state,
            configExists: fs.existsSync(status.configPath),
            configPath: status.configPath,
            serverPath: spec.args[0],
            claudeDesktopDetected: status.detected,
            bbdumpConfigPath: pathManager.configPath,
            bbdumpKeyPath: pathManager.encryptionKeyPath,
        };
    });

    ipcMain.handle('install-mcp-claude-desktop', async () => {
        try {
            const configPath = installClient('claude-desktop', getMcpClientContext(), getMcpLaunchSpec());
            logger.info(`MCP server installed in Claude Desktop config: ${configPath}`);
            return { success: true, configPath };
        } catch (error) {
            logger.error(`Error installing MCP for Claude Desktop: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('uninstall-mcp-claude-desktop', async () => {
        try {
            uninstallClient('claude-desktop', getMcpClientContext());
            logger.info('MCP server removed from Claude Desktop config');
            return { success: true };
        } catch (error) {
            logger.error(`Error uninstalling MCP from Claude Desktop: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });
}

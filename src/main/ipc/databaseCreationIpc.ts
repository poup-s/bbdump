import { ipcMain, BrowserWindow } from 'electron';
import { getErrorMessage } from '../utils';
import * as databaseCreator from '../databaseCreator';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getConfig, saveConfig } from './configIpc';
import { sanitizeDatabaseConfig } from '../configHelper';
import { encryptionManager } from '../encryption';
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from '../paths';
import { DatabaseConfig } from '../../types/config';

// Define explicit types for database objects to avoid TS errors
interface DatabaseInfo {
    id?: string;
    name: string;
    displayName?: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    encrypted?: boolean;
}

export function registerDatabaseCreationHandlers(mainWindow: BrowserWindow | null) {

    ipcMain.handle('create-local-database', async (_, params: { name: string; displayName?: string; port: number; password?: string; enabled?: boolean }) => {
        try {
            const config = getConfig();
            const existingPorts = config.databases.map(db => db.port);

            let lastProgress: { step: string; message: string; progress: number } | undefined;

            const result = await databaseCreator.createLocalDatabase(
                params,
                existingPorts,
                (progress: { step: string; message: string; progress: number }) => {
                    lastProgress = progress;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('create-database-progress', progress);
                    }
                }
            );

            if (!result.success || !result.database) {
                return {
                    success: false,
                    error: result.error,
                    progress: lastProgress
                };
            }

            // Cast to DatabaseInfo to handle optional properties safely
            const newDb = result.database as DatabaseInfo;
            const shouldEncrypt = newDb.encrypted !== false;
            const sanitizedDb = sanitizeDatabaseConfig(newDb as any); // Cast to any for helper compatibility if needed

            const dbToSave = {
                ...sanitizedDb,
                enabled: params.enabled !== undefined ? params.enabled : false, // No backup by default for new local DBs
                encrypted: shouldEncrypt,
                password: shouldEncrypt && newDb.password ? encryptionManager.encrypt(newDb.password) : (newDb.password || ''),
                isLocalBbdump: true
            };

            config.databases.push(dbToSave);
            saveConfig(config);

            logger.info(`New local database added to config: ${newDb.name}`);

            return {
                success: true,
                database: newDb
            };

        } catch (error) {
            logger.error(`Error creating local database: ${getErrorMessage(error)}`);
            return {
                success: false,
                error: getErrorMessage(error)
            };
        }
    });

    ipcMain.handle('duplicate-external-to-local', async (_, params: {
        sourceDb: any;
        targetName: string;
        targetPort: number;
        targetPassword?: string;
    }) => {
        // Helper to send progress
        const sendProgress = (step: string, message: string, progress: number) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('duplicate-progress', { step, message, progress });
            }
        };

        // Track created backup file for cleanup on error
        let createdBackupFile: string | null = null;

        try {
            const config = getConfig();

            const sourceDbId = params.sourceDb?.id;
            if (!sourceDbId) {
                throw new Error('Source database id is required');
            }

            const sourceDb = config.databases.find(d => d.id === sourceDbId);

            if (!sourceDb) {
                throw new Error(`Source database not found: ${sourceDbId}`);
            }

            // 1. Decrypt password if needed
            let sourcePassword = sourceDb.password;
            if (sourceDb.encrypted) {
                sourcePassword = encryptionManager.decrypt(sourceDb.password);
            }

            // 2. Backup Source
            sendProgress('backup', `Creating backup from external database "${sourceDb.name}"...`, 10);
            logger.info(`Creating backup from external database "${sourceDb.name}"`);

            // Create a temporary config for the backup
            const sourceDbConfig: DatabaseConfig = {
                ...sourceDb,
                password: sourcePassword // Decrypted for usage
            };

            const backupResult = await backupManager.executeBackup(sourceDbConfig);

            if (!backupResult.success) {
                return {
                    success: false,
                    error: `Failed to backup source database: ${backupResult.error || 'Unknown error'}`
                };
            }

            // Update source DB last backup time
            if (backupResult.timestamp) {
                const sourceIndex = config.databases.findIndex(d => d.id === sourceDbId);
                if (sourceIndex !== -1) {
                    config.databases[sourceIndex].lastBackup = backupResult.timestamp;
                    saveConfig(config);
                }
            }

            sendProgress('backup', 'Backup created successfully', 30);

            // Use the backup file path returned directly by executeBackup
            let backupFile = backupResult.filePath;

            // Fallback: search filesystem if filePath not returned (backwards compat)
            if (!backupFile || !fs.existsSync(backupFile)) {
                logger.warn(`Backup filePath not available or missing (${backupFile}), searching filesystem...`);
                const backupDir = sourceDbConfig.output || config.defaultBackupPath || pathManager.backupsPath;
                const backupFiles = fs.readdirSync(backupDir)
                    .filter(f => (f.startsWith(`${sourceDbConfig.id}_`) || f.startsWith(`${sourceDbConfig.name}_`)) && f.endsWith('.backup'))
                    .map(f => ({
                        name: f,
                        path: path.join(backupDir, f),
                        time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
                    }))
                    .sort((a, b) => b.time - a.time);

                if (backupFiles.length === 0) {
                    return {
                        success: false,
                        error: 'Backup file not found after backup operation'
                    };
                }
                backupFile = backupFiles[0].path;
            }
            createdBackupFile = backupFile;

            // 3. Create Local Database
            sendProgress('creating', `Creating local database "${params.targetName}"...`, 40);
            const existingPorts = config.databases.map(db => db.port);
            const createResult = await databaseCreator.createLocalDatabase(
                {
                    name: params.targetName,
                    displayName: params.targetName,
                    port: params.targetPort,
                    password: params.targetPassword
                },
                existingPorts
            );

            if (!createResult.success || !createResult.database) {
                return {
                    success: false,
                    error: `Failed to create local database: ${createResult.error || 'Unknown error'}`
                };
            }

            sendProgress('creating', 'Local database created successfully', 60);

            // 4. Restore Backup to Local DB
            sendProgress('restoring', `Restoring backup to local database "${params.targetName}"...`, 70);

            const newDbUser = createResult.database.user;

            // Pass full path directly — restoreBackup handles both absolute and relative paths
            const restoreResult = await backupManager.restoreBackup(backupFile, {
                name: params.targetName,
                host: 'localhost',
                port: params.targetPort,
                user: newDbUser,
                password: '', // Local DBs usually trust local connections or use ident/peer
                connectionString: undefined
            });

            if (!restoreResult.success) {
                return {
                    success: false,
                    error: `Failed to restore backup: ${restoreResult.error || 'Unknown error'}`
                };
            }

            sendProgress('restoring', 'Backup restored successfully', 90);

            // 5. Add new DB to config
            sendProgress('complete', 'Adding database to configuration...', 95);

            const targetDbConfig: DatabaseConfig = sanitizeDatabaseConfig({
                name: params.targetName,
                displayName: params.targetName,
                host: 'localhost',
                port: params.targetPort,
                user: newDbUser,
                password: params.targetPassword || '',
                encrypted: !!params.targetPassword,
                encryptBackups: false,
                cron: '0 0 * * *',
                output: config.defaultBackupPath || pathManager.backupsPath,
                enabled: false,
                ssl: false,
                isLocalBbdump: true
            });

            if (backupResult.timestamp) {
                targetDbConfig.lastBackup = backupResult.timestamp;
            }

            config.databases.push(targetDbConfig);
            saveConfig(config);

            // Duplication succeeded, backup file is kept as part of normal backups
            createdBackupFile = null;

            sendProgress('complete', 'Database duplicated successfully', 100);

            return { success: true };

        } catch (error) {
            logger.error(`Error duplicating database: ${getErrorMessage(error)}`);
            // Cleanup backup file created during failed duplication
            if (createdBackupFile) {
                try {
                    if (fs.existsSync(createdBackupFile)) {
                        fs.unlinkSync(createdBackupFile);
                        logger.info(`Cleaned up backup file after failed duplication: ${createdBackupFile}`);
                    }
                } catch (cleanupError) {
                    logger.warn(`Failed to cleanup backup file: ${cleanupError}`);
                }
            }
            return { success: false, error: getErrorMessage(error) };
        }
    });
}

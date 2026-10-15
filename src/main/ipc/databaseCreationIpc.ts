import { ipcMain, BrowserWindow } from 'electron';
import { getErrorMessage } from '../utils';
import * as databaseCreator from '../databaseCreator';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getConfig, saveConfig } from './configIpc';
import { sanitizeDatabaseConfig } from '../configHelper';
import { encryptionManager } from '../encryption';
import { toRuntimeDatabase } from '../dbSecrets';
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from '../paths';
import { DatabaseConfig } from '../../types/config';
import { withConnection } from '../dbViewer';
import { availableExtensionNames, dropDatabase, getExtensionServerInfo } from '../postgresConfig';
import { missingExtensions } from '../extensionCatalog';
import { readCatalog } from '../sync/catalog';
import { onSource } from '../sync/syncEngine';
import { buildAnonymizePlan, copyAnonymized, resolveAnonymization, type AnonymizeChoices } from '../sync/anonymizedCopy';

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

type SendProgress = (step: string, message: string, progress: number) => void;

/** Adds a copy made on the local server to the saved databases */
function saveLocalCopy(name: string, port: number, user: string, password?: string): void {
    const config = getConfig();
    config.databases.push(sanitizeDatabaseConfig({
        name,
        displayName: name,
        host: 'localhost',
        port,
        user,
        password: password ? encryptionManager.encrypt(password) : '',
        encrypted: !!password,
        encryptBackups: false,
        cron: '0 0 * * *',
        output: config.defaultBackupPath || pathManager.backupsPath,
        enabled: false,
        ssl: false,
        isLocalBbdump: true
    }));
    saveConfig(config);
}

/**
 * Copy with personal data anonymized: the schema from a schema-only dump (in a temporary
 * folder, deleted after), the rows streamed from the source with the chosen columns already
 * replaced. Nothing of the source is kept as a backup, since it would hold the real values.
 */
async function duplicateAnonymized(
    sourceDb: DatabaseConfig,
    params: { targetName: string; targetPort: number; targetPassword?: string },
    choices: AnonymizeChoices,
    sendProgress: SendProgress,
): Promise<{ success: boolean; error?: string; warnings?: string[] }> {
    // Under the backups folder: where pg_dump may write (removed at the end, whatever happens)
    fs.mkdirSync(pathManager.backupsPath, { recursive: true });
    const schemaDir = fs.mkdtempSync(path.join(pathManager.backupsPath, '.schema-'));
    let created = false;
    try {
        sendProgress('schema', `Reading the schema of "${sourceDb.name}"...`, 5);
        // Choices checked before anything is created
        await onSource(sourceDb.id, async src => resolveAnonymization(buildAnonymizePlan(await readCatalog(src), new Map()), choices.columns));
        const dump = await backupManager.dumpSchema(toRuntimeDatabase(sourceDb), schemaDir);
        if (!dump.success || !dump.filePath) {
            return { success: false, error: `Failed to read the source schema: ${dump.error || 'Unknown error'}` };
        }

        sendProgress('creating', `Creating local database "${params.targetName}"...`, 15);
        const config = getConfig();
        const createResult = await databaseCreator.createLocalDatabase(
            { name: params.targetName, displayName: params.targetName, port: params.targetPort, password: params.targetPassword },
            config.databases.map(db => db.port),
        );
        if (!createResult.success || !createResult.database) {
            return { success: false, error: `Failed to create local database: ${createResult.error || 'Unknown error'}` };
        }
        created = true;
        const user = createResult.database.user;
        const target = { host: 'localhost', port: params.targetPort, user, password: createResult.database.password || '', database: params.targetName };

        sendProgress('copying', 'Creating the tables...', 25);
        let copyWarnings: string[] = [];
        let copiedRows = 0;
        const restore = await backupManager.restoreBackup(dump.filePath, { ...target, name: params.targetName }, {
            replace: false,
            loadData: () => onSource(sourceDb.id, src => withConnection(target, async tgt => {
                const sourceCatalog = await readCatalog(src);
                const plan = buildAnonymizePlan(sourceCatalog, new Map());
                const result = await copyAnonymized(src, tgt, sourceCatalog, await readCatalog(tgt), plan, choices, p => {
                    sendProgress('copying', `${p.table} · ${p.rows.toLocaleString('en-US')} rows`, 30 + Math.round((60 * p.index) / Math.max(1, p.total)));
                });
                copyWarnings = result.warnings;
                copiedRows = result.rows;
                sendProgress('copying', 'Creating indexes and constraints...', 92);
            })),
        });
        if (!restore.success) {
            return { success: false, error: restore.error || 'Restore failed' };
        }

        sendProgress('complete', 'Adding database to configuration...', 97);
        saveLocalCopy(params.targetName, params.targetPort, user, createResult.database.password);
        created = false;
        const warnings = [...(restore.warnings ?? []), ...copyWarnings];
        logger.info(`Anonymized copy of "${sourceDb.name}" into "${params.targetName}": ${copiedRows} row(s), ${choices.columns.length} column(s) chosen, ${choices.emptyTables.length} table(s) left empty${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
        sendProgress('complete', 'Database duplicated', 100);
        return { success: true, warnings: warnings.length ? warnings : undefined };
    } catch (error) {
        logger.error(`Error duplicating database with anonymization: ${getErrorMessage(error)}`);
        return { success: false, error: getErrorMessage(error) };
    } finally {
        fs.rmSync(schemaDir, { recursive: true, force: true });
        // A half-made copy is not left on the server
        if (created) {
            const dropped = await dropDatabase(params.targetName, params.targetPort);
            if (!dropped.success) logger.warn(`Could not remove the unfinished copy "${params.targetName}": ${dropped.error}`);
        }
    }
}

export function registerDatabaseCreationHandlers(getMainWindow: () => BrowserWindow | null) {

    // Extensions of the source the local server lacks (e.g. postgis): said before copying, installed on request
    ipcMain.handle('duplicate-check-extensions', async (_, sourceId: string, port: number = 5432) => {
        try {
            const used = await onSource(sourceId, async src =>
                (await src.query<{ extname: string }>('SELECT extname FROM pg_extension ORDER BY 1')).rows.map(r => r.extname));
            const available = await availableExtensionNames(port);
            const server = await getExtensionServerInfo('postgres', port).catch(() => null);
            return { success: true, missing: missingExtensions(used, available, server) };
        } catch (error) {
            logger.warn(`Could not compare the extensions before duplicating: ${getErrorMessage(error)}`);
            return { success: false, missing: [], error: getErrorMessage(error) };
        }
    });

    // Tables and columns of a database, with what can be anonymized: for the duplicate dialog
    ipcMain.handle('duplicate-anonymize-plan', async (_, sourceId: string) => {
        try {
            const plan = await onSource(sourceId, async src => {
                const catalog = await readCatalog(src);
                // Statistics may be missing on small or fresh tables: count those
                const counts = new Map<string, number>();
                for (const table of catalog.tables.values()) {
                    if (table.estimate > 0) continue;
                    const rel = `"${table.schema.replace(/"/g, '""')}"."${table.name.replace(/"/g, '""')}"`;
                    // ONLY: rows of inheriting tables are counted (and copied) with their own table
                    counts.set(table.key, Number((await src.query(`SELECT count(*) AS n FROM ${table.partitioned ? '' : 'ONLY '}${rel}`)).rows[0].n));
                }
                return buildAnonymizePlan(catalog, counts);
            });
            return { success: true, plan };
        } catch (error) {
            logger.error(`Could not read the tables to anonymize: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });


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
                    getMainWindow()?.webContents.send('create-database-progress', progress);
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
            const sanitizedDb = sanitizeDatabaseConfig(newDb);

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
        sourceDb: Partial<DatabaseConfig>;
        targetName: string;
        targetPort: number;
        targetPassword?: string;
        /** Personal data replaced while copying (no backup of the source is made) */
        anonymize?: AnonymizeChoices;
    }) => {
        // Helper to send progress
        const sendProgress = (step: string, message: string, progress: number) => {
            getMainWindow()?.webContents.send('duplicate-progress', { step, message, progress });
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

            if (params.anonymize) {
                return duplicateAnonymized(sourceDb, params, {
                    columns: Array.isArray(params.anonymize.columns) ? params.anonymize.columns : [],
                    emptyTables: Array.isArray(params.anonymize.emptyTables) ? params.anonymize.emptyTables : [],
                }, sendProgress);
            }

            // 2. Backup Source (credentials decrypted below, in sourceDbConfig)
            sendProgress('backup', `Creating backup from external database "${sourceDb.name}"...`, 10);
            logger.info(`Creating backup from external database "${sourceDb.name}"`);

            // Create a temporary config for the backup
            // Decrypted password, also injected into the connection string (stored without it)
            const sourceDbConfig: DatabaseConfig = toRuntimeDatabase(sourceDb);

            // Like any backup of the source: retention applied, run recorded in its history
            const backupResult = await backupManager.backupDatabase(sourceDbConfig, 'manual');

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
                // Trust / peer auth (empty), or the local server's saved password (Windows)
                password: createResult.database.password || '',
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

            // No lastBackup: the dump belongs to the source, the copy was never backed up
            saveLocalCopy(params.targetName, params.targetPort, newDbUser, createResult.database.password);

            // Duplication succeeded, backup file is kept as part of normal backups
            createdBackupFile = null;

            sendProgress('complete', 'Database duplicated successfully', 100);

            // What did not restore (a missing extension, the tables needing it…) is said, not hidden
            return { success: true, warnings: restoreResult.warnings?.length ? restoreResult.warnings : undefined };

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

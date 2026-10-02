import { app, ipcMain } from 'electron';
import { AppConfig, DatabaseConfig, ProjectConfig } from '../../types/config';
import { encryptionManager } from '../encryption';
import { isUsageMode, sanitizeAppConfig, sanitizeDatabaseConfig, sanitizeProjectConfig } from '../configHelper';
import { cronManager } from '../cron';
import { logger } from '../logger';
import { pathManager } from '../paths';
import { tcpProxyManager } from '../tcpProxy';
import * as fs from 'fs';
import * as path from 'path';
import { listBackupFiles } from '../backupLocations';
import { clearInheritedLastBackups } from '../inheritedBackupDate';
import * as crypto from 'crypto';
import { safeResolveLocalUser } from '../localPgUser';
import { applyLaunchAtLogin } from '../loginItem';
import { moveUriPasswordsOutOfConfig, splitUriPassword, toRuntimeDatabase } from '../dbSecrets';

// Local variable to store the configuration in memory
let config: AppConfig = { databases: [] };
const CONFIG_PATH = pathManager.configPath;
const BACKUP_PATH = `${CONFIG_PATH}.bak`;

// Load the configuration
export function loadConfig(): AppConfig {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            let loadedConfig = JSON.parse(data);

            // Migrate passwords embedded in connection strings (stored in clear by v1.0.2)
            // into the encrypted password field
            const movedUriPasswords = moveUriPasswordsOutOfConfig(loadedConfig);

            // Migrate unencrypted passwords
            loadedConfig = encryptionManager.migrateConfig(loadedConfig);

            // Migrate: assign UUID to databases missing an id
            let uuidMigrated = false;
            if (Array.isArray(loadedConfig.databases)) {
                for (const db of loadedConfig.databases) {
                    if (!db.id) {
                        db.id = crypto.randomUUID();
                        uuidMigrated = true;
                    }
                }
            }

            // Sanitize the entire configuration
            loadedConfig = sanitizeAppConfig(loadedConfig);

            // Copies made by "duplicate" up to 1.1 carry their source's last backup date
            try {
                const fileNames = listBackupFiles(loadedConfig).map(file => path.basename(file));
                const fixed = clearInheritedLastBackups(loadedConfig.databases || [], fileNames);
                if (fixed.length) logger.info(`Cleared the last backup date copied from another database: ${fixed.join(', ')}`);
            } catch (error) {
                logger.warn(`Could not check last backup dates: ${error}`);
            }

            // Save if migration was performed
            const originalData = JSON.parse(data);
            const needsSave = uuidMigrated || JSON.stringify(loadedConfig) !== JSON.stringify(originalData);
            if (needsSave) {
                saveConfig(loadedConfig);
                if (movedUriPasswords > 0) {
                    // The .bak is the pre-migration file, with passwords in clear: replace it
                    fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
                }
            }

            logger.info(`Configuration loaded: ${loadedConfig.databases.length} database(s)`);

            // Onboarding check
            if (loadedConfig.onboardingCompleted === undefined && loadedConfig.databases.length > 0) {
                loadedConfig.onboardingCompleted = true;
                saveConfig(loadedConfig);
            }

            // Usage mode (v1.1): users who finished onboarding before it existed keep
            // every feature, local server included
            if (loadedConfig.usageMode === undefined && loadedConfig.onboardingCompleted === true) {
                loadedConfig.usageMode = 'local';
                // Same sign of a configuration written before 1.1: show the 1.1 tour once
                // (the exact earlier version is not known)
                if (loadedConfig.whatsNewSeen === undefined) loadedConfig.whatsNewSeen = '1.0.0';
                saveConfig(loadedConfig);
            }

            config = loadedConfig;
            return loadedConfig;
        } else {
            // Default config
            const defaultConfig: AppConfig = {
                databases: [],
                onboardingCompleted: false,
                language: 'en'
            };
            saveConfig(defaultConfig);
            logger.info('Default configuration created');
            config = defaultConfig;
            return defaultConfig;
        }
    } catch (error) {
        logger.error(`Error loading configuration: ${error}`);
        // Never let the next saveConfig() overwrite an unreadable file: set it aside,
        // then fall back to the last known-good copy if there is one.
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const corruptPath = `${CONFIG_PATH}.corrupt-${Date.now()}`;
                fs.renameSync(CONFIG_PATH, corruptPath);
                logger.warn(`Unreadable configuration moved to ${corruptPath}`);
            }
            if (fs.existsSync(BACKUP_PATH)) {
                // Move (not copy) so a corrupt .bak cannot cause an endless retry loop
                fs.renameSync(BACKUP_PATH, CONFIG_PATH);
                logger.warn('Restoring configuration from config.json.bak');
                return loadConfig();
            }
        } catch (recoveryError) {
            logger.error(`Configuration recovery failed: ${recoveryError}`);
        }
        config = { databases: [] };
        return config;
    }
}

// Save the configuration to disk atomically (write .tmp, then rename), keeping the
// previous version as config.json.bak.
export function saveConfig(newConfig: AppConfig): void {
    const tmpPath = `${CONFIG_PATH}.tmp`;
    try {
        const configToSave = sanitizeAppConfig(newConfig);
        const fd = fs.openSync(tmpPath, 'w', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(configToSave, null, 2), 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (fs.existsSync(CONFIG_PATH)) {
            fs.copyFileSync(CONFIG_PATH, BACKUP_PATH);
        }
        fs.renameSync(tmpPath, CONFIG_PATH);
        logger.info('Configuration saved');
        config = newConfig;
    } catch (error) {
        logger.error(`Error saving configuration: ${error}`);
    }
}

/**
 * Repairs local databases saved with a role that does not exist on this server
 * (v1.0.2 always stored "postgres", while Homebrew creates a role named after the
 * OS user). Returns true when the configuration was changed.
 */
export async function repairLocalDatabaseUsers(): Promise<boolean> {
    let changed = false;
    for (const db of config.databases || []) {
        let password = '';
        try {
            password = db.encrypted && db.password ? encryptionManager.decrypt(db.password) : (db.password || '');
        } catch {
            continue;
        }
        const detectedUser = await safeResolveLocalUser(db, password);
        if (detectedUser) {
            logger.info(`Repairing local role for ${db.name}: "${db.user}" -> "${detectedUser}"`);
            db.user = detectedUser;
            changed = true;
        }
    }
    if (changed) {
        saveConfig(config);
    }
    return changed;
}

/**
 * A connection string pasted with its password: keep the string without it and use
 * that password as the database password (then encrypted like any other).
 */
function withPasswordOutOfUri(db: DatabaseConfig): DatabaseConfig {
    if (!db.connectionString) return db;
    const { connectionString, password } = splitUriPassword(db.connectionString);
    return password === undefined ? db : { ...db, connectionString, password };
}

export function registerConfigHandlers() {
    ipcMain.handle('get-config', async (): Promise<AppConfig> => {
        return {
            ...config,
            databases: (config.databases || []).map(db => {
                const sanitized = sanitizeDatabaseConfig(db);
                return {
                    ...sanitized,
                    password: '••••••••' // Mask passwords
                };
            })
        };
    });

    ipcMain.handle('save-config', async (_, newConfig: AppConfig): Promise<void> => {
        try {
            if (!newConfig || !Array.isArray(newConfig.databases)) {
                throw new Error('Invalid configuration format');
            }
            const sanitized = sanitizeAppConfig(newConfig);
            config = sanitized;
            saveConfig(config);
            const decryptedDatabases = (config.databases || []).map(db => {
                try {
                    return toRuntimeDatabase(db);
                } catch (error) {
                    logger.error(`Failed to decrypt password for ${db.name}: ${error}`);
                    return { ...db, enabled: false };
                }
            });
            cronManager.rescheduleAll(decryptedDatabases);
        } catch (error) {
            logger.error(`Error in save-config: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('complete-onboarding', async (_, settings: { language: 'en' | 'fr', defaultBackupPath: string, usageMode?: unknown }) => {
        if (settings.usageMode !== undefined && !isUsageMode(settings.usageMode)) {
            throw new Error(`Invalid usage mode: ${String(settings.usageMode)}`);
        }
        config.onboardingCompleted = true;
        config.language = settings.language;
        config.defaultBackupPath = settings.defaultBackupPath;
        // The previous onboarding did not send a mode: it always set up a local server
        config.usageMode = settings.usageMode ?? 'local';
        saveConfig(config);
        return config;
    });

    // The "What's new" tour was seen or skipped: not shown again for this version
    ipcMain.handle('whats-new-seen', async () => {
        config.whatsNewSeen = app.getVersion();
        saveConfig(config);
        return config.whatsNewSeen;
    });

    ipcMain.handle('save-settings', async (_, settings: { language?: 'en' | 'fr', defaultBackupPath?: string, allowSqlMutations?: boolean, mcpSkipConfirmation?: boolean, launchAtLogin?: boolean, usageMode?: unknown }) => {
        if (settings.usageMode !== undefined && !isUsageMode(settings.usageMode)) {
            throw new Error(`Invalid usage mode: ${String(settings.usageMode)}`);
        }
        if (settings.usageMode !== undefined) config.usageMode = settings.usageMode;
        if (settings.language) config.language = settings.language;
        if (settings.defaultBackupPath) config.defaultBackupPath = settings.defaultBackupPath;
        if (settings.allowSqlMutations !== undefined) config.allowSqlMutations = settings.allowSqlMutations;
        if (settings.mcpSkipConfirmation !== undefined) config.mcpSkipConfirmation = settings.mcpSkipConfirmation;
        if (settings.launchAtLogin !== undefined) {
            config.launchAtLogin = settings.launchAtLogin;
            applyLaunchAtLogin(settings.launchAtLogin);
        }
        saveConfig(config);
        return config;
    });

    // Database management handlers that modify config
    ipcMain.handle('add-database', async (_, db: DatabaseConfig): Promise<AppConfig> => {
        db = withPasswordOutOfUri(db);
        const shouldEncrypt = db.encrypted !== false;
        const sanitizedDb = sanitizeDatabaseConfig({
            ...db,
            id: db.id || crypto.randomUUID(),
        });

        const passwordValue = db.password || '';
        const detectedUser = await safeResolveLocalUser(sanitizedDb, passwordValue);
        if (detectedUser) {
            sanitizedDb.user = detectedUser;
            db = { ...db, user: detectedUser };
        }
        const dbToSave = {
            ...sanitizedDb,
            encrypted: shouldEncrypt && passwordValue.length > 0,
            password: (shouldEncrypt && passwordValue.length > 0) ? encryptionManager.encrypt(passwordValue) : passwordValue
        };

        config.databases.push(dbToSave);
        saveConfig(config);

        if (db.cron && db.cron.trim() !== '') {
            cronManager.scheduleBackup(db);
        }

        return config;
    });

    ipcMain.handle('update-database', async (_, id: string, updatedDb: DatabaseConfig): Promise<AppConfig> => {
        updatedDb = withPasswordOutOfUri(updatedDb);
        const index = config.databases.findIndex(db => db.id === id);
        if (index !== -1) {
            const existingDb = config.databases[index];
            const shouldEncrypt = updatedDb.encrypted !== false;
            let passwordToSave = existingDb.password;

            if (updatedDb.password && updatedDb.password !== '••••••••' && updatedDb.password.trim() !== '') {
                passwordToSave = shouldEncrypt ? encryptionManager.encrypt(updatedDb.password) : updatedDb.password;
            } else if (existingDb.encrypted !== shouldEncrypt) {
                if (shouldEncrypt && !existingDb.encrypted) {
                    passwordToSave = encryptionManager.encrypt(existingDb.password);
                } else if (!shouldEncrypt && existingDb.encrypted) {
                    passwordToSave = encryptionManager.decrypt(existingDb.password);
                }
            }

            const dbToSave = sanitizeDatabaseConfig({
                ...updatedDb,
                id: existingDb.id,
                encrypted: shouldEncrypt,
                password: passwordToSave,
                isLocalBbdump: existingDb.isLocalBbdump,
                // Not edited in the dialog, which sends only what it edits: kept (an edit
                // used to drop the last backup date, the masking and the "Update from" source)
                lastBackup: existingDb.lastBackup,
                masked: existingDb.masked,
                syncSourceId: existingDb.syncSourceId,
            });

            config.databases[index] = dbToSave;
            saveConfig(config);

            const decryptedDatabases = config.databases.map(d => {
                try {
                    return toRuntimeDatabase(d);
                } catch (error) {
                    logger.error(`Failed to decrypt password for ${d.name}: ${error}`);
                    return { ...d, enabled: false };
                }
            });
            cronManager.rescheduleAll(decryptedDatabases);
        }
        return config;
    });

    ipcMain.handle('remove-database', async (_, id: string): Promise<AppConfig> => {
        config.databases = config.databases.filter(db => db.id !== id);
        import('../backup').then(({ backupManager }) => backupManager.backupHistory().forget(id)).catch(() => { /* history is optional */ });

        // If this DB was the proxy target of any project, stop the proxy
        for (const project of config.projects || []) {
            if (project.proxyTargetDbId === id) {
                tcpProxyManager.stopProxy(project.id);
                project.proxyEnabled = false;
                project.proxyTargetDbId = undefined;
            }
        }

        saveConfig(config);
        cronManager.cancelBackup(id);
        return config;
    });

    ipcMain.handle('toggle-schedule', async (_, id: string, enabled: boolean): Promise<AppConfig> => {
        const db = config.databases.find(d => d.id === id);
        if (db) {
            db.enabled = enabled;
            const index = config.databases.findIndex(d => d.id === id);
            if (index !== -1) {
                config.databases[index] = sanitizeDatabaseConfig(db);
            }
            saveConfig(config);

            const decryptedDatabases = config.databases.map(d => {
                try {
                    return toRuntimeDatabase(d);
                } catch (error) {
                    logger.error(`Failed to decrypt password for ${d.name}: ${error}`);
                    return { ...d, enabled: false }; // Disable rather than passing an encrypted password
                }
            });
            cronManager.rescheduleAll(decryptedDatabases);
        }
        return config;
    });

    ipcMain.handle('toggle-mask', async (_, id: string, masked: boolean): Promise<AppConfig> => {
        const db = config.databases.find(d => d.id === id);
        if (db) {
            db.masked = masked;
            const index = config.databases.findIndex(d => d.id === id);
            if (index !== -1) {
                config.databases[index] = sanitizeDatabaseConfig(db);
            }
            saveConfig(config);
        }
        return config;
    });

    // Project management handlers

    /** A database belongs to one project: taking it into `projectId` removes it elsewhere. */
    const claimDatabases = (projectId: string, databaseIds: string[]) => {
        for (const other of config.projects || []) {
            if (other.id === projectId) continue;
            other.databaseIds = other.databaseIds.filter(dbId => !databaseIds.includes(dbId));
            if (other.proxyTargetDbId && databaseIds.includes(other.proxyTargetDbId)) {
                // Its proxy would keep routing to a database it no longer has
                tcpProxyManager.stopProxy(other.id);
                other.proxyTargetDbId = undefined;
            }
        }
    };

    ipcMain.handle('add-project', async (_, project: ProjectConfig): Promise<AppConfig> => {
        const sanitized = sanitizeProjectConfig({
            ...project,
            id: project.id || crypto.randomUUID(),
        });
        if (!config.projects) config.projects = [];
        claimDatabases(sanitized.id, sanitized.databaseIds);
        config.projects.push(sanitized);
        saveConfig(config);
        return config;
    });

    ipcMain.handle('update-project', async (_, id: string, updatedProject: ProjectConfig): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        const index = config.projects.findIndex(p => p.id === id);
        if (index !== -1) {
            // The dialog sends name, colour and databases: keep the rest (proxy, masked, collapsed…)
            const merged = sanitizeProjectConfig({
                ...config.projects[index],
                ...updatedProject,
                id,
            });
            // Proxy target no longer in the project: no target
            if (merged.proxyTargetDbId && !merged.databaseIds.includes(merged.proxyTargetDbId)) {
                tcpProxyManager.stopProxy(id);
                merged.proxyTargetDbId = undefined;
            }
            claimDatabases(id, merged.databaseIds);
            config.projects[index] = merged;
            saveConfig(config);
        }
        return config;
    });

    ipcMain.handle('remove-project', async (_, id: string): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        // Stop proxy if running for this project
        tcpProxyManager.stopProxy(id);
        config.projects = config.projects.filter(p => p.id !== id);
        saveConfig(config);
        return config;
    });

    ipcMain.handle('toggle-project-mask', async (_, id: string, masked: boolean): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        const project = config.projects.find(p => p.id === id);
        if (project) {
            project.masked = masked;
            // Cascade: also mask/unmask all databases in this project
            if (project.databaseIds && project.databaseIds.length > 0) {
                for (const dbId of project.databaseIds) {
                    const db = config.databases.find(d => d.id === dbId);
                    if (db) {
                        db.masked = masked;
                        const index = config.databases.findIndex(d => d.id === dbId);
                        if (index !== -1) {
                            config.databases[index] = sanitizeDatabaseConfig(db);
                        }
                    }
                }
            }
            saveConfig(config);
        }
        return config;
    });

    ipcMain.handle('reorder-projects', async (_, orderedIds: string[]): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        const projectMap = new Map(config.projects.map(p => [p.id, p]));
        const reordered: ProjectConfig[] = [];
        for (const id of orderedIds) {
            const project = projectMap.get(id);
            if (project) reordered.push(project);
        }
        // Append any projects not in orderedIds (safety net)
        for (const p of config.projects) {
            if (!orderedIds.includes(p.id)) reordered.push(p);
        }
        config.projects = reordered;
        saveConfig(config);
        return config;
    });

    ipcMain.handle('move-database-to-project', async (
        _,
        databaseId: string,
        targetProjectId: string | null
    ): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        // Remove databaseId from all projects
        for (const project of config.projects) {
            const wasInProject = project.databaseIds.includes(databaseId);
            project.databaseIds = project.databaseIds.filter(id => id !== databaseId);
            // If this DB was the proxy target and it's being moved out, stop the proxy
            if (wasInProject && project.proxyTargetDbId === databaseId && project.id !== targetProjectId) {
                tcpProxyManager.stopProxy(project.id);
                project.proxyEnabled = false;
                project.proxyTargetDbId = undefined;
            }
        }
        // Add to target project if specified
        if (targetProjectId) {
            const target = config.projects.find(p => p.id === targetProjectId);
            if (target) {
                target.databaseIds.push(databaseId);
            }
        }
        config.projects = config.projects.map(sanitizeProjectConfig);
        saveConfig(config);
        return config;
    });

    ipcMain.handle('reorder-databases', async (_, orderedIds: string[]): Promise<AppConfig> => {
        const dbMap = new Map(config.databases.map(d => [d.id, d]));
        const reordered: DatabaseConfig[] = [];
        for (const id of orderedIds) {
            const db = dbMap.get(id);
            if (db) reordered.push(db);
        }
        // Append any databases not in orderedIds (safety net)
        for (const d of config.databases) {
            if (!orderedIds.includes(d.id)) reordered.push(d);
        }
        config.databases = reordered;
        saveConfig(config);
        return config;
    });

    ipcMain.handle('save-view-mode', async (_, viewMode: 'list' | 'project'): Promise<void> => {
        config.viewMode = viewMode;
        saveConfig(config);
    });
}

// Export getter for other modules
export function getConfig() {
    return config;
}

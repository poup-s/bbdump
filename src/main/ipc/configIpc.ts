import { ipcMain } from 'electron';
import { AppConfig, DatabaseConfig, ProjectConfig } from '../../types/config';
import { encryptionManager } from '../encryption';
import { sanitizeAppConfig, sanitizeDatabaseConfig, sanitizeProjectConfig } from '../configHelper';
import { cronManager } from '../cron';
import { logger } from '../logger';
import { pathManager } from '../paths';
import { tcpProxyManager } from '../tcpProxy';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Variable locale pour stocker la configuration en mémoire
let config: AppConfig = { databases: [] };
const CONFIG_PATH = pathManager.configPath;

// Charger la configuration
export function loadConfig(): AppConfig {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            let loadedConfig = JSON.parse(data);

            // Migrer les mots de passe non chiffrés
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

            // Sauvegarder si migration effectuée
            const originalData = JSON.parse(data);
            const needsSave = uuidMigrated || JSON.stringify(loadedConfig) !== JSON.stringify(originalData);
            if (needsSave) {
                saveConfig(loadedConfig);
            }

            logger.info(`Configuration loaded: ${loadedConfig.databases.length} database(s)`);

            // Onboarding check
            if (loadedConfig.onboardingCompleted === undefined && loadedConfig.databases.length > 0) {
                loadedConfig.onboardingCompleted = true;
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
        return { databases: [] };
    }
}

// Sauvegarder la configuration sur disque
export function saveConfig(newConfig: AppConfig): void {
    try {
        const configToSave = sanitizeAppConfig(newConfig);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configToSave, null, 2), 'utf8');
        logger.info('Configuration saved');
        config = newConfig;
    } catch (error) {
        logger.error(`Error saving configuration: ${error}`);
    }
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
                    return {
                        ...db,
                        password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
                    };
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

    ipcMain.handle('complete-onboarding', async (_, settings: { language: 'en' | 'fr', defaultBackupPath: string }) => {
        config.onboardingCompleted = true;
        config.language = settings.language;
        config.defaultBackupPath = settings.defaultBackupPath;
        saveConfig(config);
        return config;
    });

    ipcMain.handle('save-settings', async (_, settings: { language?: 'en' | 'fr', defaultBackupPath?: string, allowSqlMutations?: boolean, mcpSkipConfirmation?: boolean }) => {
        if (settings.language) config.language = settings.language;
        if (settings.defaultBackupPath) config.defaultBackupPath = settings.defaultBackupPath;
        if (settings.allowSqlMutations !== undefined) config.allowSqlMutations = settings.allowSqlMutations;
        if (settings.mcpSkipConfirmation !== undefined) config.mcpSkipConfirmation = settings.mcpSkipConfirmation;
        saveConfig(config);
        return config;
    });

    // Database management handlers that modify config
    ipcMain.handle('add-database', async (_, db: DatabaseConfig): Promise<AppConfig> => {
        const shouldEncrypt = db.encrypted !== false;
        const sanitizedDb = sanitizeDatabaseConfig({
            ...db,
            id: db.id || crypto.randomUUID(),
        });

        const passwordValue = db.password || '';
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
                isLocalBbdump: existingDb.isLocalBbdump
            });

            config.databases[index] = dbToSave;
            saveConfig(config);

            const decryptedDatabases = config.databases.map(d => {
                try {
                    return {
                        ...d,
                        password: d.encrypted ? encryptionManager.decrypt(d.password) : d.password
                    };
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
                    return {
                        ...d,
                        password: d.encrypted ? encryptionManager.decrypt(d.password) : d.password
                    };
                } catch (error) {
                    logger.error(`Failed to decrypt password for ${d.name}: ${error}`);
                    return { ...d, enabled: false }; // Désactiver plutôt que passer un mot de passe chiffré
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
    ipcMain.handle('add-project', async (_, project: ProjectConfig): Promise<AppConfig> => {
        const sanitized = sanitizeProjectConfig({
            ...project,
            id: project.id || crypto.randomUUID(),
        });
        if (!config.projects) config.projects = [];
        config.projects.push(sanitized);
        saveConfig(config);
        return config;
    });

    ipcMain.handle('update-project', async (_, id: string, updatedProject: ProjectConfig): Promise<AppConfig> => {
        if (!config.projects) config.projects = [];
        const index = config.projects.findIndex(p => p.id === id);
        if (index !== -1) {
            config.projects[index] = sanitizeProjectConfig({
                ...updatedProject,
                id,
            });
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

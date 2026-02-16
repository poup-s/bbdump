import { ipcMain } from 'electron';
import { AppConfig, DatabaseConfig } from '../../types/config';
import { encryptionManager } from '../encryption';
import { sanitizeAppConfig, sanitizeDatabaseConfig } from '../configHelper';
import { cronManager } from '../cron';
import { logger } from '../logger';
import { pathManager } from '../paths';
import * as fs from 'fs';

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

            // Sanitize the entire configuration
            loadedConfig = sanitizeAppConfig(loadedConfig);

            // Sauvegarder si migration effectuée
            const originalData = JSON.parse(data);
            const needsSave = JSON.stringify(loadedConfig) !== JSON.stringify(originalData);
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

    ipcMain.handle('save-settings', async (_, settings: { language?: 'en' | 'fr', defaultBackupPath?: string, allowSqlMutations?: boolean }) => {
        if (settings.language) config.language = settings.language;
        if (settings.defaultBackupPath) config.defaultBackupPath = settings.defaultBackupPath;
        if (settings.allowSqlMutations !== undefined) config.allowSqlMutations = settings.allowSqlMutations;
        saveConfig(config);
        return config;
    });

    // Database management handlers that modify config
    ipcMain.handle('add-database', async (_, db: DatabaseConfig): Promise<AppConfig> => {
        const shouldEncrypt = db.encrypted !== false;
        const sanitizedDb = sanitizeDatabaseConfig(db);

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

    ipcMain.handle('update-database', async (_, name: string, updatedDb: DatabaseConfig): Promise<AppConfig> => {
        const index = config.databases.findIndex(db => db.name === name);
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

    ipcMain.handle('remove-database', async (_, name: string): Promise<AppConfig> => {
        config.databases = config.databases.filter(db => db.name !== name);
        saveConfig(config);
        cronManager.cancelBackup(name);
        return config;
    });

    ipcMain.handle('toggle-schedule', async (_, name: string, enabled: boolean): Promise<AppConfig> => {
        const db = config.databases.find(d => d.name === name);
        if (db) {
            db.enabled = enabled;
            const index = config.databases.findIndex(d => d.name === name);
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
}

// Export getter for other modules
export function getConfig() {
    return config;
}

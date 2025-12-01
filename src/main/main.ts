import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppConfig, DatabaseConfig, BackupResult, LogEntry } from '../types/config';
import { backupManager } from './backup';
import { cronManager } from './cron';
import { logger } from './logger';
import { encryptionManager } from './encryption';
import { fileEncryptionManager } from './fileEncryption';
import { pathManager } from './paths';
import * as dbViewer from './dbViewer';
import * as databaseCreator from './databaseCreator';
import { checkPostgresInstalled } from './postgresManager';
import * as postgresConfig from './postgresConfig';
import { checkForUpdates } from './updateChecker';
import { sanitizeAppConfig, sanitizeDatabaseConfig } from './configHelper';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONFIG_PATH = pathManager.configPath;

let mainWindow: BrowserWindow | null = null;
let config: AppConfig = { databases: [] };

// Charger la configuration
function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      let loadedConfig = JSON.parse(data);

      // Migrer les mots de passe non chiffrés
      loadedConfig = encryptionManager.migrateConfig(loadedConfig);

      // Sanitize the entire configuration using the helper
      loadedConfig = sanitizeAppConfig(loadedConfig);

      // Sauvegarder si migration effectuée pour s'assurer que isLocalBbdump est toujours présent
      const originalData = JSON.parse(data);
      const needsSave = JSON.stringify(loadedConfig) !== JSON.stringify(originalData);
      if (needsSave) {
        saveConfig(loadedConfig);
      }

      logger.info(`Configuration loaded: ${loadedConfig.databases.length} database(s)`);

      // For existing users with databases, assume onboarding is done if not specified
      if (loadedConfig.onboardingCompleted === undefined && loadedConfig.databases.length > 0) {
        loadedConfig.onboardingCompleted = true;
        saveConfig(loadedConfig);
      }

      return loadedConfig;
    } else {
      // Créer une configuration par défaut
      const defaultConfig: AppConfig = {
        databases: [],
        onboardingCompleted: false,
        language: 'en'
      };
      saveConfig(defaultConfig);
      logger.info('Default configuration created');
      return defaultConfig;
    }
  } catch (error) {
    logger.error(`Error loading configuration: ${error}`);
    return { databases: [] };
  }
}

// Sauvegarder la configuration
function saveConfig(newConfig: AppConfig): void {
  try {
    // Sanitize before saving to ensure consistency
    const configToSave = sanitizeAppConfig(newConfig);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configToSave, null, 2), 'utf8');
    logger.info('Configuration saved');
  } catch (error) {
    logger.error(`Error saving configuration: ${error}`);
  }
}

// Créer la fenêtre principale
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false // Required for some node modules if not fully sandboxed, but contextIsolation is the key
    }
  });

  // En développement, charger depuis le serveur de dev
  // En production, charger le fichier HTML
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // Pour le développement, on utilisera un serveur local
    mainWindow.loadFile(path.join(process.cwd(), 'src/renderer/index.html'));
  }

  // Ouvrir les DevTools en développement
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Configurer le backupManager avec la référence à mainWindow
  backupManager.setMainWindow(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
    backupManager.setMainWindow(null);
    cronManager.setMainWindow(null);
  });

  // Passer la référence de la fenêtre au cron manager pour les notifications
  cronManager.setMainWindow(mainWindow);

  // Configurer le callback pour mettre à jour lastBackup
  cronManager.setBackupCompleteCallback((dbName: string, timestamp: string) => {
    const db = config.databases.find(d => d.name === dbName);
    if (db) {
      db.lastBackup = timestamp;
      saveConfig(config);
    }
  });

  // Add context menu for copy/paste
  mainWindow.webContents.on('context-menu', (_, props) => {
    const { Menu } = require('electron');
    const menu = Menu.buildFromTemplate([
      { role: 'cut', enabled: props.editFlags.canCut },
      { role: 'copy', enabled: props.editFlags.canCopy },
      { role: 'paste', enabled: props.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: props.editFlags.canSelectAll }
    ]);
    if (props.isEditable) {
      menu.popup({ window: mainWindow! });
    }
  });
}

// IPC Handlers
ipcMain.handle('get-config', async (): Promise<AppConfig> => {
  // Retourner la config avec les mots de passe masqués pour l'UI
  // S'assurer que toutes les propriétés sont préservées, notamment isLocalBbdump
  return {
    ...config,
    databases: (config.databases || []).map(db => {
      // Use helper to ensure consistency, then mask password
      const sanitized = sanitizeDatabaseConfig(db);
      return {
        ...sanitized,
        password: '••••••••' // Masquer les mots de passe dans l'UI
      };
    })
  };
});

ipcMain.handle('save-config', async (_, newConfig: AppConfig): Promise<void> => {
  config = newConfig;
  saveConfig(config);
  cronManager.rescheduleAll(config.databases || []);
});

/**
 * Vérifie les prérequis nécessaires pour utiliser l'application
 * Utilise le module centralisé prerequisitesManager
 */
async function checkPrerequisites(): Promise<{
  pgDump: { installed: boolean; path?: string; error?: string };
  psql: { installed: boolean; path?: string; error?: string };
  homebrew: { installed: boolean; path?: string; error?: string };
  postgresServer: { installed: boolean; version?: string; hasServer?: boolean; error?: string };
}> {
  const { checkPrerequisites: checkPrereqs } = await import('./prerequisites/prerequisitesManager');
  const prerequisites = await checkPrereqs();

  // Convertir le format pour compatibilité avec l'interface existante
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
    } : { installed: true }, // Linux/Windows
    postgresServer: prerequisites.postgresServer
  };
}

ipcMain.handle('check-prerequisites', async () => {
  try {
    return await checkPrerequisites();
  } catch (error: any) {
    logger.error(`Error checking prerequisites: ${error.message}`);
    throw error;
  }
});

/**
 * Installe Homebrew sur macOS
 * Utilise le module centralisé toolInstaller
 */
async function installHomebrew(onProgress: (progress: { step: string; message: string; progress: number }) => void): Promise<{ success: boolean; error?: string }> {
  const { installHomebrew: installBrew } = await import('./tools/toolInstaller');
  return installBrew(onProgress);
}

ipcMain.handle('install-homebrew', async () => {
  try {
    const onProgress = (progress: { step: string; message: string; progress: number }) => {
      if (mainWindow) {
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
    const onProgress = (progress: { step: string; message: string; progress: number }) => {
      if (mainWindow) {
        mainWindow.webContents.send('install-progress', progress);
      }
    };
    // Utiliser le module centralisé toolInstaller
    const { installPostgreSQL } = await import('./tools/toolInstaller');
    return await installPostgreSQL(onProgress);
  } catch (error: any) {
    logger.error(`Error installing PostgreSQL: ${error.message}`);
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

ipcMain.handle('save-settings', async (_, settings: { language?: 'en' | 'fr', defaultBackupPath?: string }) => {
  if (settings.language) config.language = settings.language;
  if (settings.defaultBackupPath) config.defaultBackupPath = settings.defaultBackupPath;
  saveConfig(config);
  return config;
});

ipcMain.handle('create-local-database', async (_, params: { name: string; displayName?: string; port: number; password?: string }): Promise<{ success: boolean; error?: string; database?: DatabaseConfig; progress?: { step: string; message: string; progress: number } }> => {
  try {
    // Récupérer les ports existants
    const existingPorts = config.databases.map(db => db.port);

    // Créer la base de données avec callback de progression
    let lastProgress: { step: string; message: string; progress: number } | undefined;

    const result = await databaseCreator.createLocalDatabase(
      params,
      existingPorts,
      (progress) => {
        lastProgress = progress;
        // Envoyer la progression au renderer
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

    // Obtenir le chemin par défaut
    const defaultPath = config.defaultBackupPath || pathManager.backupsPath;

    // Créer la configuration de la base de données
    const newDb: DatabaseConfig = sanitizeDatabaseConfig({
      name: result.database.name,
      displayName: result.database.displayName,
      host: result.database.host,
      port: result.database.port,
      user: result.database.user,
      password: params.password || result.database.password || '', // Utiliser le mot de passe fourni ou celui détecté, ou vide
      encrypted: false, // Pas de chiffrement pour les bases locales
      encryptBackups: false,
      cron: '0 0 * * *',
      output: defaultPath,
      enabled: false,
      ssl: false,
      isLocalBbdump: true
    });

    // Ajouter la base à la configuration
    config.databases.push(newDb);
    saveConfig(config);

    // Planifier les backups
    cronManager.scheduleBackup(newDb);

    logger.info(`Local database "${params.name}" created and added to configuration`);

    return {
      success: true,
      database: newDb
    };
  } catch (error: any) {
    logger.error(`Error creating local database: ${error.message}`);
    return {
      success: false,
      error: error.message || 'Failed to create database'
    };
  }
});

ipcMain.handle('duplicate-external-to-local', async (_, params: {
  sourceDb: DatabaseConfig;
  targetName: string;
  targetPassword?: string;
  targetPort: number;
}): Promise<{ success: boolean; error?: string; database?: DatabaseConfig }> => {
  const tempBackupPath = path.join(os.tmpdir(), `bbdump-duplicate-${Date.now()}.backup`);

  // Envoyer la progression au renderer
  const sendProgress = (step: string, message: string, progress: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('duplicate-progress', { step, message, progress });
    }
  };

  try {
    // 1. Faire un dump de la base externe
    sendProgress('backup', `Creating backup from external database "${params.sourceDb.name}"...`, 10);
    logger.info(`Creating backup from external database "${params.sourceDb.name}"`);

    const sourceDbConfig: DatabaseConfig = {
      ...params.sourceDb
    };

    try {
      if (params.sourceDb.encrypted) {
        sourceDbConfig.password = encryptionManager.decrypt(params.sourceDb.password);
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to decrypt source database password: ${error}`
      };
    }

    const backupResult = await backupManager.executeBackup(sourceDbConfig);

    if (!backupResult.success) {
      return {
        success: false,
        error: `Failed to backup source database: ${backupResult.error || 'Unknown error'}`
      };
    }

    // Mettre à jour le lastBackup de la base source
    const sourceDbInConfig = config.databases.find(d => d.name === params.sourceDb.name);
    if (sourceDbInConfig && backupResult.timestamp) {
      sourceDbInConfig.lastBackup = backupResult.timestamp;
      saveConfig(config);
    }

    sendProgress('backup', 'Backup created successfully', 30);

    // Trouver le fichier de backup créé - il devrait être le plus récent dans le dossier output
    const backupDir = sourceDbConfig.output || config.defaultBackupPath || pathManager.backupsPath;
    const backupFiles = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(`${sourceDbConfig.name}_`) && f.endsWith('.backup'))
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

    const backupFile = backupFiles[0].path;
    logger.info(`Backup created successfully: ${backupFile}`);

    // 2. Créer une nouvelle base locale
    sendProgress('creating', `Creating local database "${params.targetName}"...`, 40);
    logger.info(`Creating local database "${params.targetName}"`);

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
    logger.info(`Local database "${params.targetName}" created successfully`);

    // 3. Restaurer le dump dans la nouvelle base locale
    sendProgress('restoring', `Restoring backup to local database "${params.targetName}"...`, 70);
    logger.info(`Restoring backup to local database "${params.targetName}"`);

    const targetDbConfig: DatabaseConfig = sanitizeDatabaseConfig({
      name: params.targetName,
      displayName: params.targetName,
      host: 'localhost',
      port: params.targetPort,
      user: createResult.database.user,
      password: params.targetPassword || '',
      encrypted: false,
      encryptBackups: false,
      cron: '0 0 * * *',
      output: config.defaultBackupPath || pathManager.backupsPath,
      enabled: false,
      ssl: false,
      isLocalBbdump: true
    });

    // Utiliser seulement le nom du fichier pour restoreBackup (il ajoute le chemin du dossier backups)
    const backupFileName = path.basename(backupFile);
    const restoreResult = await backupManager.restoreBackup(backupFileName, {
      name: params.targetName,
      host: 'localhost',
      port: params.targetPort,
      user: createResult.database.user,
      password: params.targetPassword || '',
      connectionString: undefined
    });

    if (!restoreResult.success) {
      // Nettoyer la base créée en cas d'échec
      try {
        const { Client } = await import('pg');
        const client = new Client({
          host: 'localhost',
          port: params.targetPort,
          user: createResult.database.user,
          password: params.targetPassword || '',
          database: 'postgres' // Se connecter à postgres pour pouvoir supprimer la base
        });
        await client.connect();
        const format = (await import('pg-format')).default;
        await client.query(format('DROP DATABASE IF EXISTS %I', params.targetName));
        await client.end();
      } catch (cleanupError: any) {
        logger.warn(`Failed to cleanup database after restore failure: ${cleanupError?.message || cleanupError}`);
      }

      return {
        success: false,
        error: `Failed to restore backup: ${restoreResult.error || 'Unknown error'}`
      };
    }

    sendProgress('restoring', 'Backup restored successfully', 90);
    logger.info(`Backup restored successfully to "${params.targetName}"`);

    // 4. Ajouter la nouvelle base à la configuration
    sendProgress('complete', 'Adding database to configuration...', 95);

    // Utiliser le timestamp du backup créé comme lastBackup pour la nouvelle base
    if (backupResult.timestamp) {
      targetDbConfig.lastBackup = backupResult.timestamp;
    }

    config.databases.push(targetDbConfig);
    saveConfig(config);

    // Planifier les backups
    cronManager.scheduleBackup(targetDbConfig);

    sendProgress('complete', 'Database duplicated successfully', 100);
    logger.info(`Database "${params.targetName}" duplicated and added to configuration`);

    return {
      success: true,
      database: targetDbConfig
    };
  } catch (error: any) {
    logger.error(`Error duplicating database: ${error.message}`);
    return {
      success: false,
      error: error.message || 'Failed to duplicate database'
    };
  } finally {
    // Nettoyer le fichier de backup temporaire si nécessaire
    // Note: Le backup créé par executeBackup est dans le dossier de backups, pas dans tmp
    // On ne le supprime pas car il peut être utile pour l'utilisateur
  }
});

ipcMain.handle('add-database', async (_, db: DatabaseConfig): Promise<AppConfig> => {
  // Chiffrer le mot de passe uniquement si encrypted est true (par défaut true)
  const shouldEncrypt = db.encrypted !== false; // Par défaut, on chiffre

  // Use helper to sanitize input first
  const sanitizedDb = sanitizeDatabaseConfig(db);

  const dbToSave = {
    ...sanitizedDb,
    encrypted: shouldEncrypt,
    password: shouldEncrypt ? encryptionManager.encrypt(db.password) : db.password
  };

  config.databases.push(dbToSave);
  saveConfig(config);

  // Planifier seulement si un cron est défini
  // Utiliser le db original avec le mot de passe déchiffré
  if (db.cron && db.cron.trim() !== '') {
    cronManager.scheduleBackup(db);
  }

  return config;
});

ipcMain.handle('update-database', async (_, name: string, updatedDb: DatabaseConfig): Promise<AppConfig> => {
  const index = config.databases.findIndex(db => db.name === name);
  if (index !== -1) {
    const existingDb = config.databases[index];

    // Déterminer si on doit chiffrer (par défaut true si non spécifié)
    const shouldEncrypt = updatedDb.encrypted !== false;

    // Si le mot de passe est vide ou masqué, conserver l'ancien
    let passwordToSave = existingDb.password; // Mot de passe existant (chiffré ou non)

    if (updatedDb.password && updatedDb.password !== '••••••••' && updatedDb.password.trim() !== '') {
      // Nouveau mot de passe fourni
      passwordToSave = shouldEncrypt ? encryptionManager.encrypt(updatedDb.password) : updatedDb.password;
    } else if (existingDb.encrypted !== shouldEncrypt) {
      // Si l'état de chiffrement change mais pas le mot de passe
      if (shouldEncrypt && !existingDb.encrypted) {
        // On passe de non-chiffré à chiffré
        passwordToSave = encryptionManager.encrypt(existingDb.password);
      } else if (!shouldEncrypt && existingDb.encrypted) {
        // On passe de chiffré à non-chiffré
        passwordToSave = encryptionManager.decrypt(existingDb.password);
      }
    }

    // Préserver isLocalBbdump de la base existante via le helper
    // Note: sanitizeDatabaseConfig will preserve isLocalBbdump if present in updatedDb,
    // but we want to ensure we keep the existing value if updatedDb doesn't specify it correctly
    // or if we want to enforce the existing state.

    const dbToSave = sanitizeDatabaseConfig({
      ...updatedDb,
      encrypted: shouldEncrypt,
      password: passwordToSave,
      isLocalBbdump: existingDb.isLocalBbdump // Ensure we keep the existing flag
    });

    config.databases[index] = dbToSave;
    saveConfig(config);

    // Replanifier avec la config déchiffrée
    const decryptedDatabases = config.databases.map(db => ({
      ...db,
      password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
    }));
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
    // Préserver explicitement isLocalBbdump avant de modifier enabled
    const wasLocalBbdump = db.isLocalBbdump === true;

    logger.info(`Toggling schedule for ${name}: enabled=${enabled}, isLocalBbdump=${wasLocalBbdump}`);

    // Modifier seulement enabled
    db.enabled = enabled;

    // Re-sanitize to be safe (though modifying enabled directly on the object reference in config.databases works too)
    // But let's be explicit
    const index = config.databases.findIndex(d => d.name === name);
    if (index !== -1) {
      config.databases[index] = sanitizeDatabaseConfig(db);
    }

    // Vérifier avant sauvegarde
    logger.info(`Before save: db.isLocalBbdump=${db.isLocalBbdump}`);

    saveConfig(config);

    // Vérifier après sauvegarde
    const savedDb = config.databases.find(d => d.name === name);
    logger.info(`After save: savedDb.isLocalBbdump=${savedDb?.isLocalBbdump}`);

    // Replanifier toutes les tâches (le CronManager gérera l'état enabled)
    const decryptedDatabases = config.databases.map(db => {
      try {
        return {
          ...db,
          password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
        };
      } catch (error) {
        logger.error(`Failed to decrypt password for ${db.name}: ${error}`);
        return db;
      }
    });
    cronManager.rescheduleAll(decryptedDatabases);

    logger.info(`Scheduled tasks ${enabled ? 'enabled' : 'paused'} for ${name} (isLocalBbdump: ${db.isLocalBbdump})`, name);
  }
  return config;
});

ipcMain.handle('backup-now', async (_, name: string): Promise<BackupResult> => {
  const db = config.databases.find(d => d.name === name);
  if (!db) {
    const error = `Database not found: ${name}`;
    logger.error(error);
    return {
      success: false,
      database: name,
      timestamp: new Date().toISOString(),
      error
    };
  }

  // Déchiffrer le mot de passe avant utilisation (uniquement si chiffré)
  // Déchiffrer le mot de passe avant utilisation (uniquement si chiffré)
  let decryptedDb = { ...db };
  try {
    if (db.encrypted) {
      decryptedDb.password = encryptionManager.decrypt(db.password);
    }
  } catch (error) {
    const msg = `Failed to decrypt password for ${db.name}: ${error}`;
    logger.error(msg);
    return {
      success: false,
      database: name,
      timestamp: new Date().toISOString(),
      error: msg
    };
  }

  // Émettre l'événement de démarrage du backup
  if (mainWindow) {
    mainWindow.webContents.send('backup-started', name);
  }

  const result = await backupManager.backupDatabase(decryptedDb);

  // Mettre à jour la date du dernier backup si succès
  if (result.success) {
    db.lastBackup = result.timestamp;
    saveConfig(config);
  }

  // Émettre l'événement de fin du backup
  if (mainWindow) {
    mainWindow.webContents.send('backup-complete', result);
  }

  return result;
});

ipcMain.handle('get-logs', async (_, limit?: number): Promise<LogEntry[]> => {
  return logger.getLogs(limit);
});

ipcMain.handle('clear-logs', async (): Promise<void> => {
  logger.clearLogs();
});

ipcMain.handle('get-scheduled-tasks', async () => {
  return cronManager.getScheduledTasks();
});

ipcMain.handle('get-backups', async () => {
  try {
    const backupDir = pathManager.backupsPath;

    // S'assurer que le dossier existe
    if (!fs.existsSync(backupDir)) {
      return { backups: [], stats: { total: 0, totalSize: 0 } };
    }

    const files = fs.readdirSync(backupDir);
    const backups = files
      .filter(file => file.endsWith('.backup'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        const isEncrypted = fileEncryptionManager.isFileEncrypted(filePath);

        // Parse filename to extract database name
        // Format: dbname_timestamp.backup
        const fileNameWithoutExt = file.replace('.backup', '');
        const parts = fileNameWithoutExt.split('_');
        const database = parts[0] || 'unknown';

        return {
          filename: file,
          database: database,
          name: file,
          path: path.relative(pathManager.appDataPath, filePath),
          size: stats.size,
          created: stats.birthtime.toISOString(),
          encrypted: isEncrypted
        };
      })
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0);

    return {
      backups,
      stats: {
        total: backups.length,
        totalSize
      }
    };
  } catch (error) {
    logger.error(`Error retrieving backups: ${error}`);
    return { backups: [], stats: { total: 0, totalSize: 0 } };
  }
});

ipcMain.handle('delete-backup', async (_, filename: string) => {
  try {
    const backupDir = pathManager.backupsPath;
    const filePath = path.join(backupDir, filename);

    // Sécurité: vérifier que le fichier est bien dans le dossier backups
    if (!filePath.startsWith(backupDir)) {
      throw new Error('Invalid path');
    }

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

// Gestion de la clé de chiffrement
ipcMain.handle('check-encryption-key', async () => {
  const keyPath = pathManager.encryptionKeyPath;
  return {
    exists: fs.existsSync(keyPath),
    path: keyPath
  };
});

ipcMain.handle('check-for-updates', async () => {
  return await checkForUpdates();
});

ipcMain.handle('export-encryption-key', async () => {
  try {
    const { dialog } = require('electron');
    const keyPath = pathManager.encryptionKeyPath;

    if (!fs.existsSync(keyPath)) {
      return { success: false, error: 'Encryption key not found' };
    }

    // Ouvrir une boîte de dialogue pour choisir où sauvegarder
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export encryption key',
      defaultPath: `encryption-key-backup-${new Date().toISOString().split('T')[0]}.key`,
      filters: [
        { name: 'Key file', extensions: ['key'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    // Copier la clé vers le fichier choisi
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

    // Ouvrir une boîte de dialogue pour choisir le fichier à importer
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import encryption key',
      filters: [
        { name: 'Key file', extensions: ['key'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const importPath = result.filePaths[0];

    // Vérifier que le fichier importé a la bonne taille (64 caractères hex = 32 bytes)
    const importedKey = fs.readFileSync(importPath, 'utf8').trim();
    if (importedKey.length !== 64) {
      return { success: false, error: 'Invalid key file (incorrect size)' };
    }

    // Sauvegarder l'ancienne clé si elle existe
    if (fs.existsSync(keyPath)) {
      const backupPath = path.join(pathManager.appDataPath, `.encryption.key.backup-${Date.now()}`);
      fs.copyFileSync(keyPath, backupPath);
      logger.info(`Old key backed up to: ${backupPath}`);
    }

    // Copier la nouvelle clé
    fs.copyFileSync(importPath, keyPath);

    // Appliquer les bonnes permissions
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch (error) {
      logger.warn(`Unable to set permissions: ${error}`);
    }

    logger.info('Encryption key imported successfully');

    return { success: true };
  } catch (error) {
    logger.error(`Error importing key: ${error}`);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('restore-backup', async (_, payload: { backupFile: string; target: { name: string; host: string; port: number; user: string; password: string } }): Promise<BackupResult> => {
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

// Database Viewer Handlers
ipcMain.handle('get-database-tables', async (_, params: { host: string; port: number; user: string; password: string; database: string; connectionString?: string }) => {
  try {
    logger.info(`Getting tables for database: ${params.database}`);
    return await dbViewer.getDatabaseTables(params);
  } catch (error) {
    logger.error(`Error getting database tables: ${error}`);
    throw error;
  }
});

// Helper to get db config
const getDbConfig = (dbName: string) => {
  if (!config || !config.databases || !Array.isArray(config.databases)) {
    throw new Error(`Configuration not loaded or databases array is missing`);
  }

  const db = config.databases.find(d => d.name === dbName);
  if (!db) {
    throw new Error(`Database "${dbName}" not found in configuration`);
  }

  let password = db.password;
  try {
    if (db.encrypted) {
      password = encryptionManager.decrypt(db.password);
    }
  } catch (error) {
    logger.error(`Failed to decrypt password for ${dbName}: ${error}`);
    // We'll throw here because we can't connect without a valid password
    throw new Error(`Failed to decrypt password for ${dbName}`);
  }

  return {
    host: db.host,
    port: db.port,
    user: db.user,
    password: password,
    database: db.name,
    connectionString: db.connectionString,
    ssl: db.ssl
  };
};

// Alias for compatibility
ipcMain.handle('get-db-tables', async (_, params: { db: { name: string } }) => {
  try {
    // Recharger la config pour s'assurer qu'elle est à jour
    config = loadConfig();

    logger.info(`Getting tables for database: ${params.db.name}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getDatabaseTables(dbConfig);
  } catch (error: any) {
    logger.error(`Error getting database tables: ${error.message || error}`);
    throw error;
  }
});

ipcMain.handle('get-table-schema', async (_, params: { db: { name: string }, table: string }) => {
  try {
    logger.info(`Getting schema for table: ${params.table}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getTableSchema({ ...dbConfig, table: params.table });
  } catch (error) {
    logger.error(`Error getting table schema: ${error}`);
    throw error;
  }
});

// PostgreSQL Configuration Handlers
ipcMain.handle('get-postgres-config', async (_, port: number = 5432) => {
  try {
    return await postgresConfig.getPostgresConfigInfo(port);
  } catch (error: any) {
    logger.error(`Error getting PostgreSQL config: ${error.message}`);
    throw error;
  }
});

ipcMain.handle('kill-postgres-connection', async (_, pid: number, port: number = 5432) => {
  try {
    return await postgresConfig.killConnection(pid, port);
  } catch (error: any) {
    logger.error(`Error killing PostgreSQL connection: ${error.message}`);
    throw error;
  }
});

ipcMain.handle('disconnect-postgres-database', async (_, dbName: string, port: number = 5432) => {
  try {
    return await postgresConfig.disconnectDatabase(dbName, port);
  } catch (error: any) {
    logger.error(`Error disconnecting PostgreSQL database: ${error.message}`);
    throw error;
  }
});

ipcMain.handle('drop-postgres-database', async (_, dbName: string, port: number = 5432, forceDisconnect: boolean = true) => {
  try {
    return await postgresConfig.dropDatabase(dbName, port, forceDisconnect);
  } catch (error: any) {
    logger.error(`Error dropping PostgreSQL database: ${error.message}`);
    throw error;
  }
});

ipcMain.handle('test-postgres-connection', async (_, dbName: string, port: number = 5432, password?: string) => {
  try {
    return await postgresConfig.testDatabaseConnection(dbName, port, password);
  } catch (error: any) {
    logger.error(`Error testing PostgreSQL connection: ${error.message}`);
    throw error;
  }
});

ipcMain.handle('get-table-relations', async (_, params: { db: { name: string }, table: string }) => {
  try {
    logger.info(`Getting relations for table: ${params.table}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getTableRelations({ ...dbConfig, table: params.table });
  } catch (error) {
    logger.error(`Error getting table relations: ${error}`);
    throw error;
  }
});

ipcMain.handle('get-table-data', async (_, params: { db: { name: string }, table: string, limit?: number, page?: number, pageSize?: number }) => {
  try {
    const limit = params.limit || params.pageSize || 50;
    const offset = params.page ? (params.page - 1) * limit : 0;

    logger.info(`Getting data for table: ${params.table} (limit: ${limit}, offset: ${offset})`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getTableData({
      ...dbConfig,
      table: params.table,
      limit,
      offset
    });
  } catch (error) {
    logger.error(`Error getting table data: ${error}`);
    throw error;
  }
});

ipcMain.handle('update-table-data', async (_, params: {
  db: { name: string };
  table: string;
  changes: Array<any>;
}) => {
  try {
    logger.info(`Updating table data: ${params.table} (${params.changes.length} changes)`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.updateTableData({
      ...dbConfig,
      table: params.table,
      changes: params.changes
    });
  } catch (error) {
    logger.error(`Error updating table data: ${error}`);
    throw error;
  }
});

ipcMain.handle('delete-table-row', async (_, params: {
  db: { name: string };
  table: string;
  rowId: any;
  primaryKeyColumn: string;
}) => {
  try {
    logger.info(`Deleting row from table: ${params.table}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.deleteTableRow({
      ...dbConfig,
      table: params.table,
      rowId: params.rowId,
      primaryKeyColumn: params.primaryKeyColumn
    });
  } catch (error) {
    logger.error(`Error deleting row: ${error}`);
    throw error;
  }
});

ipcMain.handle('insert-table-row', async (_, params: {
  db: { name: string };
  table: string;
  rowData: any;
}) => {
  try {
    logger.info(`Inserting row into table: ${params.table}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.insertTableRow({
      ...dbConfig,
      table: params.table,
      rowData: params.rowData
    });
  } catch (error) {
    logger.error(`Error inserting row: ${error}`);
    throw error;
  }
});

ipcMain.handle('get-enum-values', async (_, params: {
  db: { name: string };
  typeName: string;
}) => {
  try {
    logger.info(`Getting enum values for type: ${params.typeName}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getEnumValues({
      ...dbConfig,
      typeName: params.typeName
    });
  } catch (error) {
    logger.error(`Error getting enum values: ${error}`);
    throw error;
  }
});

// System Handlers
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-default-path', () => {
  return pathManager.backupsPath;
});

ipcMain.handle('select-directory', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});



// Alias handlers for frontend compatibility
ipcMain.handle('check-key-status', async () => {
  const keyPath = pathManager.encryptionKeyPath;
  return {
    exists: fs.existsSync(keyPath),
    path: keyPath
  };
});

ipcMain.handle('export-key', async () => {
  // Reuse existing handler logic via internal call or just duplicate for now (safer to duplicate/call)
  // Calling the existing handler function if it was extracted would be better, but here we'll just forward
  // Since we can't easily call another handler, we'll just reimplement or alias if possible.
  // Reimplementing for safety and speed.
  try {
    const { dialog } = require('electron');
    const keyPath = pathManager.encryptionKeyPath;

    if (!fs.existsSync(keyPath)) {
      return { success: false, error: 'Encryption key not found' };
    }

    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export encryption key',
      defaultPath: `encryption-key-backup-${new Date().toISOString().split('T')[0]}.key`,
      filters: [
        { name: 'Key file', extensions: ['key'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }

    fs.copyFileSync(keyPath, result.filePath);
    logger.info(`Encryption key exported to: ${result.filePath}`);
    return { success: true, path: result.filePath };
  } catch (error) {
    logger.error(`Error exporting key: ${error}`);
    return { success: false, error: String(error) };
  }
});

ipcMain.handle('import-key', async () => {
  try {
    const { dialog } = require('electron');
    const keyPath = pathManager.encryptionKeyPath;

    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import encryption key',
      filters: [
        { name: 'Key file', extensions: ['key'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true };
    }

    const importPath = result.filePaths[0];
    const importedKey = fs.readFileSync(importPath, 'utf8').trim();
    if (importedKey.length !== 64) {
      return { success: false, error: 'Invalid key file (incorrect size)' };
    }

    if (fs.existsSync(keyPath)) {
      const backupPath = path.join(pathManager.appDataPath, `.encryption.key.backup-${Date.now()}`);
      fs.copyFileSync(keyPath, backupPath);
    }

    fs.copyFileSync(importPath, keyPath);
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch (error) {
      logger.warn(`Unable to set permissions: ${error}`);
    }

    logger.info('Encryption key imported successfully');
    return { success: true };
  } catch (error) {
    logger.error(`Error importing key: ${error}`);
    return { success: false, error: String(error) };
  }
});

// Événements de l'application
app.on('ready', () => {
  logger.info('Application started');

  // Charger la configuration
  config = loadConfig();

  // Déchiffrer les mots de passe pour le cron manager (uniquement si chiffré)
  const decryptedDatabases = config.databases.map(db => {
    try {
      return {
        ...db,
        password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
      };
    } catch (error) {
      logger.error(`Failed to decrypt password for ${db.name} during startup: ${error}`);
      return db;
    }
  });

  // Planifier les sauvegardes automatiques
  cronManager.rescheduleAll(decryptedDatabases);

  // Créer la fenêtre
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('will-quit', () => {
  logger.info('Application closing');
  cronManager.cancelAllBackups();
});

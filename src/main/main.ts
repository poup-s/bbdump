import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig, DatabaseConfig, BackupResult, LogEntry } from '../types/config';
import { backupManager } from './backup';
import { cronManager } from './cron';
import { logger } from './logger';
import { encryptionManager } from './encryption';
import { fileEncryptionManager } from './fileEncryption';
import { pathManager } from './paths';
import * as dbViewer from './dbViewer';

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

      // Ensure databases array exists
      if (!loadedConfig.databases || !Array.isArray(loadedConfig.databases)) {
        loadedConfig.databases = [];
      }

      // Sauvegarder si migration effectuée
      if (loadedConfig !== JSON.parse(data)) {
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
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
      nodeIntegration: true,
      contextIsolation: false
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
  return {
    ...config,
    databases: (config.databases || []).map(db => ({
      ...db,
      password: '••••••••' // Masquer les mots de passe dans l'UI
    }))
  };
});

ipcMain.handle('save-config', async (_, newConfig: AppConfig): Promise<void> => {
  config = newConfig;
  saveConfig(config);
  cronManager.rescheduleAll(config.databases || []);
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

ipcMain.handle('add-database', async (_, db: DatabaseConfig): Promise<AppConfig> => {
  // Chiffrer le mot de passe uniquement si encrypted est true (par défaut true)
  const shouldEncrypt = db.encrypted !== false; // Par défaut, on chiffre
  const dbToSave = {
    ...db,
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

    const dbToSave = {
      ...updatedDb,
      encrypted: shouldEncrypt,
      password: passwordToSave
    };

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
    db.enabled = enabled;
    saveConfig(config);

    // Replanifier toutes les tâches (le CronManager gérera l'état enabled)
    const decryptedDatabases = config.databases.map(db => ({
      ...db,
      password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
    }));
    cronManager.rescheduleAll(decryptedDatabases);

    logger.info(`Scheduled tasks ${enabled ? 'enabled' : 'paused'}`, name);
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
  const decryptedDb = {
    ...db,
    password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
  };

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
  const db = config.databases.find(d => d.name === dbName);
  if (!db) throw new Error(`Database ${dbName} not found`);

  const password = db.encrypted ? encryptionManager.decrypt(db.password) : db.password;

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
    logger.info(`Getting tables for database: ${params.db.name}`);
    const dbConfig = getDbConfig(params.db.name);
    return await dbViewer.getDatabaseTables(dbConfig);
  } catch (error) {
    logger.error(`Error getting database tables: ${error}`);
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

ipcMain.handle('check-for-updates', async () => {
  // Mock update check for now
  return { updateAvailable: false };
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
  const decryptedDatabases = config.databases.map(db => ({
    ...db,
    password: db.encrypted ? encryptionManager.decrypt(db.password) : db.password
  }));

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

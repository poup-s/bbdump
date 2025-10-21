import * as cron from 'node-cron';
import { DatabaseConfig } from '../types/config';
import { backupManager } from './backup';
import { logger } from './logger';
import { BrowserWindow } from 'electron';

interface ScheduledTask {
  database: string;
  schedule: string;
  task: cron.ScheduledTask;
}

export class CronManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private onBackupComplete: ((dbName: string, timestamp: string) => void) | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  setBackupCompleteCallback(callback: (dbName: string, timestamp: string) => void): void {
    this.onBackupComplete = callback;
  }

  scheduleBackup(db: DatabaseConfig): void {
    // Si une tâche existe déjà pour cette base, la supprimer
    if (this.tasks.has(db.name)) {
      this.cancelBackup(db.name);
    }

    // Si les tâches planifiées sont désactivées pour cette DB, ne rien faire
    if (db.enabled === false) {
      logger.info(`Scheduled tasks paused for ${db.name}`, db.name);
      return;
    }

    // Si pas de cron défini, ne rien faire (seulement sauvegardes manuelles)
    if (!db.cron || db.cron.trim() === '') {
      logger.info(`No automatic scheduling for ${db.name} (manual backups only)`, db.name);
      return;
    }

    // Valider l'expression cron
    if (!cron.validate(db.cron)) {
      logger.error(`Invalid cron expression for ${db.name}: ${db.cron}`, db.name);
      return;
    }

    try {
      const task = cron.schedule(db.cron, async () => {
        logger.info(`Executing scheduled backup`, db.name);
        
        // Notifier le début du backup
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('scheduled-backup-started', {
            database: db.name
          });
        }
        
        // Exécuter le backup
        const result = await backupManager.backupDatabase(db);
        
        // Mettre à jour la date du dernier backup si succès
        if (result.success && this.onBackupComplete) {
          this.onBackupComplete(db.name, result.timestamp);
        }
        
        // Notifier la fin du backup
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('scheduled-backup-completed', {
            database: db.name,
            success: result.success,
            error: result.error
          });
        }
      });

      this.tasks.set(db.name, {
        database: db.name,
        schedule: db.cron,
        task
      });

      logger.info(`Scheduled task created with expression: ${db.cron}`, db.name);
    } catch (error) {
      logger.error(`Error scheduling backup: ${error}`, db.name);
    }
  }

  cancelBackup(databaseName: string): void {
    const scheduled = this.tasks.get(databaseName);
    if (scheduled) {
      scheduled.task.stop();
      this.tasks.delete(databaseName);
      logger.info(`Scheduled task cancelled`, databaseName);
    }
  }

  cancelAllBackups(): void {
    this.tasks.forEach((scheduled) => {
      scheduled.task.stop();
    });
    this.tasks.clear();
    logger.info('All scheduled tasks have been cancelled');
  }

  getScheduledTasks(): Array<{ database: string; schedule: string }> {
    return Array.from(this.tasks.values()).map(({ database, schedule }) => ({
      database,
      schedule
    }));
  }

  rescheduleAll(databases: DatabaseConfig[]): void {
    // Annuler toutes les tâches existantes
    this.cancelAllBackups();

    // Planifier les nouvelles tâches
    databases.forEach(db => {
      if (db.cron) {
        this.scheduleBackup(db);
      }
    });
  }
}

export const cronManager = new CronManager();

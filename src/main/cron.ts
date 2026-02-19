import * as cron from 'node-cron';
import { DatabaseConfig } from '../types/config';
import { backupManager } from './backup';
import { logger } from './logger';
import { BrowserWindow } from 'electron';

interface ScheduledTask {
  databaseId: string;
  schedule: string;
  task: cron.ScheduledTask;
}

export class CronManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private mainWindow: BrowserWindow | null = null;
  private onBackupComplete: ((dbId: string, timestamp: string) => void) | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  setBackupCompleteCallback(callback: (dbId: string, timestamp: string) => void): void {
    this.onBackupComplete = callback;
  }

  scheduleBackup(db: DatabaseConfig): void {
    // Si une tâche existe déjà pour cette base, la supprimer
    if (this.tasks.has(db.id)) {
      this.cancelBackup(db.id);
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
        try {
          logger.info(`Executing scheduled backup`, db.name);

          // Notifier le début du backup
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('scheduled-backup-started', {
              databaseId: db.id
            });
          }

          // Exécuter le backup
          const result = await backupManager.backupDatabase(db);

          // Mettre à jour la date du dernier backup si succès
          if (result.success && this.onBackupComplete) {
            this.onBackupComplete(db.id, result.timestamp);
          }

          // Notifier la fin du backup
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('scheduled-backup-completed', {
              databaseId: db.id,
              success: result.success,
              error: result.error
            });
          }
        } catch (error) {
          logger.error(`Scheduled backup failed with unexpected error: ${error}`, db.name);
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('scheduled-backup-completed', {
              databaseId: db.id,
              success: false,
              error: `Unexpected error: ${error}`
            });
          }
        }
      });

      this.tasks.set(db.id, {
        databaseId: db.id,
        schedule: db.cron,
        task
      });

      logger.info(`Scheduled task created with expression: ${db.cron}`, db.name);
    } catch (error) {
      logger.error(`Error scheduling backup: ${error}`, db.name);
    }
  }

  cancelBackup(databaseId: string): void {
    const scheduled = this.tasks.get(databaseId);
    if (scheduled) {
      scheduled.task.stop();
      this.tasks.delete(databaseId);
      logger.info(`Scheduled task cancelled for id ${databaseId}`);
    }
  }

  cancelAllBackups(): void {
    this.tasks.forEach((scheduled) => {
      scheduled.task.stop();
    });
    this.tasks.clear();
    logger.info('All scheduled tasks have been cancelled');
  }

  getScheduledTasks(): Array<{ databaseId: string; schedule: string }> {
    return Array.from(this.tasks.values()).map(({ databaseId, schedule }) => ({
      databaseId,
      schedule
    }));
  }

  rescheduleAll(databases: DatabaseConfig[]): void {
    // Annuler toutes les tâches existantes
    this.cancelAllBackups();

    // Planifier les nouvelles tâches
    if (databases && Array.isArray(databases)) {
      databases.forEach(db => {
        if (db.cron) {
          this.scheduleBackup(db);
        }
      });
    }
  }
}

export const cronManager = new CronManager();

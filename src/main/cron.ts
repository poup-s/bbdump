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
    // If a task already exists for this database, remove it
    if (this.tasks.has(db.id)) {
      this.cancelBackup(db.id);
    }

    // If scheduled tasks are disabled for this DB, do nothing
    if (db.enabled === false) {
      logger.info(`Scheduled tasks paused for ${db.name}`, db.name);
      return;
    }

    // If no cron is defined, do nothing (manual backups only)
    if (!db.cron || db.cron.trim() === '') {
      logger.info(`No automatic scheduling for ${db.name} (manual backups only)`, db.name);
      return;
    }

    // Validate the cron expression
    if (!cron.validate(db.cron)) {
      logger.error(`Invalid cron expression for ${db.name}: ${db.cron}`, db.name);
      return;
    }

    try {
      const task = cron.schedule(db.cron, async () => {
        try {
          logger.info(`Executing scheduled backup`, db.name);

          // Notify the backup start
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('scheduled-backup-started', {
              databaseId: db.id
            });
          }

          // Execute the backup
          const result = await backupManager.backupDatabase(db);

          // Update the last backup date on success
          if (result.success && this.onBackupComplete) {
            this.onBackupComplete(db.id, result.timestamp);
          }

          // Notify the backup completion
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
    // Cancel all existing tasks
    this.cancelAllBackups();

    // Schedule the new tasks
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

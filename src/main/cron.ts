import * as cron from 'node-cron';
import { DatabaseConfig } from '../types/config';
import { backupManager } from './backup';
import { logger } from './logger';
import { BrowserWindow, Notification } from 'electron';
import { previousRun } from './cronSchedule';

interface ScheduledTask {
  databaseId: string;
  schedule: string;
  task: cron.ScheduledTask;
}

export class CronManager {
  private tasks: Map<string, ScheduledTask> = new Map();
  private running: Set<string> = new Set();
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
      const task = cron.schedule(db.cron, () => this.runScheduledBackup(db, 'scheduled'));

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

  private async runScheduledBackup(db: DatabaseConfig, reason: 'scheduled' | 'catch-up'): Promise<void> {
    // A dump longer than the interval must not start a second pg_dump on the same DB
    if (this.running.has(db.id)) {
      logger.warn(`Skipping ${reason} backup: previous run still in progress`, db.name);
      return;
    }
    this.running.add(db.id);

    try {
      logger.info(reason === 'catch-up' ? 'Executing missed scheduled backup (catch-up)' : 'Executing scheduled backup', db.name);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('scheduled-backup-started', { databaseId: db.id });
      }

      const result = await backupManager.backupDatabase(db, reason);

      if (result.success && this.onBackupComplete) {
        this.onBackupComplete(db.id, result.timestamp);
      }
      if (!result.success) {
        this.notifyFailure(db, result.error);
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('scheduled-backup-completed', {
          databaseId: db.id,
          success: result.success,
          error: result.error
        });
      }
    } catch (error) {
      logger.error(`Scheduled backup failed with unexpected error: ${error}`, db.name);
      this.notifyFailure(db, String(error));
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('scheduled-backup-completed', {
          databaseId: db.id,
          success: false,
          error: `Unexpected error: ${error}`
        });
      }
    } finally {
      this.running.delete(db.id);
    }
  }

  /** Scheduled backups mostly run with the window hidden: surface failures system-wide. */
  private notifyFailure(db: DatabaseConfig, error?: string): void {
    try {
      if (!Notification.isSupported()) return;
      new Notification({
        title: `bbdump: backup failed (${db.displayName || db.name})`,
        body: (error || 'Unknown error').slice(0, 200),
      }).show();
    } catch (notifyError) {
      logger.warn(`Unable to show failure notification: ${notifyError}`, db.name);
    }
  }

  /**
   * Runs, once, the backups whose last scheduled time passed while the app was not
   * running (looks back 31 days, so monthly schedules are covered). Backups run one
   * after the other.
   */
  async catchUpMissedBackups(databases: DatabaseConfig[], now: Date = new Date()): Promise<void> {
    for (const db of databases || []) {
      if (db.enabled === false || !db.cron || !cron.validate(db.cron)) continue;
      let lastExpected: Date | null;
      try {
        lastExpected = previousRun(db.cron, now);
      } catch (error) {
        logger.warn(`Cannot evaluate schedule "${db.cron}" for catch-up: ${error}`, db.name);
        continue;
      }
      if (!lastExpected) continue;
      const lastBackup = db.lastBackup ? new Date(db.lastBackup) : null;
      if (lastBackup && !Number.isNaN(lastBackup.getTime()) && lastBackup >= lastExpected) continue;

      logger.info(`Missed scheduled backup (expected ${lastExpected.toISOString()}), catching up`, db.name);
      await this.runScheduledBackup(db, 'catch-up');
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

  /** Whether a timer is set for this database (scheduled and not paused) */
  isScheduled(databaseId: string): boolean {
    return this.tasks.has(databaseId);
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

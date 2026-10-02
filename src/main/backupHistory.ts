/**
 * The last backup runs of each database (success or failure, what started them, how long
 * they took), for the Tasks page: config.json only keeps the date of the last success.
 * Stored apart in <userData>/backup-history.json so config.json's format does not change.
 */
import * as fs from 'fs';
import * as path from 'path';

export type BackupTrigger = 'manual' | 'scheduled' | 'catch-up';

export interface BackupRun {
  at: string;
  success: boolean;
  trigger: BackupTrigger;
  durationMs: number;
  size?: number;
  error?: string;
}

const RUNS_PER_DATABASE = 30;

export class BackupHistory {
  private cache: Record<string, BackupRun[]> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, BackupRun[]> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.load()), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('Error saving backup history:', error);
    }
  }

  /** Most recent first */
  runs(databaseId: string): BackupRun[] {
    return [...(this.load()[databaseId] ?? [])];
  }

  record(databaseId: string, run: BackupRun): void {
    const all = this.load();
    all[databaseId] = [run, ...(all[databaseId] ?? [])].slice(0, RUNS_PER_DATABASE);
    this.save();
  }

  /** A database removed from bbdump: its runs go too */
  forget(databaseId: string): void {
    const all = this.load();
    if (!(databaseId in all)) return;
    delete all[databaseId];
    this.save();
  }
}

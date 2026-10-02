import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from '../types/config';
import { pathManager } from './paths';
import { redactSecrets } from './utils';
import { parseLogText } from './logParse';

/** What the Logs page reads at once: the whole file in practice (it rotates at 5 MB) */
const MAX_READ_BYTES = 6 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export interface LogRead {
  /** Oldest first */
  entries: LogEntry[];
  /** Continuation of the last entry of the previous read */
  leading: string | null;
  /** Pass offset and fileId back to read only what follows */
  offset: number;
  fileId: number;
  /** The previous entries no longer apply (first read, file cleared or rotated) */
  reset: boolean;
  path: string;
}

const LOG_FILE = path.join(pathManager.logsPath, 'app.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED_FILES = 3;

class Logger {
  private writeLog(level: LogEntry['level'], message: string, database?: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactSecrets(message),
      database
    };

    const logLine = `[${entry.timestamp}] [${entry.level.toUpperCase()}]${
      entry.database ? ` [${entry.database}]` : ''
    } ${entry.message}\n`;

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(LOG_FILE, logLine, 'utf8');
    } catch (error) {
      console.error('Error writing log:', error);
    }
  }

  /**
   * Log rotation if the file exceeds MAX_LOG_SIZE
   */
  /**
   * One-time cleanup of logs written before credentials were masked (v1.0.2 logged
   * full pg_dump commands, connection URIs included). Rewrites a file only if needed.
   */
  scrubSecretsFromLogs(): void {
    const files = [LOG_FILE, ...Array.from({ length: MAX_ROTATED_FILES }, (_, i) => `${LOG_FILE}.${i + 1}`)];
    for (const file of files) {
      try {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf8');
        const scrubbed = content.split('\n').map(redactSecrets).join('\n');
        if (scrubbed !== content) {
          fs.writeFileSync(file, scrubbed, 'utf8');
          this.info(`Removed credentials from ${path.basename(file)}`);
        }
      } catch (error) {
        console.error(`Error scrubbing ${file}:`, error);
      }
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(LOG_FILE)) return;

      const stats = fs.statSync(LOG_FILE);
      if (stats.size < MAX_LOG_SIZE) return;

      // Delete the oldest rotated file
      const oldestRotated = `${LOG_FILE}.${MAX_ROTATED_FILES}`;
      if (fs.existsSync(oldestRotated)) {
        fs.unlinkSync(oldestRotated);
      }

      // Shift existing rotated files
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const from = `${LOG_FILE}.${i}`;
        const to = `${LOG_FILE}.${i + 1}`;
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }

      // Rotate the current file
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch (error) {
      console.error('Error rotating log file:', error);
    }
  }

  info(message: string, database?: string): void {
    this.writeLog('info', message, database);
    console.log(`[INFO]${database ? ` [${database}]` : ''} ${message}`);
  }

  error(message: string, database?: string): void {
    this.writeLog('error', message, database);
    console.error(`[ERROR]${database ? ` [${database}]` : ''} ${message}`);
  }

  warn(message: string, database?: string): void {
    this.writeLog('warn', message, database);
    console.warn(`[WARN]${database ? ` [${database}]` : ''} ${message}`);
  }

  /**
   * The log for the Logs page. Without `from`, the last MAX_READ_BYTES of the file (at most
   * MAX_ENTRIES entries); with the `from` of a previous read, only what was written since.
   * A file emptied or rotated since that read is read again in full (`reset`).
   */
  readLogs(from?: { offset: number; fileId: number }): LogRead {
    const empty = { entries: [], leading: null, offset: 0, fileId: 0, reset: true, path: LOG_FILE };
    try {
      if (!fs.existsSync(LOG_FILE)) return empty;
      const stats = fs.statSync(LOG_FILE);
      const incremental = !!from && from.fileId === stats.ino && from.offset <= stats.size;
      const start = incremental ? from!.offset : Math.max(0, stats.size - MAX_READ_BYTES);
      if (incremental && start === stats.size) {
        return { entries: [], leading: null, offset: start, fileId: stats.ino, reset: false, path: LOG_FILE };
      }
      const buffer = Buffer.alloc(stats.size - start);
      const fd = fs.openSync(LOG_FILE, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }
      // Only whole lines: a line being written is read next time
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        return { entries: [], leading: null, offset: start, fileId: stats.ino, reset: !incremental, path: LOG_FILE };
      }
      let text = buffer.subarray(0, lastNewline + 1).toString('utf8');
      // Started in the middle of the file: drop the cut first line
      if (!incremental && start > 0) text = text.slice(text.indexOf('\n') + 1);
      const parsed = parseLogText(text);
      return {
        entries: parsed.entries.slice(-MAX_ENTRIES),
        // Without the beginning of the entry (full read), its end means nothing
        leading: incremental ? parsed.leading : null,
        offset: start + lastNewline + 1,
        fileId: stats.ino,
        reset: !incremental,
        path: LOG_FILE,
      };
    } catch (error) {
      console.error('Error reading logs:', error);
      return empty;
    }
  }

  clearLogs(): void {
    try {
      // The rotated files too: "clear" means nothing older is shown or kept
      for (let i = 1; i <= MAX_ROTATED_FILES; i++) fs.rmSync(`${LOG_FILE}.${i}`, { force: true });
      if (fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, '', 'utf8');
        this.info('Logs cleared');
      }
    } catch (error) {
      this.error(`Error clearing logs: ${error}`);
    }
  }
}

export const logger = new Logger();

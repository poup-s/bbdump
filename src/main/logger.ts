import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from '../types/config';
import { pathManager } from './paths';

const LOG_FILE = path.join(pathManager.logsPath, 'app.log');

class Logger {
  private writeLog(level: LogEntry['level'], message: string, database?: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      database
    };

    const logLine = `[${entry.timestamp}] [${entry.level.toUpperCase()}]${
      entry.database ? ` [${entry.database}]` : ''
    } ${entry.message}\n`;

    try {
      fs.appendFileSync(LOG_FILE, logLine, 'utf8');
    } catch (error) {
      console.error('Error writing log:', error);
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

  getLogs(limit?: number): LogEntry[] {
    try {
      if (!fs.existsSync(LOG_FILE)) {
        return [];
      }

      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      const logs: LogEntry[] = lines.map(line => {
        const timestampMatch = line.match(/\[([^\]]+)\]/);
        const levelMatch = line.match(/\[([^\]]+)\]/g);
        const databaseMatch = line.match(/\[([a-zA-Z0-9_-]+)\]/g);

        const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString();
        const level = (levelMatch && levelMatch[1] ? levelMatch[1].replace(/[\[\]]/g, '').toLowerCase() : 'info') as LogEntry['level'];
        
        // Extraire le message après les tags
        const messageMatch = line.match(/\] (.+)$/);
        const message = messageMatch ? messageMatch[1] : line;

        // Vérifier si un nom de base de données est présent
        const database = databaseMatch && databaseMatch.length > 2 ? databaseMatch[2].replace(/[\[\]]/g, '') : undefined;

        return { timestamp, level, message, database };
      }).reverse(); // Les plus récents en premier

      return limit ? logs.slice(0, limit) : logs;
    } catch (error) {
      console.error('Error reading logs:', error);
      return [];
    }
  }

  clearLogs(): void {
    try {
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


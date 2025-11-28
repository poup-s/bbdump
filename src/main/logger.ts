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
        // Format attendu: [timestamp] [LEVEL] [database] message
        // ou: [timestamp] [LEVEL] message (si pas de database)
        // Le database doit être directement après le niveau, pas dans le message
        
        // Regex plus précise pour extraire timestamp, level, database optionnel, et message
        // Format: [timestamp] [LEVEL] [database] message
        const logPattern = /^\[([^\]]+)\]\s+\[(INFO|ERROR|WARN|info|error|warn)\]\s+(?:\[([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\]\s+)?(.+)$/;
        const match = line.match(logPattern);
        
        let timestamp = new Date().toISOString();
        let level: LogEntry['level'] = 'info';
        let database: string | undefined = undefined;
        let message = line;

        if (match) {
          timestamp = match[1];
          const levelStr = match[2].toLowerCase();
          if (levelStr === 'info' || levelStr === 'error' || levelStr === 'warn') {
            level = levelStr as LogEntry['level'];
          }
          // Le troisième groupe capture la database si présente (directement après le niveau)
          database = match[3] ? match[3] : undefined;
          message = match[4].trim();
        } else {
          // Fallback pour les anciens formats ou formats non standard
          const bracketMatches = line.match(/\[([^\]]+)\]/g);
          if (bracketMatches && bracketMatches.length >= 2) {
            timestamp = bracketMatches[0].replace(/[\[\]]/g, '');
            const levelStr = bracketMatches[1].replace(/[\[\]]/g, '').toLowerCase();
            if (levelStr === 'info' || levelStr === 'error' || levelStr === 'warn') {
              level = levelStr as LogEntry['level'];
              // Pour le fallback, on ne considère comme database que si c'est un nom valide
              // et qu'il n'est pas un mot-clé commun
              if (bracketMatches.length >= 3) {
                const potentialDb = bracketMatches[2].replace(/[\[\]]/g, '');
                // Ne considérer comme database que si c'est un nom valide (pas un mot-clé comme "preparing", "checking", etc.)
                const keywords = ['preparing', 'checking', 'connecting', 'creating', 'complete', 'backup', 'restore'];
                if (!keywords.includes(potentialDb.toLowerCase()) && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(potentialDb)) {
                  database = potentialDb;
                  const messageStart = line.indexOf(bracketMatches[2]) + bracketMatches[2].length;
                  message = line.substring(messageStart).trim();
                } else {
                  const messageStart = line.indexOf(bracketMatches[1]) + bracketMatches[1].length;
                  message = line.substring(messageStart).trim();
                }
              } else {
                const messageStart = line.indexOf(bracketMatches[1]) + bracketMatches[1].length;
                message = line.substring(messageStart).trim();
              }
            }
          }
        }

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


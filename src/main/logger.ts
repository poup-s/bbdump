import * as fs from 'fs';
import * as path from 'path';
import { LogEntry } from '../types/config';
import { pathManager } from './paths';

const LOG_FILE = path.join(pathManager.logsPath, 'app.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED_FILES = 3;

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
      this.rotateIfNeeded();
      fs.appendFileSync(LOG_FILE, logLine, 'utf8');
    } catch (error) {
      console.error('Error writing log:', error);
    }
  }

  /**
   * Rotation des logs si le fichier dépasse MAX_LOG_SIZE
   */
  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(LOG_FILE)) return;

      const stats = fs.statSync(LOG_FILE);
      if (stats.size < MAX_LOG_SIZE) return;

      // Supprimer le plus ancien fichier roté
      const oldestRotated = `${LOG_FILE}.${MAX_ROTATED_FILES}`;
      if (fs.existsSync(oldestRotated)) {
        fs.unlinkSync(oldestRotated);
      }

      // Décaler les fichiers rotés existants
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const from = `${LOG_FILE}.${i}`;
        const to = `${LOG_FILE}.${i + 1}`;
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }

      // Roter le fichier courant
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

  getLogs(limit?: number): LogEntry[] {
    try {
      if (!fs.existsSync(LOG_FILE)) {
        return [];
      }

      // Lire seulement les dernières lignes pour limiter l'usage mémoire
      // On lit au maximum 10000 lignes (ou limit si spécifié et plus petit)
      const maxLines = limit ? Math.min(limit, 10000) : 10000;
      const lines = this.readLastLines(LOG_FILE, maxLines);

      const logs: LogEntry[] = lines.map(line => {
        return this.parseLine(line);
      }).reverse(); // Les plus récents en premier

      return limit ? logs.slice(0, limit) : logs;
    } catch (error) {
      console.error('Error reading logs:', error);
      return [];
    }
  }

  /**
   * Lit les N dernières lignes d'un fichier sans charger tout en mémoire
   */
  private readLastLines(filePath: string, maxLines: number): string[] {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Pour les petits fichiers (< 1MB), lire tout d'un coup
    if (fileSize < 1024 * 1024) {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.trim().split('\n').filter(line => line.length > 0).slice(-maxLines);
    }

    // Pour les gros fichiers, lire par blocs depuis la fin
    const CHUNK_SIZE = 64 * 1024; // 64KB
    const fd = fs.openSync(filePath, 'r');
    const lines: string[] = [];
    let remainder = '';
    let position = fileSize;

    try {
      while (position > 0 && lines.length < maxLines) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;

        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, position);
        const chunk = buffer.toString('utf8') + remainder;

        const parts = chunk.split('\n');
        remainder = parts[0]; // La première partie est potentiellement incomplète

        // Ajouter les lignes complètes (du plus récent au plus ancien)
        for (let i = parts.length - 1; i >= 1; i--) {
          if (parts[i].length > 0) {
            lines.unshift(parts[i]);
            if (lines.length >= maxLines) break;
          }
        }
      }

      // Ajouter le reste si on a atteint le début du fichier
      if (position === 0 && remainder.length > 0 && lines.length < maxLines) {
        lines.unshift(remainder);
      }
    } finally {
      fs.closeSync(fd);
    }

    return lines.slice(-maxLines);
  }

  private parseLine(line: string): LogEntry {
    // Format attendu: [timestamp] [LEVEL] [database] message
    // ou: [timestamp] [LEVEL] message (si pas de database)
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
          if (bracketMatches.length >= 3) {
            const potentialDb = bracketMatches[2].replace(/[\[\]]/g, '');
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

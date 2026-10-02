/**
 * Reading app.log: one entry per "[timestamp] [LEVEL] [database] message" line, and the
 * lines that follow it without a timestamp (a stack trace, pg_dump's output…) belong to
 * its message instead of becoming entries of their own.
 */
import type { LogEntry } from '../types/config';

const ENTRY_START = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s+\[(INFO|ERROR|WARN)\]\s+(?:\[([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\]\s+)?(.*)$/i;

export function parseLogLine(line: string): LogEntry | null {
  const match = ENTRY_START.exec(line);
  if (!match) return null;
  return {
    timestamp: match[1],
    level: match[2].toLowerCase() as LogEntry['level'],
    database: match[3] || undefined,
    message: match[4].trimEnd(),
  };
}

export interface ParsedLogText {
  /** Oldest first */
  entries: LogEntry[];
  /** Lines before the first entry: the end of an entry read earlier */
  leading: string | null;
}

export function parseLogText(text: string): ParsedLogText {
  const entries: LogEntry[] = [];
  const leading: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
    else if (entries.length) entries[entries.length - 1].message += `\n${line}`;
    else leading.push(line);
  }
  return { entries, leading: leading.length ? leading.join('\n') : null };
}

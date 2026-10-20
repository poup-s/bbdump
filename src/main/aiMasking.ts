/**
 * Personal data hidden from AI clients, per saved database: which columns the MCP server
 * replaces before a result leaves for the AI. Kept in <userData>/ai-masking.json, next to
 * config.json, where the MCP server reads it on every call (off unless turned on).
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from './paths';
import { logger } from './logger';
import type { AnonymizeKind } from './sync/dataSync';

export interface AiMaskingSettings {
  enabled: boolean;
  /** Columns replaced, linked columns included ("schema.table" + column) */
  columns: Array<{ table: string; column: string; kind: AnonymizeKind }>;
  updatedAt?: string;
}

interface AiMaskingFile {
  version: 1;
  databases: Record<string, AiMaskingSettings>;
}

const KINDS: AnonymizeKind[] = ['partial', 'email', 'phone', 'name', 'first_name', 'last_name', 'address', 'city', 'ip', 'secret', 'noise', 'month', 'year', 'null'];

const filePath = () => path.join(pathManager.appDataPath, 'ai-masking.json');

/** Keeps only well-formed entries (the file is also read by the MCP server) */
export function sanitizeAiMasking(value: unknown): AiMaskingSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<AiMaskingSettings>;
  const columns = Array.isArray(input.columns) ? input.columns : [];
  const seen = new Set<string>();
  const out: AiMaskingSettings['columns'] = [];
  for (const c of columns) {
    if (!c || typeof c.table !== 'string' || typeof c.column !== 'string' || !KINDS.includes(c.kind) || !c.table.includes('.')) continue;
    const key = `${c.table}.${c.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table: c.table, column: c.column, kind: c.kind });
  }
  return { enabled: input.enabled === true, columns: out, updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : undefined };
}

function readFile(): AiMaskingFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (parsed && typeof parsed.databases === 'object' && parsed.databases) return { version: 1, databases: parsed.databases };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn(`ai-masking.json unreadable: ${error}`);
  }
  return { version: 1, databases: {} };
}

function writeFile(file: AiMaskingFile): void {
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function getAiMasking(databaseId: string): AiMaskingSettings {
  return sanitizeAiMasking(readFile().databases[databaseId]);
}

export function setAiMasking(databaseId: string, settings: unknown): AiMaskingSettings {
  const file = readFile();
  const clean = { ...sanitizeAiMasking(settings), updatedAt: new Date().toISOString() };
  file.databases[databaseId] = clean;
  writeFile(file);
  logger.info(`AI masking ${clean.enabled ? `on (${clean.columns.length} column(s))` : 'off'} for ${databaseId}`);
  return clean;
}

/** Databases with masking on, for the list badges */
export function aiMaskedDatabaseIds(): string[] {
  return Object.entries(readFile().databases).filter(([, s]) => s?.enabled === true).map(([id]) => id);
}

export function forgetAiMasking(databaseId: string): void {
  const file = readFile();
  if (!(databaseId in file.databases)) return;
  delete file.databases[databaseId];
  writeFile(file);
}

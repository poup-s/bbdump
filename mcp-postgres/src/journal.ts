/**
 * Journal of the changes made through MCP, with undo points.
 *
 * One JSON file per change in <bbdump userData>/ai-journal/ (0600). The rows themselves
 * (states before/after, as row_to_json text so no value loses precision) are encrypted
 * with bbdump's key, in the format of the app's encryption.ts (iv:authTag:ciphertext, hex).
 * The bbdump app reads the same files to show the journal and to undo a change.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const JOURNAL_VERSION = 1;
/** Rows an undo point may hold in total (before + after); beyond, the change has no undo */
export const MAX_UNDO_ROWS = 20000;
const MAX_ENTRIES = 300;
const MAX_AGE_DAYS = 30;

/** One table touched by a change: its rows before and after, keyed by primary key */
export interface UndoTable {
  schema: string;
  table: string;
  primaryKey: string[];
  /** row_to_json of the rows before the change (rows deleted or updated) */
  before: string[];
  /** row_to_json of the rows after the change (rows inserted or updated) */
  after: string[];
}

export interface JournalEntry {
  version: number;
  id: string;
  createdAt: string;
  client?: string;
  tool: string;
  databaseId?: string;
  connection: { label?: string; host: string; port: number; database: string; user: string };
  sql: string;
  description: string;
  rowsAffected: number | null;
  undo: { available: boolean; reason?: string; rows: number; tables: string[] };
  /** Encrypted JSON of { tables: UndoTable[] } */
  payload?: string;
  undoneAt?: string;
}

export function journalDir(): string | null {
  const configPath = process.env.BBDUMP_CONFIG_PATH;
  return configPath ? path.join(path.dirname(configPath), 'ai-journal') : null;
}

function encryptionKey(): Buffer | null {
  const keyPath = process.env.BBDUMP_KEY_PATH;
  if (!keyPath) return null;
  try {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  } catch {
    return null;
  }
}

export function encrypt(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

export function decrypt(text: string, key: Buffer): string {
  const [iv, tag, data] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

/** Whether undo points can be stored (bbdump config dir and key known) */
export function journalAvailable(): boolean {
  return !!journalDir() && !!encryptionKey();
}

/** Old entries go: past MAX_ENTRIES or MAX_AGE_DAYS */
function prune(dir: string): void {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  files.forEach((file, index) => {
    const tooMany = index < files.length - MAX_ENTRIES;
    const stamp = Date.parse(file.slice(0, 24).replace(/_/g, ':'));
    if (tooMany || (Number.isFinite(stamp) && stamp < cutoff)) {
      try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
    }
  });
}

/** Writes a journal entry; returns its id, or null when the journal is not available */
export function writeEntry(entry: Omit<JournalEntry, 'version' | 'id' | 'createdAt' | 'payload'>, tables: UndoTable[] | null): string | null {
  const dir = journalDir();
  const key = encryptionKey();
  if (!dir || !key) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID().slice(0, 8);
  const full: JournalEntry = {
    version: JOURNAL_VERSION,
    id,
    createdAt,
    ...entry,
    ...(tables && entry.undo.available ? { payload: encrypt(JSON.stringify({ tables }), key) } : {}),
  };
  // Sortable file name: ISO time (":" → "_" for every file system), then the id
  const file = path.join(dir, `${createdAt.replace(/:/g, '_')}_${id}.json`);
  fs.writeFileSync(file, JSON.stringify(full), { mode: 0o600 });
  try { prune(dir); } catch { /* best effort */ }
  return id;
}

/** Entries without their payload, newest first */
export function listEntries(filter: { databaseId?: string; database?: string } = {}, limit = 50): Array<Omit<JournalEntry, 'payload'>> {
  const dir = journalDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  const out: Array<Omit<JournalEntry, 'payload'>> = [];
  for (const file of files) {
    if (out.length >= limit) break;
    try {
      const { payload: _payload, ...entry } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as JournalEntry;
      if (filter.databaseId && entry.databaseId !== filter.databaseId) continue;
      if (filter.database && entry.connection.database !== filter.database) continue;
      out.push(entry);
    } catch {
      // unreadable entry: skip
    }
  }
  return out;
}

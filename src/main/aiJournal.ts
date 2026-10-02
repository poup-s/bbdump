/**
 * Journal of the changes made by AI clients through the MCP server, and their undo.
 *
 * The MCP server writes one JSON file per change in <userData>/ai-journal/ with, when it
 * could, an undo point: for each table touched, the rows before and after (row_to_json
 * text), encrypted with the app's key. Undoing restores the "before" state in one
 * transaction, after checking that those rows still are as the change left them.
 */
import * as fs from 'fs';
import * as path from 'path';
import format from 'pg-format';
import type { PoolClient } from 'pg';
import { pathManager } from './paths';
import { encryptionManager } from './encryption';
import { logger } from './logger';
import { getConfig } from './ipc/configIpc';
import { connectionParamsFor } from './savedConnection';
import { withConnection } from './dbViewer';
import { getErrorMessage } from './utils';

export interface UndoTable {
  schema: string;
  table: string;
  primaryKey: string[];
  before: string[];
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
  payload?: string;
  undoneAt?: string;
}

export type JournalListItem = Omit<JournalEntry, 'payload'> & { databaseIdResolved?: string };

/** changed: the row now (differs from what the change left); missing: deleted since; reappeared: a deleted row exists again */
export interface UndoConflict { table: string; kind: 'changed' | 'missing' | 'reappeared'; row: Record<string, unknown> }

const journalDir = () => path.join(pathManager.appDataPath, 'ai-journal');

function entryFiles(): string[] {
  const dir = journalDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().map(f => path.join(dir, f));
}

/** The saved database a change was made on: by id, else by server and database name */
function resolveDatabaseId(entry: JournalEntry): string | undefined {
  const databases = getConfig().databases;
  if (entry.databaseId && databases.some(d => d.id === entry.databaseId)) return entry.databaseId;
  const c = entry.connection;
  const local = ['localhost', '127.0.0.1', '::1'];
  const sameHost = (host: string) => host === c.host || (local.includes(host) && local.includes(c.host));
  return databases.find(d => d.name === c.database && d.port === c.port && sameHost(d.host))?.id;
}

/** Entries, newest first, optionally for one saved database */
export function listJournal(databaseId?: string, limit = 200): JournalListItem[] {
  const out: JournalListItem[] = [];
  for (const file of entryFiles()) {
    if (out.length >= limit) break;
    try {
      const { payload: _payload, ...entry } = JSON.parse(fs.readFileSync(file, 'utf8')) as JournalEntry;
      const resolved = resolveDatabaseId(entry as JournalEntry);
      if (databaseId && resolved !== databaseId) continue;
      out.push({ ...entry, databaseIdResolved: resolved });
    } catch (error) {
      logger.warn(`Unreadable AI journal entry ${path.basename(file)}: ${getErrorMessage(error)}`);
    }
  }
  return out;
}

function readEntry(id: string): { entry: JournalEntry; file: string } {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('Invalid change id');
  const file = entryFiles().find(f => f.endsWith(`_${id}.json`));
  if (!file) throw new Error(`Change ${id} not found (journal entries are kept 30 days)`);
  return { entry: JSON.parse(fs.readFileSync(file, 'utf8')) as JournalEntry, file };
}

/** Summary used by the confirmation of an undo asked through MCP */
export function journalEntrySummary(id: string): JournalListItem {
  const { payload: _payload, ...entry } = readEntry(id).entry;
  return { ...entry, databaseIdResolved: resolveDatabaseId(entry as JournalEntry) };
}

function undoTables(entry: JournalEntry): UndoTable[] {
  if (!entry.undo.available || !entry.payload) throw new Error(`This change has no undo point${entry.undo.reason ? `: ${entry.undo.reason}` : ''}`);
  return (JSON.parse(encryptionManager.decrypt(entry.payload)) as { tables: UndoTable[] }).tables;
}

const json = (rows: string[]) => `[${rows.join(',')}]`;
const keyMatch = (a: string, b: string, pk: string[]) => pk.map(c => format(`${a}.%I = ${b}.%I`, c, c)).join(' AND ');
const rel = (t: UndoTable) => format('%I.%I', t.schema, t.table);

/** Columns that can be written (no generated column), and those UPDATE may set (no key, no identity ALWAYS) */
async function writableColumns(client: PoolClient, t: UndoTable): Promise<{ insert: string[]; update: string[] }> {
  const result = await client.query(`
    SELECT a.attname AS name, a.attgenerated <> '' AS generated, a.attidentity = 'a' AS identity_always
    FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [rel(t)]);
  const insert = result.rows.filter(r => !r.generated).map(r => r.name as string);
  const update = result.rows.filter(r => !r.generated && !r.identity_always && !t.primaryKey.includes(r.name)).map(r => r.name as string);
  return { insert, update };
}

/** Rows that no longer are as the change left them: undoing would overwrite someone else's work */
async function findConflicts(client: PoolClient, tables: UndoTable[]): Promise<UndoConflict[]> {
  const conflicts: UndoConflict[] = [];
  for (const t of tables) {
    const r = rel(t);
    const result = await client.query(format(`
      SELECT CASE WHEN t.%I IS NULL THEN 'missing' ELSE 'changed' END AS kind,
             CASE WHEN t.%I IS NULL THEN row_to_json(a) ELSE row_to_json(t) END AS row
      FROM json_populate_recordset(NULL::%s, $1::json) a LEFT JOIN %s t ON ${keyMatch('t', 'a', t.primaryKey)}
      WHERE t.%I IS NULL OR to_jsonb(t) <> to_jsonb(a)
      UNION ALL
      SELECT 'reappeared', row_to_json(t)
      FROM json_populate_recordset(NULL::%s, $2::json) b JOIN %s t ON ${keyMatch('t', 'b', t.primaryKey)}
      WHERE NOT EXISTS (SELECT 1 FROM json_populate_recordset(NULL::%s, $1::json) a WHERE ${keyMatch('a', 'b', t.primaryKey)})
      LIMIT 20`, t.primaryKey[0], t.primaryKey[0], r, r, t.primaryKey[0], r, r, r), [json(t.after), json(t.before)]);
    for (const row of result.rows) conflicts.push({ table: `${t.schema}.${t.table}`, kind: row.kind, row: row.row });
  }
  return conflicts;
}

/** What undoing a change does, per table, and whether rows changed since */
export async function previewUndo(id: string) {
  const { entry } = readEntry(id);
  const tables = undoTables(entry);
  const databaseId = resolveDatabaseId(entry);
  if (!databaseId) throw new Error(`The database of this change (${entry.connection.database} on ${entry.connection.host}) is not saved in bbdump`);
  const sample = (rows: string[]) => rows.slice(0, 20).map(r => JSON.parse(r) as Record<string, unknown>);
  const counts = tables.map(t => {
    const keyOf = (row: string) => { const o = JSON.parse(row); return JSON.stringify(t.primaryKey.map(c => o[c])); };
    const afterKeys = new Set(t.after.map(keyOf));
    const beforeKeys = new Set(t.before.map(keyOf));
    return {
      table: `${t.schema}.${t.table}`,
      primaryKey: t.primaryKey,
      toDelete: t.after.filter(r => !beforeKeys.has(keyOf(r))).length,
      toRestore: t.before.filter(r => !afterKeys.has(keyOf(r))).length,
      toRevert: t.before.filter(r => afterKeys.has(keyOf(r))).length,
      before: sample(t.before),
      after: sample(t.after),
    };
  });
  const conflicts = await withConnection(await connectionParamsFor(databaseId), client => findConflicts(client, tables));
  const { payload: _payload, ...summary } = entry;
  return { entry: summary, databaseId, tables: counts, conflicts };
}

/**
 * Undoes a change in one transaction: rows it inserted are deleted, rows it deleted come
 * back, rows it updated get their previous values. Refused when rows changed since.
 */
export async function undoChange(id: string): Promise<{ success: boolean; error?: string; conflicts?: UndoConflict[]; restored?: Record<string, unknown> }> {
  let entryFile: { entry: JournalEntry; file: string };
  try {
    entryFile = readEntry(id);
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
  const { entry, file } = entryFile;
  if (entry.undoneAt) return { success: false, error: `Already undone on ${entry.undoneAt}` };
  const databaseId = resolveDatabaseId(entry);
  if (!databaseId) return { success: false, error: `The database of this change (${entry.connection.database}) is not saved in bbdump` };

  try {
    const tables = undoTables(entry);
    const outcome = await withConnection(await connectionParamsFor(databaseId), async (client) => {
      await client.query('BEGIN');
      try {
        const conflicts = await findConflicts(client, tables);
        if (conflicts.length) {
          await client.query('ROLLBACK');
          return { conflicts, restored: undefined };
        }
        const restored: Record<string, { deleted: number; restored: number; reverted: number }> = {};
        const stat = (t: UndoTable) => (restored[`${t.schema}.${t.table}`] ??= { deleted: 0, restored: 0, reverted: 0 });
        // Rows the change inserted: children first
        for (const t of [...tables].reverse()) {
          const r = await client.query(format(`DELETE FROM %s t USING json_populate_recordset(NULL::%s, $1::json) a
            WHERE ${keyMatch('t', 'a', t.primaryKey)}
              AND NOT EXISTS (SELECT 1 FROM json_populate_recordset(NULL::%s, $2::json) b WHERE ${keyMatch('b', 'a', t.primaryKey)})`,
          rel(t), rel(t), rel(t)), [json(t.after), json(t.before)]);
          stat(t).deleted += r.rowCount ?? 0;
        }
        // Rows the change deleted: parents first
        for (const t of tables) {
          const { insert } = await writableColumns(client, t);
          const list = insert.map(c => format('%I', c)).join(', ');
          const r = await client.query(format(`INSERT INTO %s (${list}) OVERRIDING SYSTEM VALUE
            SELECT ${insert.map(c => format('b.%I', c)).join(', ')} FROM json_populate_recordset(NULL::%s, $1::json) b
            WHERE NOT EXISTS (SELECT 1 FROM json_populate_recordset(NULL::%s, $2::json) a WHERE ${keyMatch('a', 'b', t.primaryKey)})`,
          rel(t), rel(t), rel(t)), [json(t.before), json(t.after)]);
          stat(t).restored += r.rowCount ?? 0;
        }
        // Rows the change updated: previous values back
        for (const t of tables) {
          const { update } = await writableColumns(client, t);
          if (update.length === 0) continue;
          const r = await client.query(format(`UPDATE %s t SET ${update.map(c => format('%I = b.%I', c, c)).join(', ')}
            FROM json_populate_recordset(NULL::%s, $1::json) b
            WHERE ${keyMatch('t', 'b', t.primaryKey)}
              AND EXISTS (SELECT 1 FROM json_populate_recordset(NULL::%s, $2::json) a WHERE ${keyMatch('a', 'b', t.primaryKey)})`,
          rel(t), rel(t), rel(t)), [json(t.before), json(t.after)]);
          stat(t).reverted += r.rowCount ?? 0;
        }
        await client.query('COMMIT');
        return { conflicts: undefined, restored };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
    if (outcome.conflicts) {
      return { success: false, error: 'Rows changed since this change: undoing it would overwrite them', conflicts: outcome.conflicts };
    }
    fs.writeFileSync(file, JSON.stringify({ ...entry, undoneAt: new Date().toISOString() }), { mode: 0o600 });
    logger.info(`AI change ${id} undone (${entry.tool} on ${entry.connection.database})`);
    return { success: true, restored: outcome.restored };
  } catch (error) {
    logger.error(`Undo of AI change ${id} failed: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  }
}

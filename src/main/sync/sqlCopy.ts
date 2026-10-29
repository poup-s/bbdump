/**
 * Copies and updates for MySQL, MariaDB and SQLite, done by bbdump itself (no dump tools): the
 * schema from the source's own CREATE statements, then the rows in batches, anonymized while
 * they pass (the real values of an anonymized column never reach the copy). Works on two
 * "sides" (a connection each), so the same code runs over an SSH tunnel or on two files.
 * Updates ("Update from…") add what the target lacks: tables, columns, indexes, foreign keys,
 * views, then the missing rows found key by key, as for PostgreSQL (syncEngine.ts).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { quoteIdent } from '../../shared/engines/sqlGuard';
import { pgTypeOf } from '../sqlMasking';
import { sqliteBindable } from '../engines/sqlite';
import type { Catalog, CatalogTable } from './catalog';
import { PHASE, type SchemaChange } from './schemaDiff';
import { anonymizationCandidates, dependencyOrder, distinctFakes, timeColumn, type AnonymizeCandidate, type AnonymizeKind } from './dataSync';
import { fakeValue } from './fakeValues';
import type { SyncChoices, SyncProgress, SyncResult, TablePlan } from './syncEngine';

type Row = Record<string, unknown>;
export type SqlDialect = 'mysql' | 'sqlite';

/** One connection, whatever the engine */
export interface SqlSide {
  dialect: SqlDialect;
  /** The namespace of the keys ("<database>.<table>"): the database name (MySQL), "main" (SQLite) */
  database: string;
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
}

/** Values bound to MySQL: objects and arrays (JSON columns) as JSON text */
function mysqlBindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

export function mysqlSide(conn: PoolConnection, database: string): SqlSide {
  return {
    dialect: 'mysql',
    database,
    all: async (sql, params = []) => (await conn.query<RowDataPacket[]>(sql, params.map(mysqlBindable)))[0] as Row[],
    run: async (sql, params = []) => (await conn.query<ResultSetHeader>(sql, params.map(mysqlBindable)))[0].affectedRows ?? 0,
  };
}

export function sqliteSide(db: DatabaseSync): SqlSide {
  return {
    dialect: 'sqlite',
    database: 'main',
    all: async (sql, params = []) => {
      const stmt = db.prepare(sql);
      // Integers beyond 2^53 kept exact (not in this version's type declarations)
      (stmt as unknown as { setReadBigInts?: (on: boolean) => void }).setReadBigInts?.(true);
      return stmt.all(...params.map(sqliteBindable)) as Row[];
    },
    run: async (sql, params = []) => {
      if (!params.length && !/\?/.test(sql)) {
        db.exec(sql);
        return 0;
      }
      return Number(db.prepare(sql).run(...params.map(sqliteBindable)).changes);
    },
  };
}

// --- Catalog ---------------------------------------------------------------------------------------

export interface SqlColumn {
  name: string;
  rawType: string;
  notNull: boolean;
  default: string | null;
  generated: boolean;
  identity: boolean;
  maxLength?: number;
  /** MySQL: its line of SHOW CREATE TABLE (what ADD COLUMN needs) */
  line?: string;
}

export interface SqlIndex { name: string; unique: boolean; columns: string[]; sql: string }
export interface SqlForeignKey { name: string; columns: string[]; references: string; refColumns: string[]; sql?: string }

export interface SqlTable {
  name: string;
  key: string;
  ddl: string;
  columns: SqlColumn[];
  primaryKey: string[] | null;
  rows: number;
  indexes: SqlIndex[];
  foreignKeys: SqlForeignKey[];
}

export interface SqlCatalog {
  dialect: SqlDialect;
  database: string;
  tables: Map<string, SqlTable>;
  views: Array<{ name: string; sql: string }>;
  /** Created after the rows, so they do not fire during the copy */
  triggers: Array<{ name: string; sql: string }>;
  /** What is not copied (MySQL routines and events, SQLite virtual tables) */
  skipped: string[];
}

const unquote = (name: string) => name.replace(/``/g, '`');
const backquoted = /`((?:[^`]|``)+)`/g;
const namesIn = (list: string) => [...list.matchAll(backquoted)].map(m => unquote(m[1]));

/** The body lines of SHOW CREATE TABLE (columns, keys, constraints), trailing comma removed */
export function createTableLines(ddl: string): string[] {
  const open = ddl.indexOf('(\n');
  const close = ddl.lastIndexOf('\n)');
  if (open < 0 || close < open) return [];
  return ddl.slice(open + 2, close).split('\n').map(l => l.trim().replace(/,$/, '')).filter(Boolean);
}

/** The parts of a MySQL CREATE TABLE: column lines by name, indexes, foreign keys */
export function parseMysqlCreateTable(ddl: string): { columns: Map<string, string>; indexes: SqlIndex[]; foreignKeys: SqlForeignKey[] } {
  const columns = new Map<string, string>();
  const indexes: SqlIndex[] = [];
  const foreignKeys: SqlForeignKey[] = [];
  for (const line of createTableLines(ddl)) {
    const col = /^`((?:[^`]|``)+)`\s/.exec(line);
    if (col) {
      columns.set(unquote(col[1]), line);
      continue;
    }
    const key = /^(UNIQUE |FULLTEXT |SPATIAL )?(?:KEY|INDEX) `((?:[^`]|``)+)` \(([^]*)\)/.exec(line);
    if (key) {
      indexes.push({ name: unquote(key[2]), unique: key[1] === 'UNIQUE ', columns: namesIn(key[3]), sql: line });
      continue;
    }
    const fk = /^CONSTRAINT `((?:[^`]|``)+)` FOREIGN KEY \(([^)]*)\) REFERENCES ((?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`) \(([^)]*)\)/.exec(line);
    if (fk) {
      const target = namesIn(fk[3]);
      foreignKeys.push({ name: unquote(fk[1]), columns: namesIn(fk[2]), references: target[target.length - 1], refColumns: namesIn(fk[4]), sql: line });
    }
  }
  return { columns, indexes, foreignKeys };
}

/** A MySQL statement for another account and database: no DEFINER, no qualifier of the source database */
export function portableMysql(sql: string, sourceDatabase: string): string {
  const qualifier = '`' + sourceDatabase.replace(/`/g, '``') + '`.';
  return sql
    .replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|[^\s@]+)@(`[^`]*`|'[^']*'|\S+)/i, '')
    .split(qualifier).join('');
}

async function readMysqlCatalog(side: SqlSide): Promise<SqlCatalog> {
  const catalog: SqlCatalog = { dialect: 'mysql', database: side.database, tables: new Map(), views: [], triggers: [], skipped: [] };
  const tables = await side.all(`SELECT TABLE_NAME AS name, TABLE_ROWS AS est FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
  const columns = await side.all(`SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
      COLUMN_DEFAULT AS dflt, EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS len
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  for (const t of tables) {
    const name = String(t.name);
    const ddl = String((await side.all(`SHOW CREATE TABLE ${quoteIdent(name, 'mysql')}`))[0]['Create Table']);
    const parsed = parseMysqlCreateTable(ddl);
    const pkLine = createTableLines(ddl).find(l => l.startsWith('PRIMARY KEY'));
    const primaryKey = pkLine ? namesIn(pkLine.slice(pkLine.indexOf('('))) : null;
    const est = Number(t.est ?? 0);
    const rows = est < 2_000_000 ? Number((await side.all(`SELECT COUNT(*) AS n FROM ${quoteIdent(name, 'mysql')}`))[0].n) : est;
    catalog.tables.set(name, {
      name,
      key: `${side.database}.${name}`,
      ddl,
      primaryKey: primaryKey?.length ? primaryKey : null,
      rows,
      indexes: parsed.indexes,
      foreignKeys: parsed.foreignKeys,
      columns: columns.filter(c => c.t === name).map(c => {
        const extra = String(c.extra ?? '').toLowerCase();
        return {
          name: String(c.name),
          rawType: String(c.type).toLowerCase(),
          notNull: c.nullable === 'NO',
          default: c.dflt === null || c.dflt === undefined ? null : String(c.dflt),
          generated: /\b(virtual|stored|persistent)\b/.test(extra),
          identity: extra.includes('auto_increment'),
          maxLength: c.len ? Number(c.len) : undefined,
          line: parsed.columns.get(String(c.name)),
        };
      }),
    });
  }
  for (const v of await side.all(`SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`)) {
    const row = (await side.all(`SHOW CREATE VIEW ${quoteIdent(String(v.name), 'mysql')}`))[0];
    catalog.views.push({ name: String(v.name), sql: portableMysql(String(row['Create View']), side.database) });
  }
  for (const tr of await side.all(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME`)) {
    const row = (await side.all(`SHOW CREATE TRIGGER ${quoteIdent(String(tr.name), 'mysql')}`))[0];
    catalog.triggers.push({ name: String(tr.name), sql: portableMysql(String(row['SQL Original Statement']), side.database) });
  }
  for (const r of await side.all(`SELECT ROUTINE_TYPE AS type, ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME`)) {
    catalog.skipped.push(`${String(r.type).toLowerCase()} ${r.name}`);
  }
  for (const e of await side.all(`SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME`)) {
    catalog.skipped.push(`event ${e.name}`);
  }
  return catalog;
}

async function readSqliteCatalog(side: SqlSide): Promise<SqlCatalog> {
  const catalog: SqlCatalog = { dialect: 'sqlite', database: 'main', tables: new Map(), views: [], triggers: [], skipped: [] };
  const q = (n: string) => quoteIdent(n, 'sqlite');
  const objects = await side.all(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid`);
  // Virtual tables (FTS…) and their shadow tables are not copied row by row
  const virtual = objects.filter(o => o.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(o.sql ?? ''))).map(o => String(o.name));
  const isVirtualPart = (name: string) => virtual.some(v => name === v || name.startsWith(`${v}_`));
  for (const v of virtual) catalog.skipped.push(`virtual table ${v}`);
  for (const o of objects.filter(o => o.type === 'table' && !isVirtualPart(String(o.name)))) {
    const name = String(o.name);
    const info = await side.all(`PRAGMA table_xinfo(${q(name)})`);
    const pk = info.filter(c => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(c => String(c.name));
    const rowidAlias = pk.length === 1 && /^integer$/i.test(String(info.find(c => c.name === pk[0])?.type ?? ''));
    const indexes: SqlIndex[] = [];
    for (const idx of await side.all(`PRAGMA index_list(${q(name)})`)) {
      const cols = (await side.all(`PRAGMA index_info(${q(String(idx.name))})`)).map(c => String(c.name));
      const sql = objects.find(x => x.type === 'index' && x.name === idx.name)?.sql;
      indexes.push({ name: String(idx.name), unique: Number(idx.unique) === 1, columns: cols, sql: sql ? String(sql) : '' });
    }
    const fkRows = await side.all(`PRAGMA foreign_key_list(${q(name)})`);
    const foreignKeys = [...new Set(fkRows.map(f => Number(f.id)))].map(id => {
      const parts = fkRows.filter(f => Number(f.id) === id).sort((a, b) => Number(a.seq) - Number(b.seq));
      return { name: `${name}_fk${id}`, columns: parts.map(p => String(p.from)), references: String(parts[0].table), refColumns: parts.map(p => String(p.to ?? '')) };
    });
    catalog.tables.set(name, {
      name,
      key: `main.${name}`,
      ddl: String(o.sql),
      primaryKey: pk.length ? pk : null,
      rows: Number((await side.all(`SELECT COUNT(*) AS n FROM ${q(name)}`))[0].n),
      indexes,
      foreignKeys,
      columns: info.map(c => {
        const declared = String(c.type ?? '');
        const length = declared.match(/\(\s*(\d+)\s*\)/)?.[1];
        return {
          name: String(c.name),
          rawType: declared.toLowerCase(),
          notNull: Number(c.notnull) === 1,
          default: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
          generated: Number(c.hidden) === 2 || Number(c.hidden) === 3,
          identity: rowidAlias && c.name === pk[0],
          maxLength: /char|text|clob/i.test(declared) && length ? Number(length) : undefined,
        };
      }),
    });
  }
  for (const o of objects) {
    if (!o.sql) continue;
    if (o.type === 'view') catalog.views.push({ name: String(o.name), sql: String(o.sql) });
    if (o.type === 'trigger' && !isVirtualPart(String(o.tbl_name))) catalog.triggers.push({ name: String(o.name), sql: String(o.sql) });
  }
  return catalog;
}

export function readSqlCatalog(side: SqlSide): Promise<SqlCatalog> {
  return side.dialect === 'mysql' ? readMysqlCatalog(side) : readSqliteCatalog(side);
}

/** The catalog in PostgreSQL's shape, for the shared anonymization and ordering rules */
export function pgShape(catalog: SqlCatalog): Catalog {
  const tables = new Map<string, CatalogTable>();
  const keyOf = (name: string) => `${catalog.database}.${name}`;
  for (const t of catalog.tables.values()) {
    tables.set(t.key, {
      schema: catalog.database,
      name: t.name,
      key: t.key,
      partitioned: false,
      partitionKey: null,
      estimate: t.rows,
      columns: t.columns.map(c => ({
        name: c.name,
        type: pgTypeOf(c.rawType, /^tinyint\(1\)/.test(c.rawType) ? 'bool' : undefined),
        notNull: c.notNull,
        default: c.default,
        identity: c.identity ? 'd' : '',
        generated: c.generated,
      })),
      primaryKey: t.primaryKey,
      constraints: [
        ...(t.primaryKey ? [{ name: `${t.name}_pkey`, type: 'p' as const, definition: '', columns: t.primaryKey, refColumns: [] }] : []),
        ...t.indexes.filter(i => i.unique).map(i => ({ name: i.name, type: 'u' as const, definition: '', columns: i.columns, refColumns: [] })),
        ...t.foreignKeys.map(f => ({ name: f.name, type: 'f' as const, definition: '', references: keyOf(f.references), columns: f.columns, refColumns: f.refColumns })),
      ],
      indexes: [],
      triggers: [],
      comment: null,
    });
  }
  return { serverVersion: 0, schemas: [catalog.database], extensions: [], enums: new Map(), tables, sequences: new Set(), views: new Map(), functions: new Map() };
}

// --- Rows ------------------------------------------------------------------------------------------

const READ_BATCH = 1000;

/** The rows of a table, in batches: by primary key when it has one (keyset), else by position */
async function* readRows(side: SqlSide, table: SqlTable, columns: string[], filter?: { sql: string; params: unknown[] }): AsyncGenerator<Row[]> {
  const q = (n: string) => quoteIdent(n, side.dialect);
  const list = columns.map(q).join(', ');
  const from = q(table.name);
  const pk = table.primaryKey;
  if (pk) {
    let last: unknown[] | null = null;
    for (;;) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter) { where.push(`(${filter.sql})`); params.push(...filter.params); }
      if (last) { where.push(`(${pk.map(q).join(', ')}) > (${pk.map(() => '?').join(', ')})`); params.push(...last); }
      const rows = await side.all(`SELECT ${list} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${pk.map(q).join(', ')} LIMIT ${READ_BATCH}`, params);
      if (!rows.length) return;
      yield rows;
      if (rows.length < READ_BATCH) return;
      const end = rows[rows.length - 1];
      last = pk.map(c => end[c]);
    }
  }
  const order = side.dialect === 'sqlite' ? ' ORDER BY rowid' : '';
  for (let offset = 0; ; offset += READ_BATCH) {
    const rows = await side.all(`SELECT ${list} FROM ${from}${filter ? ` WHERE ${filter.sql}` : ''}${order} LIMIT ${READ_BATCH} OFFSET ${offset}`, filter?.params ?? []);
    if (!rows.length) return;
    yield rows;
    if (rows.length < READ_BATCH) return;
  }
}

/** Inserts rows in multi-row statements; `ignore` skips rows that conflict. Returns the rows written */
/** MySQL warnings an INSERT IGNORE turns errors into: a duplicate key or a missing parent is a skip, the others change data */
const SKIP_WARNINGS = new Set([1062, 1452]);

async function insertRows(side: SqlSide, table: string, columns: string[], rows: Row[], ignore: boolean, adjusted?: string[]): Promise<number> {
  if (!rows.length) return 0;
  const q = (n: string) => quoteIdent(n, side.dialect);
  const per = Math.max(1, Math.min(500, Math.floor(20000 / Math.max(1, columns.length))));
  const verb = ignore ? (side.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE') : 'INSERT';
  let written = 0;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const tuple = `(${columns.map(() => '?').join(', ')})`;
    const sql = `${verb} INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`;
    written += await side.run(sql, chunk.flatMap(r => columns.map(c => r[c])));
    // INSERT IGNORE also writes values MySQL had to cut or convert: said, never hidden
    if (ignore && adjusted && side.dialect === 'mysql') {
      for (const w of await side.all('SHOW WARNINGS LIMIT 20')) {
        if (!SKIP_WARNINGS.has(Number(w.Code)) && adjusted.length < 5) adjusted.push(String(w.Message));
      }
    }
  }
  return written;
}

/** A key value as text, the same whatever the driver returned (number, bigint, string, Buffer, boolean) */
function keyPart(value: unknown): string {
  if (value === null || value === undefined) return '\u0000';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const text = String(value);
  if (/^-?0\d/.test(text)) return text; // "007" stays text
  // Whole numbers exactly (a BIGINT past 2^53 comes as text); "12.50" and 12.5 are the same key
  if (/^-?\d+$/.test(text)) return BigInt(text).toString();
  if (/^-?\d+\.\d+$/.test(text)) return text.replace(/\.?0+$/, '');
  return text;
}
const rowKey = (row: Row, pk: string[]) => pk.map(c => keyPart(row[c])).join('\u0001');

async function keySet(side: SqlSide, table: SqlTable, pk: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const rows of readRows(side, { ...table, primaryKey: pk }, pk)) for (const r of rows) keys.add(rowKey(r, pk));
  return keys;
}

/** Replaces the anonymized columns of a row (in place) */
type Anonymizer = (row: Row) => Row;
function anonymizerFor(table: SqlTable, pgTable: CatalogTable, kinds: Map<string, AnonymizeKind>): Anonymizer | null {
  const rules = table.columns
    .filter(c => kinds.has(c.name))
    .map(c => ({
      name: c.name,
      kind: kinds.get(c.name)!,
      options: { wide: distinctFakes(pgTable, c.name), maxLength: c.maxLength, type: pgTable.columns.find(p => p.name === c.name)?.type },
    }));
  if (!rules.length) return null;
  return (row) => {
    for (const r of rules) row[r.name] = fakeValue(row[r.name], r.kind, r.options);
    return row;
  };
}

// --- Sessions ----------------------------------------------------------------------------------------

/**
 * Runs `fn` with the session set for a copy, then puts it back (MySQL connections return to a
 * pool): UTC (TIMESTAMP columns read and written alike), ids of 0 kept, foreign keys as asked.
 */
export async function withCopySession<T>(side: SqlSide, options: { foreignKeys: boolean }, fn: () => Promise<T>): Promise<T> {
  if (side.dialect === 'sqlite') {
    await side.run(`PRAGMA foreign_keys = ${options.foreignKeys ? 'ON' : 'OFF'}`);
    return fn();
  }
  const [saved] = await side.all('SELECT @@SESSION.time_zone AS tz, @@SESSION.sql_mode AS mode, @@SESSION.foreign_key_checks AS fk, DATABASE() AS db');
  await side.run(`SET time_zone = '+00:00', foreign_key_checks = ${options.foreignKeys ? 1 : 0}`);
  await side.run(`SET sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'NO_AUTO_VALUE_ON_ZERO')`);
  try {
    return await fn();
  } finally {
    await side.run('SET time_zone = ?, sql_mode = ?, foreign_key_checks = ?', [saved.tz, saved.mode, saved.fk]).catch(() => {});
    if (saved.db) await side.run(`USE ${quoteIdent(String(saved.db), 'mysql')}`).catch(() => {});
  }
}

/** A consistent read of the source for the whole of `fn` */
export async function inSnapshot<T>(side: SqlSide, fn: () => Promise<T>): Promise<T> {
  await side.run(side.dialect === 'mysql' ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY' : 'BEGIN');
  try {
    return await fn();
  } finally {
    await side.run('ROLLBACK').catch(() => {});
  }
}

async function inTransaction<T>(side: SqlSide, fn: () => Promise<T>): Promise<T> {
  await side.run(side.dialect === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
  try {
    const result = await fn();
    await side.run('COMMIT');
    return result;
  } catch (error) {
    await side.run('ROLLBACK').catch(() => {});
    throw error;
  }
}

// --- Copy ------------------------------------------------------------------------------------------

export interface CopyOptions {
  /** "<table>.<column>" (table by name) → kind */
  anonymize?: Map<string, AnonymizeKind>;
  /** Tables copied without their rows (by name) */
  emptyTables?: Set<string>;
  onProgress?: (p: { table: string; index: number; total: number; rows: number }) => void;
}

export interface CopyResult { tables: number; rows: number; warnings: string[] }

/**
 * Copies every table of the source (already read in `catalog`, inside a snapshot) into the empty
 * `target`: tables, rows, then indexes (SQLite), views and triggers. Foreign keys are off on the
 * target during the copy (any order); MySQL's are part of its CREATE TABLE.
 */
export async function copyAll(source: SqlSide, target: SqlSide, catalog: SqlCatalog, options: CopyOptions = {}): Promise<CopyResult> {
  const warnings: string[] = [];
  if (catalog.skipped.length) warnings.push(`Not copied: ${catalog.skipped.join(', ')}`);
  const shaped = pgShape(catalog);
  const tables = [...catalog.tables.values()];
  for (const t of tables) await target.run(t.ddl);

  let total = 0;
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index];
    options.onProgress?.({ table: table.name, index, total: tables.length, rows: 0 });
    if (options.emptyTables?.has(table.name)) continue;
    const columns = table.columns.filter(c => !c.generated).map(c => c.name);
    const kinds = new Map([...(options.anonymize ?? new Map<string, AnonymizeKind>())]
      .filter(([k]) => k.startsWith(`${table.name}.`))
      .map(([k, v]) => [k.slice(table.name.length + 1), v] as const));
    const anonymize = anonymizerFor(table, shaped.tables.get(table.key)!, kinds);
    let copied = 0;
    await inTransaction(target, async () => {
      for await (const rows of readRows(source, table, columns)) {
        copied += await insertRows(target, table.name, columns, anonymize ? rows.map(anonymize) : rows, false);
        options.onProgress?.({ table: table.name, index, total: tables.length, rows: copied });
      }
    });
    total += copied;
  }

  // SQLite: AUTOINCREMENT counters, then indexes (after the rows: faster)
  if (catalog.dialect === 'sqlite') {
    const hasSequence = (await source.all(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`)).length > 0;
    if (hasSequence) {
      for (const s of await source.all('SELECT name, seq FROM sqlite_sequence')) {
        if (!catalog.tables.has(String(s.name))) continue;
        await target.run('DELETE FROM sqlite_sequence WHERE name = ?', [s.name]);
        await target.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [s.name, s.seq]);
      }
    }
    for (const t of tables) for (const i of t.indexes.filter(i => i.sql)) await target.run(i.sql);
  }
  // Views may use each other: created in rounds until no more can be
  let views = [...catalog.views];
  for (let round = 0; views.length && round < 10; round++) {
    const failed: typeof views = [];
    for (const v of views) {
      try { await target.run(v.sql); } catch { failed.push(v); }
    }
    if (failed.length === views.length) break;
    views = failed;
  }
  for (const v of views) warnings.push(`View ${v.name} could not be created`);
  for (const tr of catalog.triggers) {
    try { await target.run(tr.sql); } catch (error) { warnings.push(`Trigger ${tr.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { tables: tables.length, rows: total, warnings };
}

// --- Update from a source ------------------------------------------------------------------------

/** Missing rows found key by key up to this many source rows; a count difference beyond */
const EXACT_LIMIT = 50000;
const LARGE_TABLE = 1_000_000;

function sqliteAddColumn(table: string, c: SqlColumn): { sql: string; relaxed: boolean } {
  const q = (n: string) => quoteIdent(n, 'sqlite');
  // SQLite needs a default for a NOT NULL column added to a table that has rows
  const notNull = c.notNull && c.default !== null;
  return {
    sql: `ALTER TABLE ${q(table)} ADD COLUMN ${q(c.name)}${c.rawType ? ` ${c.rawType.toUpperCase()}` : ''}${c.default !== null ? ` DEFAULT ${c.default}` : ''}${notNull ? ' NOT NULL' : ''}`,
    relaxed: c.notNull && !notNull,
  };
}

/** What the target lacks compared to the source, as changes to apply to the target */
export function diffSqlSchemas(source: SqlCatalog, target: SqlCatalog): SchemaChange[] {
  const out: SchemaChange[] = [];
  const dialect = source.dialect;
  const q = (n: string) => quoteIdent(n, dialect);
  const add = (change: Omit<SchemaChange, 'id' | 'defaultSelected'> & { defaultSelected?: boolean }) =>
    out.push({ ...change, id: `${change.kind}:${change.object}`, defaultSelected: change.defaultSelected ?? !change.destructive });

  for (const t of source.tables.values()) {
    const local = target.tables.get(t.name);
    if (!local) {
      const indexes = dialect === 'sqlite' ? t.indexes.filter(i => i.sql).map(i => i.sql) : [];
      add({ kind: 'table', object: t.name, sql: [t.ddl, ...indexes], destructive: false, phase: PHASE.table });
      continue;
    }
    for (const c of t.columns) {
      if (local.columns.some(l => l.name === c.name)) continue;
      if (dialect === 'mysql') {
        if (!c.line) continue;
        add({ kind: 'column', object: `${t.name}.${c.name}`, sql: [`ALTER TABLE ${q(t.name)} ADD COLUMN ${c.line}`], destructive: false, phase: PHASE.table });
      } else {
        if (c.generated) continue;
        const { sql, relaxed } = sqliteAddColumn(t.name, c);
        add({ kind: 'column', object: `${t.name}.${c.name}`, sql: [sql], destructive: false, phase: PHASE.table, ...(relaxed ? { note: 'added without NOT NULL (no default)', noteCode: 'added_nullable' as const } : {}) });
      }
    }
    for (const i of t.indexes) {
      if (!i.sql || local.indexes.some(l => l.name === i.name)) continue;
      const sql = dialect === 'mysql' ? `ALTER TABLE ${q(t.name)} ADD ${i.sql}` : i.sql;
      add({ kind: 'index', object: `${t.name}.${i.name}`, sql: [sql], destructive: false, phase: PHASE.index, ...(i.unique ? { note: 'existing rows must be unique', noteCode: 'must_satisfy' as const } : {}) });
    }
    if (dialect === 'mysql') {
      for (const f of t.foreignKeys) {
        if (!f.sql || local.foreignKeys.some(l => l.name === f.name)) continue;
        add({ kind: 'foreign_key', object: `${t.name}.${f.name}`, sql: [`ALTER TABLE ${q(t.name)} ADD ${f.sql}`], destructive: false, phase: PHASE.foreignKey, note: 'existing rows must satisfy it', noteCode: 'must_satisfy' });
      }
    }
  }
  for (const v of source.views) {
    if (target.views.some(l => l.name === v.name) || target.tables.has(v.name)) continue;
    add({ kind: 'view', object: v.name, sql: [v.sql], destructive: false, phase: PHASE.view });
  }
  for (const t of target.tables.values()) {
    if (source.tables.has(t.name)) continue;
    add({ kind: 'local_only_table', object: t.name, sql: [`DROP TABLE ${q(t.name)}`], destructive: true, phase: PHASE.drop, note: 'only in the local database', noteCode: 'local_only' });
  }
  return out.sort((a, b) => a.phase - b.phase || a.object.localeCompare(b.object));
}

export interface SqlSyncAnalysis {
  schema: SchemaChange[];
  tables: TablePlan[];
  anonymize: AnonymizeCandidate[];
}

/** What the target lacks; the keys are the source's ("<database>.<table>") */
export async function analyzeSqlSync(source: SqlSide, target: SqlSide): Promise<SqlSyncAnalysis> {
  const src = await readSqlCatalog(source);
  const tgt = await readSqlCatalog(target);
  const shaped = pgShape(src);
  const tables: TablePlan[] = [];
  for (const t of src.tables.values()) {
    const local = tgt.tables.get(t.name);
    const pgTable = shaped.tables.get(t.key)!;
    const plan: TablePlan = {
      key: t.key, newTable: !local, primaryKey: t.primaryKey, sourceRows: t.rows, localRows: local?.rows ?? 0,
      missing: null, missingExact: false, timeColumn: timeColumn(pgTable), defaultSelected: false,
    };
    if (!t.primaryKey) plan.reason = 'no_primary_key';
    else if (!local || local.rows === 0) { plan.missing = t.rows; plan.missingExact = true; }
    else if (t.rows <= EXACT_LIMIT && local.primaryKey?.join() === t.primaryKey.join()) {
      const have = await keySet(target, local, t.primaryKey);
      let missing = 0;
      for await (const rows of readRows(source, t, t.primaryKey)) for (const r of rows) if (!have.has(rowKey(r, t.primaryKey))) missing++;
      plan.missing = missing;
      plan.missingExact = true;
    } else {
      plan.missing = Math.max(0, t.rows - local.rows);
    }
    if (plan.primaryKey && plan.missing === 0 && plan.missingExact) plan.reason = 'up_to_date';
    if (plan.primaryKey && t.rows > LARGE_TABLE) plan.reason = 'too_large';
    plan.defaultSelected = !!plan.primaryKey && !!plan.missing && t.rows <= LARGE_TABLE;
    tables.push(plan);
  }
  return {
    schema: diffSqlSchemas(src, tgt),
    tables: tables.sort((a, b) => a.key.localeCompare(b.key)),
    anonymize: [...shaped.tables.values()].flatMap(anonymizationCandidates),
  };
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) of `days` ago: how both engines store a date and time */
const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

export async function applySqlSync(
  source: SqlSide,
  target: SqlSide,
  choices: Pick<SyncChoices, 'changes' | 'tables' | 'anonymize'>,
  onProgress: (p: SyncProgress) => void,
): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
  const result: Pick<SyncResult, 'schema' | 'tables'> = { schema: { applied: 0, failed: [] }, tables: [] };
  const src = await readSqlCatalog(source);
  const wanted = new Set(choices.changes);
  const changes = diffSqlSchemas(src, await readSqlCatalog(target)).filter(c => wanted.has(c.id));
  let done = 0;
  for (const change of changes) {
    onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
    // New tables may reference each other: MySQL checks their foreign keys once they all exist
    const keysOff = target.dialect === 'mysql' && change.kind === 'table';
    try {
      if (keysOff) await target.run('SET foreign_key_checks = 0');
      for (const sql of change.sql) await target.run(sql);
      result.schema.applied++;
    } catch (error) {
      result.schema.failed.push({ id: change.id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (keysOff) await target.run('SET foreign_key_checks = 1').catch(() => {});
    }
    done++;
  }
  onProgress({ stage: 'schema', done, total: changes.length });

  const tgt = await readSqlCatalog(target);
  const shaped = pgShape(src);
  const chosen = new Map(choices.tables.map(t => [t.key, t]));
  const ordered = dependencyOrder([...shaped.tables.values()].filter(t => chosen.has(t.key)));
  for (let index = 0; index < ordered.length; index++) {
    const pgTable = ordered[index];
    const table = src.tables.get(pgTable.name)!;
    const local = tgt.tables.get(table.name);
    const outcome: SyncResult['tables'][number] = { key: table.key, copied: 0, skipped: 0 };
    result.tables.push(outcome);
    if (!local) { outcome.error = 'the table does not exist locally (its schema change was not applied)'; continue; }
    if (!table.primaryKey) { outcome.error = 'no primary key: missing rows cannot be found'; continue; }
    const pk = table.primaryKey;
    try {
      // The columns both sides have, without generated ones
      const columns = table.columns.filter(c => !c.generated && local.columns.some(l => l.name === c.name && !l.generated)).map(c => c.name);
      const kinds = new Map(choices.anonymize.filter(a => a.table === table.key).map(a => [a.column, a.kind as AnonymizeKind] as const));
      const anonymize = anonymizerFor(table, pgTable, kinds);
      const recentDays = chosen.get(table.key)?.recentDays;
      const dateColumn = recentDays ? timeColumn(pgTable) : undefined;
      // "The last days" without a date column would copy everything: said instead
      if (recentDays && !dateColumn) { outcome.error = 'no date column to keep the last days by'; continue; }
      const filter = recentDays && dateColumn ? { sql: `${quoteIdent(dateColumn, source.dialect)} >= ?`, params: [daysAgo(recentDays)] } : undefined;
      const selfReferencing = table.foreignKeys.some(f => f.references === table.name);
      const adjusted: string[] = [];
      // A table referencing itself: rows whose parent comes later get in on the next pass (MySQL checks keys)
      for (let pass = 0; pass < (selfReferencing && target.dialect === 'mysql' ? 4 : 1); pass++) {
        const have = await keySet(target, local, pk);
        let copied = 0;
        let skipped = 0;
        await inTransaction(target, async () => {
          for await (const rows of readRows(source, table, columns, filter)) {
            const missing = rows.filter(r => !have.has(rowKey(r, pk)));
            const written = await insertRows(target, table.name, columns, anonymize ? missing.map(anonymize) : missing, true, adjusted);
            copied += written;
            skipped += missing.length - written;
            onProgress({ stage: 'data', table: table.key, index, total: ordered.length, copied: outcome.copied + copied, skipped });
          }
        });
        outcome.copied += copied;
        outcome.skipped = skipped;
        if (copied === 0 || skipped === 0) break;
      }
      if (adjusted.length) outcome.error = `values changed by MySQL to fit the local columns: ${adjusted.join('; ')}`;
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    onProgress({ stage: 'data', table: table.key, index: index + 1, total: ordered.length, copied: outcome.copied, skipped: outcome.skipped });
  }
  return result;
}

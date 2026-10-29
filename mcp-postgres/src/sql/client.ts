/**
 * The active MySQL, MariaDB, SQLite or DuckDB database, chosen with use_connection. While it is
 * active the PostgreSQL tools refuse to run. MySQL / MariaDB go through mysql2 (loaded on first
 * use), through the app's SSH tunnel when the database has one; SQLite reads run in their own
 * process (killed at their time limit: SQLite cannot be interrupted), short writes in this one.
 * DuckDB goes through the user's duckdb tool, read-only, with file access turned off.
 */
import * as fs from 'fs';
import * as v8 from 'v8';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import type { Pool, PoolConnection, FieldPacket } from 'mysql2/promise';
import type { DatabaseSync } from 'node:sqlite';
import { mysqlConnection, type MysqlConnection, type MysqlTarget } from '../shared/mysqlUri.js';
import { readOnlyProblem, statementKind } from '../shared/sqlGuard.js';
import { bindDuckdb, duckdbInstallHint, duckdbVersionOf, findDuckdbTool, runDuckdbTool } from '../shared/duckdbCli.js';
import { SQLITE_RUNNER } from '../shared/sqliteRunner.js';
import { mongoToolsEnabled, type MongoFeature } from '../mongo/features.js';
import { appApi } from '../confirm.js';
import type { SqlEngine } from '../connections.js';

export const QUERY_TIMEOUT_MS = 30_000;

type Row = Record<string, unknown>;

interface ActiveSql {
  id: string;
  label: string;
  engine: SqlEngine;
  /** MySQL database name; "main" for SQLite and DuckDB */
  database: string;
  /** host:port, or the SQLite / DuckDB file */
  where: string;
  user: string;
  port: number;
  file?: string;
  pool?: Pool;
  mariadb?: boolean;
  /** Behind SSH: the saved target, the database id the app opens the tunnel for, and its local port */
  ssh?: { target: MysqlTarget; databaseId: string; port: number };
}

let active: ActiveSql | null = null;

export function activeSql(): { id: string; label: string; engine: SqlEngine; database: string; where: string; user: string; port: number } | null {
  return active && { id: active.id, label: active.label, engine: active.engine, database: active.database, where: active.where, user: active.user, port: active.port };
}

/** First line of a driver error, without the password */
export function sqlError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 400);
}

// --- MySQL / MariaDB ---------------------------------------------------------------------------

async function reach(target: MysqlTarget, sshDatabaseId: string | undefined): Promise<MysqlTarget> {
  if (!sshDatabaseId) return target;
  const result = await appApi<{ success: boolean; host?: string; port?: number; error?: string }>('POST', '/tunnel', { database: sshDatabaseId }, 45000);
  if (!result.success || !result.host || !result.port) throw new Error(`SSH tunnel to this database failed: ${result.error ?? 'unknown error'}`);
  return { ...target, host: result.host, port: result.port, connectionString: undefined, viaTunnel: true };
}

function tls(conn: MysqlConnection) {
  if (!conn.tls) return undefined;
  return {
    ca: conn.tls.caFile ? fs.readFileSync(conn.tls.caFile) : undefined,
    rejectUnauthorized: conn.tls.verifyServer,
    ...(conn.tls.verifyName ? {} : { checkServerIdentity: () => undefined }),
  };
}

/** The same options as the app's driver: journal rows read here compare with rows read there */
async function mysqlPool(target: MysqlTarget): Promise<{ pool: Pool; conn: MysqlConnection }> {
  const { createPool } = await import('mysql2/promise');
  const conn = mysqlConnection(target);
  const pool = createPool({
    host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database || undefined,
    ssl: tls(conn), connectionLimit: 3, connectTimeout: 10000, dateStrings: true, supportBigNumbers: true, charset: 'utf8mb4',
    typeCast: (field, next) => {
      if (field.type === 'TINY' && field.length === 1) {
        const value = field.string();
        return value === null ? null : value === '1';
      }
      return next();
    },
  });
  return { pool, conn };
}

async function describeMysql(pool: Pool) {
  const started = Date.now();
  const [rows] = await pool.query(`SELECT VERSION() AS version,
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS tables,
    (SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS size`) as unknown as [Row[]];
  return { latency_ms: Date.now() - started, version: String(rows[0]?.version ?? ''), tables: Number(rows[0]?.tables ?? 0), size_bytes: Number(rows[0]?.size ?? 0) };
}

// --- SQLite ------------------------------------------------------------------------------------

/** One statement in its own process (reads, and anything that may run long) */
export function runSqlite(file: string, args: { sql: string; values?: unknown[]; mode: 'read' | 'write'; maxRows?: number; timeoutMs?: number }): Promise<{ rows: Row[]; fields: string[]; origins: Array<{ table: string | null; column: string | null }>; rowCount: number; truncated: boolean; duration: number }> {
  if (!fs.existsSync(file)) return Promise.reject(new Error(`The SQLite file was not found: ${file}`));
  const timeoutMs = Math.max(100, Math.min(600000, Math.floor(Number(args.timeoutMs) || QUERY_TIMEOUT_MS)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', SQLITE_RUNNER], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }, windowsHide: true });
    const out: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', () => { /* warnings */ });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`The query was stopped after ${Math.round(timeoutMs / 1000)} s`));
      let answer: { ok: boolean; error?: string; rows: Row[]; fields: string[]; origins: Array<{ table: string | null; column: string | null }>; rowCount: number; truncated: boolean; duration: number };
      try {
        answer = v8.deserialize(Buffer.concat(out));
      } catch {
        return reject(new Error(`The query stopped (code ${code})`));
      }
      if (answer.ok) resolve(answer);
      else reject(new Error(answer.error ?? 'The query failed'));
    });
    child.stdin.on('error', () => { /* ended first */ });
    const values = (args.values ?? []).map(sqliteValue);
    child.stdin.end(v8.serialize({ file, sql: args.sql, values, mode: args.mode, maxRows: args.maxRows || 5000 }));
  });
}

/** A value SQLite can bind: booleans as 1/0, objects as JSON text */
export function sqliteValue(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

const requireHere = createRequire(import.meta.url);

/** node:sqlite, loaded on first use (Node 22.13+, Electron's Node) */
function openSqlite(file: string, readOnly: boolean): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`The SQLite file was not found: ${file}`);
  const { DatabaseSync: Database } = requireHere('node:sqlite') as typeof import('node:sqlite');
  const db = new Database(file, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** A short read on the file (catalog), in this process */
export function withSqliteRead<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = openSqlite(file, true);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function describeSqlite(file: string) {
  const started = Date.now();
  return withSqliteRead(file, (db) => {
    const version = String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? '');
    const tables = Number(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get()?.n ?? 0);
    return { latency_ms: Date.now() - started, version, tables, size_bytes: fs.statSync(file).size };
  });
}

// --- DuckDB ------------------------------------------------------------------------------------

let duckdbTool: { file: string; version?: string } | null = null;

/** The user's duckdb tool and its version (found once), or how to install it */
function requireDuckdbTool(): { file: string; version?: string } {
  if (duckdbTool) return duckdbTool;
  const file = findDuckdbTool();
  if (!file) throw new Error(`The duckdb tool was not found. Install it: ${duckdbInstallHint()}`);
  const answer = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  duckdbTool = { file, version: duckdbVersionOf(`${answer.stdout ?? ''}${answer.stderr ?? ''}`) };
  return duckdbTool;
}

/** Statements of a DuckDB script, read-only, with file access turned off */
export function runDuckdb(file: string, script: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<Row[][]> {
  if (!fs.existsSync(file)) return Promise.reject(new Error(`The DuckDB file was not found: ${file}`));
  return runDuckdbTool(requireDuckdbTool(), file, script, { readOnly: true, timeoutMs });
}

/** The rows of one reading statement on a DuckDB file (values bound as literals) */
export async function duckdbRows(file: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  const results = await runDuckdb(file, `${bindDuckdb(sql, values)};`);
  return results[results.length - 1] ?? [];
}

async function describeDuckdb(file: string) {
  const started = Date.now();
  const [row] = await duckdbRows(file, 'SELECT version() AS v, (SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal) AS n');
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* checked above */ }
  return { latency_ms: Date.now() - started, version: String(row?.v ?? '').replace(/^v/, ''), tables: Number(row?.n ?? 0), size_bytes: size };
}

/** Kinds of statement that are queries (wrapped in a SELECT … LIMIT) */
const DUCKDB_QUERY_STARTS = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', '(', 'TABLE', 'PIVOT', 'UNPIVOT']);

// --- Switching -----------------------------------------------------------------------------------

export interface SqlSaved { id: string; label: string; engine: SqlEngine; target?: MysqlTarget; file?: string; sshDatabaseId?: string }

/** Connects to a saved database and makes it the active one; the previous one is closed */
export async function useSql(saved: SqlSaved) {
  if (saved.engine === 'sqlite' || saved.engine === 'duckdb') {
    const info = saved.engine === 'duckdb' ? await describeDuckdb(saved.file!) : describeSqlite(saved.file!);
    await clearSql();
    active = { id: saved.id, label: saved.label, engine: saved.engine, database: 'main', where: saved.file!, user: '', port: 0, file: saved.file };
    return { database: 'main', file: saved.file, ...info };
  }
  const reached = await reach(saved.target!, saved.sshDatabaseId);
  const { pool, conn } = await mysqlPool(reached);
  try {
    const info = await describeMysql(pool);
    await clearSql();
    active = {
      id: saved.id, label: saved.label, engine: saved.engine, database: conn.database, where: conn.label, user: conn.user, port: conn.port, pool,
      mariadb: /mariadb/i.test(info.version),
      ...(saved.sshDatabaseId ? { ssh: { target: saved.target!, databaseId: saved.sshDatabaseId, port: reached.port } } : {}),
    };
    return { database: conn.database, hosts: conn.label, ...info };
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

/** Checks a saved database without switching to it */
export async function testSql(saved: SqlSaved) {
  if (saved.engine === 'sqlite') return { file: saved.file, ...describeSqlite(saved.file!) };
  if (saved.engine === 'duckdb') return { file: saved.file, ...(await describeDuckdb(saved.file!)) };
  const { pool, conn } = await mysqlPool(await reach(saved.target!, saved.sshDatabaseId));
  try {
    return { database: conn.database, hosts: conn.label, ...(await describeMysql(pool)) };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Before each sql_* call: the app reopens a tunnel left unused; on another port, connect again */
export async function keepReachable(): Promise<void> {
  const current = active;
  if (!current?.ssh) return;
  const reached = await reach(current.ssh.target, current.ssh.databaseId);
  if (reached.port !== current.ssh.port) await useSql({ id: current.id, label: current.label, engine: current.engine, target: current.ssh.target, sshDatabaseId: current.ssh.databaseId });
}

export async function clearSql(): Promise<void> {
  const previous = active;
  active = null;
  await previous?.pool?.end().catch(() => {});
}

/** The active database for a sql_* tool, or why it cannot be read (or changed) */
export function sqlActive(feature: MongoFeature = 'mcp.read'): ActiveSql {
  if (!mongoToolsEnabled(feature)) {
    throw new Error(feature === 'mcp.write' && mongoToolsEnabled() ? 'Changing these databases is turned off in bbdump.' : 'Reading these databases is turned off in bbdump.');
  }
  if (!active) throw new Error('No MySQL, MariaDB, SQLite or DuckDB database is active: call list_connections, then use_connection on one.');
  if (feature === 'mcp.write' && active.engine === 'duckdb') throw new Error('DuckDB databases are read-only here: changes are made in bbdump (explorer, SQL editor).');
  return active;
}

// --- Queries -------------------------------------------------------------------------------------

export interface ReadResult {
  rows: Row[];
  fields: string[];
  /** Table and column each result column comes from, when the engine says so */
  origins: Array<{ table: string | null; column: string | null }>;
  truncated: boolean;
  duration: number;
}

/** One reading statement: refused before when it is not one, then run read-only and timed */
export async function readQuery(sql: string, values: unknown[] = [], options: { maxRows?: number; timeoutMs?: number } = {}): Promise<ReadResult> {
  const db = sqlActive();
  const dialect = db.engine === 'sqlite' || db.engine === 'duckdb' ? db.engine : 'mysql';
  const problem = readOnlyProblem(sql, dialect);
  if (problem) throw new Error(problem);
  const maxRows = options.maxRows ?? 5000;
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  if (db.engine === 'duckdb') {
    // Values written as literals (the tool takes no parameters); a query gets one row more than shown
    const bound = bindDuckdb(sql, values).trim().replace(/;+\s*$/, '');
    const isQuery = DUCKDB_QUERY_STARTS.has(statementKind(bound, 'duckdb'));
    const started = Date.now();
    const [rows = []] = await runDuckdb(db.file!, `${isQuery ? `SELECT * FROM (${bound}) LIMIT ${maxRows + 1}` : bound};`, timeoutMs);
    const duration = Date.now() - started;
    let fields = rows.length ? Object.keys(rows[0]) : [];
    if (!fields.length && isQuery) fields = (await duckdbRows(db.file!, `DESCRIBE ${bound}`).catch(() => [])).map((r) => String(r.column_name));
    // The tool does not say where a column comes from
    return { rows: rows.slice(0, maxRows), fields, origins: fields.map(() => ({ table: null, column: null })), truncated: rows.length > maxRows, duration };
  }
  if (db.engine === 'sqlite') {
    const result = await runSqlite(db.file!, { sql, values, mode: 'read', maxRows, timeoutMs });
    return { rows: result.rows, fields: result.fields, origins: result.origins, truncated: result.truncated, duration: result.duration };
  }
  const conn = await db.pool!.getConnection();
  try {
    await conn.query(db.mariadb ? `SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(3)}` : `SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`);
    await conn.query('START TRANSACTION READ ONLY');
    try {
      const started = Date.now();
      const [result, fields] = await conn.query({ sql, values: values.map(mysqlValue) });
      const duration = Date.now() - started;
      await conn.query('COMMIT');
      const rows = Array.isArray(result) ? result as Row[] : [];
      return {
        rows: rows.slice(0, maxRows),
        fields: (fields ?? []).map((f) => f.name),
        origins: (fields ?? []).map((f: FieldPacket & { orgTable?: string; orgName?: string }) => ({ table: f.orgTable || null, column: f.orgName || null })),
        truncated: rows.length > maxRows,
        duration,
      };
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await conn.query(db.mariadb ? 'SET SESSION max_statement_time = 0' : 'SET SESSION max_execution_time = 0').catch(() => {});
    conn.release();
  }
}

/** Values bound for mysql2: objects and arrays (JSON columns) as JSON text */
export function mysqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

/** What a change runs its statements with, inside one transaction */
export interface WriteSession {
  dialect: 'mysql' | 'sqlite';
  rows(sql: string, values?: unknown[]): Promise<Row[]>;
  run(sql: string, values?: unknown[]): Promise<{ affected: number; insertId?: number | bigint }>;
}

/** Runs `fn` in one transaction (committed when it returns, rolled back when it throws) */
export async function withWrite<T>(fn: (session: WriteSession) => Promise<T>): Promise<T> {
  const db = sqlActive('mcp.write');
  if (db.engine === 'sqlite') {
    const sqlite = openSqlite(db.file!, false);
    sqlite.exec('BEGIN IMMEDIATE');
    const session: WriteSession = {
      dialect: 'sqlite',
      rows: async (sql, values = []) => sqlite.prepare(sql).all(...values.map(sqliteValue)).map((row) => ({ ...row })),
      run: async (sql, values = []) => {
        const result = sqlite.prepare(sql).run(...values.map(sqliteValue));
        return { affected: Number(result.changes), insertId: result.lastInsertRowid };
      },
    };
    try {
      const out = await fn(session);
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch { /* already ended */ }
      throw err;
    } finally {
      sqlite.close();
    }
  }
  const conn: PoolConnection = await db.pool!.getConnection();
  await conn.beginTransaction();
  const session: WriteSession = {
    dialect: 'mysql',
    rows: async (sql, values = []) => {
      const [result] = await conn.query({ sql, values: values.map(mysqlValue) });
      return Array.isArray(result) ? result as Row[] : [];
    },
    run: async (sql, values = []) => {
      const [result] = await conn.query({ sql, values: values.map(mysqlValue) });
      const header = result as { affectedRows?: number; insertId?: number };
      return { affected: header.affectedRows ?? 0, insertId: header.insertId };
    },
  };
  try {
    const out = await fn(session);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

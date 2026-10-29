/**
 * SQLite: a database file on this computer, opened with node:sqlite (no tool, no native module).
 * The explorer's facets return the shapes of dbViewer.ts (PostgreSQL). node:sqlite is
 * synchronous and cannot be interrupted: queries written by someone (SQL editor, dashboards, the
 * AI) run in their own process, killed at their time limit, so a slow one never freezes the app;
 * the explorer's own small statements run here, with a short wait for a lock.
 */
import * as fs from 'fs';
import * as v8 from 'v8';
import { spawn } from 'child_process';
import type { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../ipc/configIpc';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { SQLITE } from '../../shared/engines/manifests';
import { quoteIdent, readOnlyProblem, statementCount, statementKind } from '../../shared/engines/sqlGuard';
import { SQLITE_RUNNER } from '../../shared/engines/sqliteRunner';
import type { BackupResult } from '../../types/config';
import type { EngineDriver } from './driver';

type NodeSqlite = typeof import('node:sqlite');
let sqlite: NodeSqlite | null = null;
function lib(): NodeSqlite {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (!sqlite) sqlite = require('node:sqlite') as NodeSqlite;
    return sqlite;
}

const q = (name: string) => quoteIdent(name, 'sqlite');
/** SQLite's single namespace (attached databases are not shown) */
export const SQLITE_NAMESPACE = 'main';

/** The file of a saved SQLite database */
function fileOf(dbId: string): string {
    const db = getConfig()?.databases?.find(d => d.id === dbId);
    if (!db) throw new Error(`Database with id "${dbId}" not found in configuration`);
    const file = db.sqlite?.path;
    if (!file) throw new Error('This SQLite database has no file');
    return file;
}

/**
 * A connection of its own to a file, for copies and updates (foreign keys left off, as SQLite's
 * default: rows are copied in any order). `create`: a new file, refused if it exists.
 */
export function openSqliteFile(file: string, options: { readOnly?: boolean; create?: boolean } = {}): DatabaseSync {
    if (options.create ? fs.existsSync(file) : !fs.existsSync(file)) {
        throw new Error(options.create ? `A file already exists at ${file}` : `The SQLite file was not found: ${file}`);
    }
    const db = new (lib().DatabaseSync)(file, { readOnly: !!options.readOnly });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
}

/** Opens the file (never creates it), runs `fn`, closes it (once its promise settles, for an async `fn`) */
function withDb<T>(file: string, mode: 'read' | 'write', fn: (db: DatabaseSync) => T): T {
    if (!fs.existsSync(file)) throw new Error(`The SQLite file was not found: ${file}`);
    const db = new (lib().DatabaseSync)(file, { readOnly: mode === 'read' });
    let result: T;
    try {
        db.exec('PRAGMA busy_timeout = 2000');
        if (mode === 'write') db.exec('PRAGMA foreign_keys = ON');
        result = fn(db);
    } catch (error) {
        db.close();
        throw error;
    }
    if (result instanceof Promise) return result.finally(() => db.close()) as T;
    db.close();
    return result;
}

/** A value bound to a statement: booleans as 1/0, objects (JSON) as text, dates as ISO text */
export function sqliteBindable(value: unknown): null | number | bigint | string | Uint8Array {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
    if (value instanceof Uint8Array) return value;
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
}

const bind = (values: unknown[]) => values.map(sqliteBindable);

/** Plain objects (node:sqlite rows have no prototype) with booleans for BOOLEAN columns */
function plainRows(rows: Array<Record<string, unknown>>, boolColumns: Set<string>): Array<Record<string, unknown>> {
    return rows.map(row => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = boolColumns.has(key) && (value === 0 || value === 1) ? value === 1 : value;
        return out;
    });
}

// --- Catalog -------------------------------------------------------------------------------------

interface XInfo { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }

const tableNames = (db: DatabaseSync): string[] =>
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map(r => String(r.name));

const xinfo = (db: DatabaseSync, table: string) => db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table) as unknown as XInfo[];

const isBoolType = (type: string) => /bool/i.test(type);

function boolColumnsOf(db: DatabaseSync, table: string): Set<string> {
    return new Set(xinfo(db, table).filter(c => isBoolType(c.type)).map(c => c.name));
}

/** Declared types in the shape of PostgreSQL's information_schema (what the explorer reads) */
export function describeSqliteColumn(col: XInfo, rowidAlias: boolean) {
    const declared = String(col.type ?? '').trim();
    const type = declared.toLowerCase() || 'any';
    const length = declared.match(/\(\s*(\d+)\s*\)/)?.[1];
    return {
        column_name: col.name,
        data_type: type,
        udt_schema: null,
        udt_name: isBoolType(declared) ? 'bool' : (type.match(/^[a-z]+/)?.[0] ?? type),
        is_nullable: col.notnull || rowidAlias ? 'NO' : 'YES',
        column_default: col.dflt_value,
        character_maximum_length: /char|text|clob/i.test(declared) && length ? Number(length) : null,
        numeric_precision: null,
        numeric_scale: null,
        // INTEGER PRIMARY KEY is the rowid: a new row gets the next one
        is_identity: rowidAlias ? 'YES' : 'NO',
        identity_generation: rowidAlias ? 'BY DEFAULT' : null,
        // 2: virtual, 3: stored generated column
        is_generated: col.hidden === 2 || col.hidden === 3 ? 'ALWAYS' : 'NEVER',
    };
}

interface ForeignKey { constraint_name: string; source_schema: string; source_table: string; source_column: string; target_schema: string; target_table: string; target_column: string }

function primaryKeyOf(db: DatabaseSync, table: string): string[] {
    return xinfo(db, table).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
}

function foreignKeysOf(db: DatabaseSync, table: string): ForeignKey[] {
    const rows = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table) as unknown as Array<{ id: number; seq: number; table: string; from: string; to: string | null }>;
    return rows.sort((a, b) => a.id - b.id || a.seq - b.seq).map(fk => ({
        constraint_name: `${table}_fk_${fk.id}`,
        source_schema: SQLITE_NAMESPACE,
        source_table: table,
        source_column: fk.from,
        target_schema: SQLITE_NAMESPACE,
        target_table: fk.table,
        // No column named: the target's primary key
        target_column: fk.to ?? primaryKeyOf(db, fk.table)[fk.seq] ?? 'rowid',
    }));
}

/** Exact counts below this file size; above, none (COUNT(*) reads the whole table) */
const EXACT_COUNT_MAX_FILE = 64 * 1024 * 1024;
const SEARCH_COUNT_CAP = 10_000;

// --- Queries in a separate process --------------------------------------------------------------


export interface SqliteRun {
    rows: Array<Record<string, unknown>>;
    fields: string[];
    /** Table and column each result column comes from (null for an expression) */
    origins: Array<{ table: string | null; column: string | null }>;
    rowCount: number;
    truncated: boolean;
    duration: number;
}

/** One statement in its own process, killed after `timeoutMs` */
export function runSqliteIsolated(file: string, args: { sql: string; values?: unknown[]; mode: 'read' | 'write'; maxRows?: number; timeoutMs?: number }): Promise<SqliteRun> {
    if (!fs.existsSync(file)) return Promise.reject(new Error(`The SQLite file was not found: ${file}`));
    const timeoutMs = Math.max(100, Math.min(600000, Math.floor(Number(args.timeoutMs) || 60000)));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', SQLITE_RUNNER], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
            windowsHide: true,
        });
        const out: Buffer[] = [];
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`The query was stopped after ${Math.round(timeoutMs / 1000)} s`));
            let answer: ({ ok: boolean; error?: string } & SqliteRun) | undefined;
            try {
                answer = v8.deserialize(Buffer.concat(out));
            } catch {
                return reject(new Error(`The query stopped (code ${code}): ${stderr.trim().split('\n').pop() ?? ''}`));
            }
            if (answer?.ok) resolve(answer);
            else reject(new Error(answer?.error ?? 'The query failed'));
        });
        child.stdin.on('error', () => { /* the process ended first: close says why */ });
        child.stdin.end(v8.serialize({ file, sql: args.sql, values: bind(args.values ?? []), mode: args.mode, maxRows: args.maxRows || 5000 }));
    });
}

/** One reading statement on a read-only connection (in its own process) */
export async function runSqliteReadOnly(file: string, args: { sql: string; values?: unknown[]; maxRows?: number; timeoutMs?: number }): Promise<SqliteRun> {
    const problem = readOnlyProblem(args.sql, 'sqlite');
    if (problem) throw new Error(problem);
    return runSqliteIsolated(file, { ...args, mode: 'read' });
}

/** PRAGMA quick_check of a file (a backup), in its own process: corrupt pages show here */
async function quickCheck(file: string, timeoutMs: number): Promise<{ valid: boolean; error?: string }> {
    try {
        const result = await runSqliteIsolated(file, { sql: 'PRAGMA quick_check', mode: 'read', timeoutMs, maxRows: 20 });
        const lines = result.rows.map(row => String(Object.values(row)[0]));
        return lines.length === 1 && lines[0] === 'ok' ? { valid: true } : { valid: false, error: lines.slice(0, 5).join('; ') || 'no answer' };
    } catch (error) {
        return { valid: false, error: getErrorMessage(error) };
    }
}

function fileSize(file: string): number | null {
    try {
        let size = fs.statSync(file).size;
        try { size += fs.statSync(`${file}-wal`).size; } catch { /* no WAL file */ }
        return size;
    } catch {
        return null;
    }
}

// --- The driver ----------------------------------------------------------------------------------

export const sqliteDriver: EngineDriver = {
    manifest: SQLITE,

    connection: {
        test: async input => {
            const file = input.sqlite?.path;
            if (!file) throw new Error('Choose the SQLite file');
            logger.info(`SQLite connection test: ${file}`);
            return withDb(file, 'read', db => {
                const version = String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? '');
                return { version, tables: tableNames(db).length };
            });
        },
    },

    stats: {
        size: async dbId => fileSize(fileOf(dbId)),
    },

    catalog: {
        listNamespaces: async dbId => withDb(fileOf(dbId), 'read', db => ({ schemas: [{ name: SQLITE_NAMESPACE, table_count: tableNames(db).length }] })),

        listEntities: async dbId => {
            const file = fileOf(dbId);
            const exact = (fileSize(file) ?? 0) <= EXACT_COUNT_MAX_FILE;
            return withDb(file, 'read', db => ({
                schema: SQLITE_NAMESPACE,
                tables: tableNames(db).map(name => ({
                    name,
                    row_count: exact ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).get()?.n ?? 0) : null,
                    row_count_estimated: !exact,
                })),
            }));
        },

        describeEntity: async (dbId, args) => withDb(fileOf(dbId), 'read', db => {
            const columns = xinfo(db, args.table);
            const keys = columns.filter(c => c.pk > 0).map(c => c.name);
            const rowidAlias = keys.length === 1 && /^integer$/i.test(String(columns.find(c => c.pk > 0)?.type ?? '').trim());
            const unique = new Set<string>();
            const indexes = db.prepare('SELECT * FROM pragma_index_list(?)').all(args.table) as unknown as Array<{ name: string; unique: number; origin: string; partial: number }>;
            for (const index of indexes.filter(i => i.unique && i.origin !== 'pk' && !i.partial)) {
                const parts = db.prepare('SELECT * FROM pragma_index_info(?)').all(index.name) as unknown as Array<{ name: string | null }>;
                if (parts.length === 1 && parts[0].name) unique.add(parts[0].name);
            }
            const fks = foreignKeysOf(db, args.table);
            return {
                schema: SQLITE_NAMESPACE,
                columns: columns.filter(c => c.hidden !== 1).map(col => {
                    const fk = fks.find(f => f.source_column === col.name);
                    return {
                        ...describeSqliteColumn(col, rowidAlias && col.pk > 0),
                        is_primary: keys.includes(col.name),
                        is_unique: unique.has(col.name),
                        is_foreign: !!fk,
                        foreign_key: fk ? { schema: fk.target_schema, table: fk.target_table, column: fk.target_column } : null,
                    };
                }),
            };
        }),

        entityRelations: async (dbId, args) => withDb(fileOf(dbId), 'read', db => ({
            relations: foreignKeysOf(db, args.table).map(fk => ({
                constraint_name: fk.constraint_name,
                column_name: fk.source_column,
                foreign_table_schema: fk.target_schema,
                foreign_table_name: fk.target_table,
                foreign_column_name: fk.target_column,
            })),
        })),

        fullSchema: async dbId => withDb(fileOf(dbId), 'read', db => {
            const names = tableNames(db);
            const columns: Array<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }> = [];
            const primaryKeys: Array<{ table_schema: string; table_name: string; column_name: string }> = [];
            const foreignKeys: ForeignKey[] = [];
            for (const table of names) {
                const info = xinfo(db, table).filter(c => c.hidden !== 1);
                for (const col of info) {
                    columns.push({
                        table_schema: SQLITE_NAMESPACE, table_name: table, column_name: col.name,
                        data_type: String(col.type || 'any').toLowerCase(), is_nullable: col.notnull ? 'NO' : 'YES', column_default: col.dflt_value,
                    });
                    if (col.pk > 0) primaryKeys.push({ table_schema: SQLITE_NAMESPACE, table_name: table, column_name: col.name });
                }
                foreignKeys.push(...foreignKeysOf(db, table));
            }
            return { schema: SQLITE_NAMESPACE, tables: names.map(name => ({ schema: SQLITE_NAMESPACE, name })), columns, primaryKeys, foreignKeys };
        }),

        // SQLite has no enum types
        enumValues: async () => ({ values: [] }),
    },

    records: {
        count: async (dbId, args) => withDb(fileOf(dbId), 'read', db => ({ count: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(args.table)}`).get()?.n ?? 0) })),

        page: async (dbId, args) => withDb(fileOf(dbId), 'read', db => {
            const offset = Math.max(0, Number(args.offset) || 0);
            const limit = Math.max(1, Math.min(10000, Number(args.limit) || 50));
            const order = args.sortBy ? `ORDER BY ${q(args.sortBy)} ${args.sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}` : '';
            const search = args.search?.trim();
            const columns = xinfo(db, args.table).filter(c => c.hidden !== 1);
            let where = '';
            const values: unknown[] = [];
            if (search) {
                // LIKE is case-insensitive for ASCII letters
                where = `WHERE ${columns.map(c => `CAST(${q(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')}`;
                for (let i = 0; i < columns.length; i++) values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
            }
            const rows = db.prepare(`SELECT * FROM ${q(args.table)} ${where} ${order} LIMIT ? OFFSET ?`).all(...bind([...values, limit, offset]));
            let total = Number(db.prepare(search
                ? `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(args.table)} ${where} LIMIT ${SEARCH_COUNT_CAP + 1})`
                : `SELECT COUNT(*) AS n FROM ${q(args.table)}`).get(...bind(values))?.n ?? 0);
            let totalIsEstimate = false;
            if (search && total > SEARCH_COUNT_CAP) {
                total = SEARCH_COUNT_CAP;
                totalIsEstimate = true;
            }
            return {
                rows: plainRows(rows, new Set(columns.filter(c => isBoolType(c.type)).map(c => c.name))),
                total,
                totalIsEstimate,
                offset,
                hasMore: offset + rows.length < total || (totalIsEstimate && rows.length === limit),
            };
        }),

        lookup: async (dbId, args) => withDb(fileOf(dbId), 'read', db => {
            const row = db.prepare(`SELECT * FROM ${q(args.table)} WHERE ${q(args.column)} = ? LIMIT 1`).get(sqliteBindable(args.value));
            return { row: row ? plainRows([row], boolColumnsOf(db, args.table))[0] : null };
        }),

        update: async (dbId, args) => withDb(fileOf(dbId), 'write', db => {
            const results: Array<{ success: boolean; column: string; error: string; rowsAffected?: undefined } | { success: boolean; column: string; rowsAffected: number | null; error?: undefined }> = [];
            db.exec('BEGIN');
            try {
                for (const change of args.changes) {
                    let where = '';
                    const whereValues: unknown[] = [];
                    if (change.rowId !== undefined && change.rowId !== null && change.primaryKeyColumn) {
                        where = `${q(change.primaryKeyColumn)} = ?`;
                        whereValues.push(change.rowId);
                    } else if (change.rowData) {
                        const conditions = Object.entries(change.rowData)
                            .filter(([key]) => key !== change.column)
                            .map(([key, value]) => {
                                if (value === null) return `${q(key)} IS NULL`;
                                whereValues.push(value);
                                return `${q(key)} = ?`;
                            }).join(' AND ');
                        // Without a key, one matching row only
                        where = `rowid = (SELECT rowid FROM ${q(args.table)} WHERE ${conditions} LIMIT 1)`;
                    } else {
                        results.push({ success: false, column: change.column, error: 'No row identifier provided' });
                        continue;
                    }
                    try {
                        const result = db.prepare(`UPDATE ${q(args.table)} SET ${q(change.column)} = ? WHERE ${where}`).run(...bind([change.newValue, ...whereValues]));
                        results.push({ success: true, column: change.column, rowsAffected: Number(result.changes) });
                    } catch (error) {
                        results.push({ success: false, column: change.column, error: getErrorMessage(error) });
                    }
                }
                const success = results.every(r => r.success);
                db.exec(success ? 'COMMIT' : 'ROLLBACK');
                return { success, results };
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch { /* already ended */ }
                throw new Error(`Failed to update table data: ${getErrorMessage(error)}`);
            }
        }),

        remove: async (dbId, args) => withDb(fileOf(dbId), 'write', db => {
            try {
                const result = db.prepare(`DELETE FROM ${q(args.table)} WHERE ${q(args.primaryKeyColumn)} = ?`).run(sqliteBindable(args.rowId));
                return { success: true, rowsAffected: Number(result.changes) };
            } catch (error) {
                throw new Error(`Failed to delete row: ${getErrorMessage(error)}`);
            }
        }),

        insert: async (dbId, args) => withDb(fileOf(dbId), 'write', db => {
            try {
                const columns = Object.keys(args.rowData);
                // RETURNING since SQLite 3.35
                const sql = columns.length
                    ? `INSERT INTO ${q(args.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`
                    : `INSERT INTO ${q(args.table)} DEFAULT VALUES RETURNING *`;
                const row = db.prepare(sql).get(...bind(Object.values(args.rowData)));
                return { success: true, row: row ? plainRows([row], boolColumnsOf(db, args.table))[0] : args.rowData };
            } catch (error) {
                throw new Error(`Failed to insert row: ${getErrorMessage(error)}`);
            }
        }),
    },

    query: {
        run: async (dbId, args) => {
            const result = await runSqliteReadOnly(fileOf(dbId), args);
            return { rows: result.rows, fields: result.fields, types: result.fields.map(() => 0), rowCount: result.rowCount, truncated: result.truncated, duration: result.duration };
        },

        runMutation: async (dbId, args) => {
            if (statementCount(args.sql, 'sqlite') > 1) throw new Error('Run one statement at a time');
            const result = await runSqliteIsolated(fileOf(dbId), { sql: args.sql, mode: 'write', maxRows: args.maxRows, timeoutMs: args.timeoutMs });
            return { rows: result.rows, fields: result.fields, rowCount: result.rowCount, truncated: result.truncated, duration: result.duration, command: statementKind(args.sql, 'sqlite') };
        },
    },

    backup: {
        /** SQLite's online backup into the backup file: consistent while an app writes to the database */
        dump: async db => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, db.name);
                return { success: false, database: db.name, timestamp, error };
            };
            const file = db.sqlite?.path;
            if (!file) return fail('This SQLite database has no file');
            if (!fs.existsSync(file)) return fail(`The SQLite file was not found: ${file}`);
            const prepared = await backupManager.prepareBackupFile(db, timestamp, async () => fileSize(file));
            if ('failure' in prepared) return prepared.failure;
            let source: DatabaseSync | undefined;
            try {
                source = new (lib().DatabaseSync)(file, { readOnly: true });
                const pages = await lib().backup(source, prepared.file);
                logger.info(`SQLite online backup of ${file}: ${pages} page(s)`, db.name);
            } catch (error) {
                try { fs.rmSync(prepared.file, { force: true }); } catch { /* nothing written */ }
                return fail(`SQLite backup failed: ${getErrorMessage(error)}`);
            } finally {
                source?.close();
            }
            return backupManager.finishDump(db, {
                file: prepared.file,
                timestamp,
                verify: copy => quickCheck(copy, db.backupTimeout ?? 30 * 60 * 1000),
            });
        },
    },

    restore: {
        /**
         * Writes the backup into the database file with SQLite's backup (all or nothing, the
         * other connections see the new content). The backup is checked first.
         */
        restore: async (backupFile, target) => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, target.name);
                return { success: false, database: target.name, timestamp, error };
            };
            const file = target.sqlite?.path;
            if (!file) return fail('This SQLite database has no file');
            const opened = await backupManager.openBackupForRestore(backupFile, target.name, 'sqlite', timestamp);
            if ('failure' in opened) return opened.failure;
            let source: DatabaseSync | undefined;
            try {
                const checked = await quickCheck(opened.file, 30 * 60 * 1000);
                if (!checked.valid) return fail(`This backup cannot be restored: ${checked.error}. Nothing was changed`);
                source = new (lib().DatabaseSync)(opened.file, { readOnly: true });
                await lib().backup(source, file);
                const tables = withDb(file, 'read', db => tableNames(db).length);
                const message = `Restore successful from ${backupFile} to ${file} (${tables} table(s))`;
                logger.info(message, target.name);
                return { success: true, database: target.name, timestamp, message };
            } catch (error) {
                return fail(`Restore failed: ${getErrorMessage(error)}`);
            } finally {
                source?.close();
                opened.cleanup();
            }
        },
    },
};

/** Runs `fn` with a write connection to a saved SQLite database (the AI journal's undo uses it) */
export function withSavedSqlite<T>(dbId: string, fn: (db: DatabaseSync) => T): T {
    return withDb(fileOf(dbId), 'write', fn);
}

/**
 * SQL Server (and Azure SQL): mssql over tedious, loaded on first use. The explorer's facets
 * return the shapes of dbViewer.ts (PostgreSQL), so the table explorer, the SQL editor and
 * dashboards work as they are; a saved database is one SQL Server database, its schemas are
 * the explorer's (dbo first).
 *
 * Backups are bbdump's own: SQL Server's BACKUP writes on the server's disk, out of reach for a
 * remote server. The backup is a gzipped list of JSON lines read in one snapshot when the
 * database allows it: the schemas, sequences, tables, their rows, indexes, constraints, foreign
 * keys, then views, functions, procedures and triggers. A restore replays it in ONE
 * transaction (SQL Server's DDL is transactional): all of it, or nothing.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as readline from 'readline';
import type { ConnectionPool, Request, Transaction, IColumnMetadata, config as MssqlConfig } from 'mssql';
import { connectionParamsFor } from '../savedConnection';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { SQLSERVER_BACKUP_HEADER } from '../backupFormat';
import { SQLSERVER } from '../../shared/engines/manifests';
import { readOnlyProblem, replacePlaceholders, statementKind } from '../../shared/engines/sqlGuard';
import { sqlserverConnection, sqlserverIdent as q, type SqlServerConnection, type SqlServerTarget } from '../../shared/engines/sqlserverUri';
import type { BackupResult } from '../../types/config';
import type { EngineDriver } from './driver';

type Row = Record<string, unknown>;
type Mssql = typeof import('mssql');
type ColumnInfo = IColumnMetadata[string];

let mssqlModule: Mssql | null = null;
async function mssql(): Promise<Mssql> {
    if (!mssqlModule) {
        const loaded = await import('mssql') as Mssql & { default?: Mssql };
        mssqlModule = loaded.default ?? loaded;
    }
    return mssqlModule;
}

export const SQLSERVER_DEFAULT_SCHEMA = 'dbo';

// --- Connections ---------------------------------------------------------------------------------

interface PoolEntry { pool: ConnectionPool; lastUse: number }
const pools = new Map<string, PoolEntry>();
const POOL_IDLE_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
    for (const [key, entry] of pools) {
        if (Date.now() - entry.lastUse > POOL_IDLE_MS) {
            pools.delete(key);
            entry.pool.close().catch(() => {});
        }
    }
}, 60 * 1000);
cleanupTimer.unref?.();

export async function closeSqlServerPools(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map(entry => entry.pool.close().catch(() => {})));
}

/** mssql's options for a connection: TLS as asked, dates read as written (no time zone shift) */
export function mssqlConfig(conn: SqlServerConnection, poolMax = 5): MssqlConfig {
    return {
        server: conn.server,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database || undefined,
        connectionTimeout: 15000,
        // Each query has its own time limit (bbdump cancels it)
        requestTimeout: 0,
        pool: { max: poolMax, min: 0, idleTimeoutMillis: 60000 },
        options: {
            encrypt: conn.encrypt,
            trustServerCertificate: conn.trustServerCertificate,
            instanceName: conn.instanceName,
            enableArithAbort: true,
            useUTC: false,
            appName: 'bbdump',
            ...(conn.caFile ? { cryptoCredentialsDetails: { ca: fs.readFileSync(conn.caFile) } } : {}),
        },
    } as MssqlConfig;
}

const poolKey = (conn: SqlServerConnection) => `${conn.user}@${conn.label}/${conn.database}#${conn.encrypt}${conn.trustServerCertificate}${conn.caFile ?? ''}`;

async function poolFor(target: SqlServerTarget): Promise<ConnectionPool> {
    const conn = sqlserverConnection(target);
    const key = poolKey(conn);
    const found = pools.get(key);
    if (found) {
        found.lastUse = Date.now();
        return found.pool;
    }
    const { ConnectionPool: Pool } = await mssql();
    const pool = new Pool(mssqlConfig(conn));
    try {
        await pool.connect();
    } catch (error) {
        pool.close().catch(() => {});
        throw new Error(friendly(error));
    }
    pools.set(key, { pool, lastUse: Date.now() });
    return pool;
}

/** A driver error in a sentence, with what a refused certificate needs */
export function friendly(error: unknown): string {
    const message = getErrorMessage(error);
    if (/self[- ]signed|unable to verify|certificate/i.test(message)) {
        return `${message} (the server's certificate is not trusted: choose "Encrypt, do not verify" (TrustServerCertificate=true), or give its CA)`;
    }
    return message;
}

/** A saved database, reached (password decrypted, SSH tunnel open) */
async function saved(dbId: string): Promise<SqlServerTarget> {
    const params = await connectionParamsFor(dbId);
    return { ...params, sslMode: params.sslMode as SqlServerTarget['sslMode'] };
}

function targetOf(db: { name: string; host: string; port: number; user: string; password?: string; connectionString?: string; sslMode?: string; sslRootCert?: string; viaTunnel?: boolean }): SqlServerTarget {
    return {
        connectionString: db.connectionString,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.name,
        sslMode: db.sslMode as SqlServerTarget['sslMode'],
        sslRootCert: db.sslRootCert,
        viaTunnel: db.viaTunnel,
    };
}

/** A value bound as a parameter: JSON values as text, whole numbers past 32 bits as bigint */
function bind(request: Request, name: string, value: unknown, types: Mssql): void {
    if (value === undefined || value === null) request.input(name, types.NVarChar, null);
    else if (typeof value === 'boolean') request.input(name, types.Bit, value);
    else if (typeof value === 'number') {
        if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) request.input(name, types.Int, value);
        else if (Number.isSafeInteger(value)) request.input(name, types.BigInt, value);
        else request.input(name, types.Float, value);
    } else if (typeof value === 'bigint') request.input(name, types.NVarChar(40), value.toString());
    else if (value instanceof Date) request.input(name, types.DateTime2(7), value);
    else if (Buffer.isBuffer(value) || value instanceof Uint8Array) request.input(name, types.VarBinary(types.MAX), Buffer.from(value));
    else if (typeof value === 'object') request.input(name, types.NVarChar(types.MAX), JSON.stringify(value));
    else request.input(name, types.NVarChar(types.MAX), String(value));
}

interface Result { recordset: Row[]; recordsets: Row[][]; rowsAffected: number[] }

/** Runs statements with @p1… parameters, on a pool or in a transaction */
async function run(on: ConnectionPool | Transaction, sql: string, values: unknown[] = []): Promise<Result> {
    const types = await mssql();
    const request = new types.Request(on as ConnectionPool);
    values.forEach((value, i) => bind(request, `p${i + 1}`, value, types));
    const result = await request.query(sql);
    return { recordset: (result.recordset ?? []) as Row[], recordsets: (result.recordsets ?? []) as unknown as Row[][], rowsAffected: result.rowsAffected ?? [] };
}

/** XACT_STATE(): 1 the transaction can go on, -1 it can only be rolled back */
async function transactionState(tx: Transaction): Promise<number> {
    try {
        return Number((await run(tx, 'SELECT XACT_STATE() AS s')).recordset[0]?.s ?? -1);
    } catch {
        return -1;
    }
}

// --- Catalog -------------------------------------------------------------------------------------

const EXACT_COUNT_MAX_ROWS = 1_000_000;
const SEARCH_COUNT_CAP = 10_000;

/** User schemas: dbo, and the ones created (not guest, sys, INFORMATION_SCHEMA or the roles') */
const USER_SCHEMAS = "(s.schema_id = 1 OR (s.schema_id BETWEEN 5 AND 16383 AND s.name NOT IN ('guest', 'sys', 'INFORMATION_SCHEMA')))";

interface ColumnRow {
    column_name: string; type_name: string; base_type: string; max_length: number; precision: number; scale: number;
    is_nullable: boolean; is_identity: boolean; is_computed: boolean; column_default: string | null; is_rowversion: boolean;
}

/** A column's type as written in T-SQL: nvarchar(50), decimal(10,2), datetime2(7)… */
export function sqlserverTypeText(type: string, maxLength: number, precision: number, scale: number): string {
    const name = type.toLowerCase();
    if (['varchar', 'char', 'varbinary', 'binary'].includes(name)) return `${name}(${maxLength === -1 ? 'max' : maxLength})`;
    if (['nvarchar', 'nchar'].includes(name)) return `${name}(${maxLength === -1 ? 'max' : maxLength / 2})`;
    if (['decimal', 'numeric'].includes(name)) return `${name}(${precision},${scale})`;
    if (['datetime2', 'time', 'datetimeoffset'].includes(name)) return `${name}(${scale})`;
    if (name === 'float' && precision && precision !== 53) return `float(${precision})`;
    return name;
}

const COLUMNS_SQL = `
    SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS type_name,
           COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS base_type,
           c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
           dc.definition AS column_default,
           CAST(CASE WHEN TYPE_NAME(c.system_type_id) = 'timestamp' THEN 1 ELSE 0 END AS bit) AS is_rowversion
    FROM sys.columns c
    LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    WHERE c.object_id = OBJECT_ID(@p1)
    ORDER BY c.column_id`;

const FOREIGN_KEYS_SQL = `
    SELECT fk.name AS constraint_name, SCHEMA_NAME(ps.schema_id) AS source_schema, ps.name AS source_table,
           pc.name AS source_column, SCHEMA_NAME(rs.schema_id) AS target_schema, rs.name AS target_table, rc.name AS target_column
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.tables ps ON ps.object_id = fkc.parent_object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.tables rs ON rs.object_id = fkc.referenced_object_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id`;

/** [schema].[table] */
const qualified = (schema: string | undefined, table: string) => `${q(schema || SQLSERVER_DEFAULT_SCHEMA)}.${q(table)}`;

async function columnsOf(pool: ConnectionPool, schema: string | undefined, table: string): Promise<ColumnRow[]> {
    return (await run(pool, COLUMNS_SQL, [qualified(schema, table)])).recordset as unknown as ColumnRow[];
}

async function primaryKeyColumns(pool: ConnectionPool, schema: string | undefined, table: string): Promise<string[]> {
    const { recordset } = await run(pool, `
        SELECT c.name AS column_name FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@p1) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`, [qualified(schema, table)]);
    return recordset.map(r => String(r.column_name));
}

/** A SQL Server column in the shape of PostgreSQL's information_schema (what the explorer reads) */
export function describeSqlServerColumn(col: ColumnRow) {
    const base = String(col.base_type || col.type_name).toLowerCase();
    return {
        column_name: col.column_name,
        data_type: sqlserverTypeText(String(col.type_name), col.max_length, col.precision, col.scale),
        udt_schema: null,
        // bit is the explorer's boolean
        udt_name: base === 'bit' ? 'bool' : base,
        is_nullable: col.is_nullable ? 'YES' : 'NO',
        column_default: col.column_default,
        character_maximum_length: ['varchar', 'char', 'nvarchar', 'nchar'].includes(base) && col.max_length > 0 ? (base.startsWith('n') ? col.max_length / 2 : col.max_length) : null,
        numeric_precision: ['decimal', 'numeric'].includes(base) ? col.precision : null,
        numeric_scale: ['decimal', 'numeric'].includes(base) ? col.scale : null,
        is_identity: col.is_identity ? 'YES' : 'NO',
        identity_generation: col.is_identity ? 'ALWAYS' : null,
        // Computed and rowversion columns are never written
        is_generated: col.is_computed || col.is_rowversion ? 'ALWAYS' : 'NEVER',
    };
}

/** Columns a search reads as text (not binary, spatial, hierarchyid, rowversion) */
const searchable = (col: ColumnRow) => !['binary', 'varbinary', 'image', 'timestamp', 'geography', 'geometry', 'hierarchyid', 'sql_variant'].includes(String(col.base_type).toLowerCase());

/** LIKE without its wildcards: % _ [ ] are text */
export const likeLiteral = (text: string) => `%${text.replace(/[[\]%_]/g, c => `[${c}]`)}%`;

// --- Read-only queries ---------------------------------------------------------------------------

const clampTimeout = (ms: unknown) => Math.max(100, Math.min(600000, Math.floor(Number(ms) || 60000)));
const stopped = (ms: number) => new Error(`The query was stopped after ${Math.round(ms / 1000)} s`);

/** PostgreSQL type ids where dashboards need them: bigint (20) and decimals (1700) */
function typeIds(columns: Record<string, ColumnInfo> | undefined, fields: string[]): number[] {
    return fields.map(name => {
        const declaration = String((columns?.[name]?.type as { declaration?: string } | undefined)?.declaration ?? '').toLowerCase();
        if (declaration === 'bigint') return 20;
        if (['decimal', 'numeric', 'money', 'smallmoney'].includes(declaration)) return 1700;
        return 0;
    });
}

/**
 * One reading statement in a transaction always rolled back, its rows streamed: past `maxRows`
 * the query is cancelled (nothing more is read), past its time too.
 */
export async function runReadOnly(target: SqlServerTarget, args: { sql: string; maxRows?: number; timeoutMs?: number; values?: unknown[] }) {
    const problem = readOnlyProblem(args.sql, 'tsql');
    if (problem) throw new Error(problem);
    const maxRows = Math.max(1, Math.min(100000, Number(args.maxRows) || 5000));
    const timeoutMs = clampTimeout(args.timeoutMs);
    const pool = await poolFor(target);
    const types = await mssql();
    const tx = new types.Transaction(pool);
    await tx.begin();
    try {
        const request = new types.Request(tx);
        (args.values ?? []).forEach((value, i) => bind(request, `p${i + 1}`, value, types));
        request.stream = true;
        const rows: Row[] = [];
        let columns: Record<string, ColumnInfo> | undefined;
        let truncated = false;
        let timedOut = false;
        const start = Date.now();
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { timedOut = true; request.cancel(); }, timeoutMs);
            // The first result set only
            request.on('recordset', (cols: Record<string, ColumnInfo>) => { if (!columns) columns = cols; });
            request.on('row', (row: Row) => {
                if (truncated) return;
                if (rows.length >= maxRows) {
                    truncated = true;
                    request.cancel();
                    return;
                }
                rows.push(row);
            });
            request.on('error', (error: Error & { code?: string }) => {
                clearTimeout(timer);
                // Cancelled past maxRows: the rows read are the result
                if (error.code === 'ECANCEL' && truncated && !timedOut) return resolve();
                reject(timedOut ? stopped(timeoutMs) : new Error(getErrorMessage(error)));
            });
            request.on('done', () => {
                clearTimeout(timer);
                if (timedOut) reject(stopped(timeoutMs));
                else resolve();
            });
            request.query(replacePlaceholders(args.sql, 'tsql', i => `@p${i + 1}`));
        });
        const fields = columns ? Object.values(columns).sort((a, b) => a.index - b.index).map(c => c.name) : rows.length ? Object.keys(rows[0]) : [];
        return { rows, fields, types: typeIds(columns, fields), rowCount: rows.length, truncated, duration: Date.now() - start };
    } finally {
        await tx.rollback().catch(() => {});
    }
}

// --- Backups -------------------------------------------------------------------------------------

interface DumpColumn {
    name: string; type: string; base: string; nullable: boolean; collation: string | null;
    identity: { seed: string; increment: string } | null; computed: { definition: string; persisted: boolean } | null;
    default: { name: string; definition: string } | null; rowguid: boolean; rowversion: boolean; sparse: boolean;
}

interface DumpIndex {
    name: string; clustered: boolean; unique: boolean; constraint: 'primary' | 'unique' | null;
    columns: Array<{ name: string; desc: boolean }>; include: string[]; filter: string | null;
}

/** One line of a backup */
type Line =
    | { t: 'header'; bbdump: string; version: number; server: string; database: string; snapshot: boolean }
    | { t: 'schema'; name: string }
    | { t: 'sequence'; schema: string; name: string; type: string; start: string; increment: string; min: string; max: string; cycle: boolean; current: string | null }
    | { t: 'table'; schema: string; name: string; columns: DumpColumn[]; primaryKey: DumpIndex | null; identity: { last: string | null } | null }
    | { t: 'rows'; schema: string; name: string; columns: string[]; rows: unknown[][] }
    | { t: 'index'; schema: string; table: string; index: DumpIndex }
    | { t: 'check'; schema: string; table: string; name: string; definition: string; trusted: boolean }
    | { t: 'fk'; schema: string; table: string; name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string; trusted: boolean }
    | { t: 'module'; schema: string; name: string; kind: string; definition: string; quotedIdentifier: boolean; ansiNulls: boolean }
    | { t: 'end'; tables: number; rows: number; skipped: string[] };

/** How a column is read for the backup: exact text for decimals and dates, bytes for spatial types */
export function dumpExpression(col: Pick<DumpColumn, 'name' | 'base'>): string {
    const c = q(col.name);
    switch (col.base.toLowerCase()) {
        case 'decimal': case 'numeric': return `CONVERT(varchar(60), ${c})`;
        case 'money': case 'smallmoney': return `CONVERT(varchar(60), ${c}, 2)`;
        case 'datetime': case 'datetime2': case 'smalldatetime': return `CONVERT(varchar(40), ${c}, 126)`;
        // Its own offset kept ("2026-10-29 15:53:50.1234567 +02:00")
        case 'datetimeoffset': return `CAST(${c} AS varchar(50))`;
        case 'date': return `CONVERT(varchar(10), ${c}, 23)`;
        case 'time': return `CONVERT(varchar(20), ${c})`;
        case 'xml': case 'sql_variant': return `CONVERT(nvarchar(max), ${c})`;
        case 'geography': case 'geometry': case 'hierarchyid': return `CAST(${c} AS varbinary(max))`;
        default: return c;
    }
}

/** A value of a row in JSON: bytes as {"$b": base64} */
const encodeValue = (value: unknown): unknown => (Buffer.isBuffer(value) ? { $b: value.toString('base64') } : value instanceof Date ? value.toISOString() : value);
const decodeValue = (value: unknown): unknown => (value && typeof value === 'object' && '$b' in (value as object) ? Buffer.from(String((value as { $b: string }).$b), 'base64') : value);

const ROWS_PER_LINE = 500;

/** Modules in an order where each comes after what it uses (triggers last); a cycle keeps the id order */
export function orderModules<T extends { id: number; trigger: boolean }>(modules: T[], depends: Array<[number, number]>): T[] {
    const ids = new Set(modules.map(m => m.id));
    const needs = new Map<number, Set<number>>();
    for (const [from, to] of depends) {
        if (!ids.has(from) || !ids.has(to)) continue;
        if (!needs.has(from)) needs.set(from, new Set());
        needs.get(from)!.add(to);
    }
    const done = new Set<number>();
    const result: T[] = [];
    // Views, functions and procedures first, then triggers (which may use any of them)
    for (const group of [modules.filter(m => !m.trigger), modules.filter(m => m.trigger)]) {
        let left = group;
        while (left.length) {
            const ready = left.filter(m => [...(needs.get(m.id) ?? [])].every(id => done.has(id)));
            const next = ready.length ? ready : [left[0]];
            for (const m of next) { done.add(m.id); result.push(m); }
            left = left.filter(m => !done.has(m.id));
        }
    }
    return result;
}

/** Streams the rows of one table into `rows` lines (the reading pauses while a line is written) */
async function dumpRows(reader: ConnectionPool | Transaction, schema: string, name: string, written: DumpColumn[], out: (line: Line) => Promise<void>): Promise<number> {
    const types = await mssql();
    const request = new types.Request(reader as ConnectionPool);
    request.stream = true;
    const names = written.map(c => c.name);
    let batch: unknown[][] = [];
    let count = 0;
    let pending: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
        request.on('row', (row: Row) => {
            batch.push(written.map(c => encodeValue(row[c.name])));
            count++;
            if (batch.length >= ROWS_PER_LINE) {
                const lines = batch;
                batch = [];
                request.pause();
                pending = pending.then(() => out({ t: 'rows', schema, name, columns: names, rows: lines })).then(() => { request.resume(); }, reject);
            }
        });
        request.on('error', reject);
        request.on('done', () => {
            pending.then(async () => {
                if (batch.length) await out({ t: 'rows', schema, name, columns: names, rows: batch });
                resolve();
            }, reject);
        });
        request.query(`SELECT ${written.map(c => `${dumpExpression(c)} AS ${q(c.name)}`).join(', ')} FROM ${qualified(schema, name)}`);
    });
    return count;
}

/** Reads the catalog and the rows of the database into the backup's lines, in replay order */
async function writeBackup(pool: ConnectionPool, out: (line: Line) => Promise<void>, database: string): Promise<{ tables: number; rows: number; skipped: string[]; snapshot: boolean }> {
    const types = await mssql();
    const tx = new types.Transaction(pool);
    let snapshot = true;
    try {
        await tx.begin(types.ISOLATION_LEVEL.SNAPSHOT);
        // The first read starts the snapshot (and fails when the database does not allow it)
        await run(tx, 'SELECT COUNT(*) AS n FROM sys.objects WHERE 1 = 0');
    } catch {
        await tx.rollback().catch(() => {});
        snapshot = false;
    }
    const reader: ConnectionPool | Transaction = snapshot ? tx : pool;
    const skipped: string[] = [];
    let totalRows = 0;
    try {
        const version = String((await run(reader, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS v")).recordset[0]?.v ?? '');
        await out({ t: 'header', bbdump: 'sqlserver backup', version: 1, server: version, database, snapshot });

        for (const s of (await run(reader, `SELECT s.name FROM sys.schemas s WHERE ${USER_SCHEMAS} AND s.name <> 'dbo' ORDER BY s.schema_id`)).recordset) {
            await out({ t: 'schema', name: String(s.name) });
        }

        const sequences = (await run(reader, `
            SELECT SCHEMA_NAME(sq.schema_id) AS s, sq.name, TYPE_NAME(sq.user_type_id) AS type,
                   CAST(sq.start_value AS nvarchar(60)) AS start_value, CAST(sq.increment AS nvarchar(60)) AS increment,
                   CAST(sq.minimum_value AS nvarchar(60)) AS min_value, CAST(sq.maximum_value AS nvarchar(60)) AS max_value,
                   sq.is_cycling, CAST(sq.current_value AS nvarchar(60)) AS current_value
            FROM sys.sequences sq ORDER BY sq.object_id`)).recordset;
        for (const s of sequences) {
            await out({
                t: 'sequence', schema: String(s.s), name: String(s.name), type: String(s.type), start: String(s.start_value), increment: String(s.increment),
                min: String(s.min_value), max: String(s.max_value), cycle: !!s.is_cycling,
                // The copy starts after it (a sequence never used shows its start: one value skipped, none given twice)
                current: s.current_value === null || s.current_value === undefined ? null : String(s.current_value),
            });
        }

        const tables = (await run(reader, 'SELECT t.object_id, SCHEMA_NAME(t.schema_id) AS s, t.name, t.temporal_type FROM sys.tables t WHERE t.is_ms_shipped = 0 AND t.temporal_type <> 1 ORDER BY t.object_id')).recordset;
        const indexRows = (await run(reader, `
            SELECT i.object_id, i.index_id, i.name, i.type, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.filter_definition,
                   c.name AS column_name, ic.key_ordinal, ic.is_descending_key, ic.is_included_column
            FROM sys.indexes i
            JOIN sys.tables t ON t.object_id = i.object_id AND t.is_ms_shipped = 0
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE i.type IN (1, 2) AND i.is_hypothetical = 0
            ORDER BY i.object_id, i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id`)).recordset;
        for (const i of (await run(reader, 'SELECT SCHEMA_NAME(t.schema_id) AS s, t.name AS t, i.name, i.type_desc FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id AND t.is_ms_shipped = 0 WHERE i.type > 2')).recordset) {
            skipped.push(`index ${i.s}.${i.t}.${i.name} (${String(i.type_desc).toLowerCase()})`);
        }
        const indexesOf = (objectId: number): DumpIndex[] => {
            const grouped = new Map<number, DumpIndex>();
            for (const row of indexRows.filter(r => Number(r.object_id) === objectId)) {
                const id = Number(row.index_id);
                const index = grouped.get(id) ?? {
                    name: String(row.name), clustered: Number(row.type) === 1, unique: !!row.is_unique,
                    constraint: row.is_primary_key ? 'primary' as const : row.is_unique_constraint ? 'unique' as const : null,
                    columns: [], include: [], filter: row.filter_definition === null || row.filter_definition === undefined ? null : String(row.filter_definition),
                };
                if (row.is_included_column) index.include.push(String(row.column_name));
                else if (Number(row.key_ordinal) > 0) index.columns.push({ name: String(row.column_name), desc: !!row.is_descending_key });
                grouped.set(id, index);
            }
            return [...grouped.values()];
        };

        const laterIndexes: Array<{ schema: string; table: string; index: DumpIndex }> = [];
        for (const table of tables) {
            const schema = String(table.s);
            const name = String(table.name);
            if (Number(table.temporal_type) === 2) skipped.push(`system versioning of ${schema}.${name} (restored as a plain table)`);
            const cols = (await run(reader, `
                SELECT c.name, TYPE_NAME(c.user_type_id) AS type_name, COALESCE(TYPE_NAME(c.system_type_id), TYPE_NAME(c.user_type_id)) AS base_type,
                       c.max_length, c.precision, c.scale, c.is_nullable, c.collation_name, c.is_identity, c.is_computed, c.is_rowguidcol, c.is_sparse,
                       c.generated_always_type, CAST(ic.seed_value AS nvarchar(60)) AS seed, CAST(ic.increment_value AS nvarchar(60)) AS increment,
                       CAST(ic.last_value AS nvarchar(60)) AS last_value, cc.definition AS computed, cc.is_persisted,
                       dc.name AS default_name, dc.definition AS default_definition, ty.is_user_defined, ty.is_assembly_type
                FROM sys.columns c
                JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
                LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
                WHERE c.object_id = @p1 ORDER BY c.column_id`, [Number(table.object_id)])).recordset;
            const columns: DumpColumn[] = cols
                // The period columns of a system-versioned table: its history is not restored
                .filter(c => Number(c.generated_always_type ?? 0) === 0)
                .map(c => {
                    // An alias type (CREATE TYPE … FROM nvarchar(20)) is written as its base type
                    const typeName = c.is_user_defined && !c.is_assembly_type ? String(c.base_type) : String(c.type_name);
                    return {
                        name: String(c.name),
                        type: sqlserverTypeText(typeName, Number(c.max_length), Number(c.precision), Number(c.scale)),
                        base: String(c.is_assembly_type ? c.type_name : c.base_type).toLowerCase(),
                        nullable: !!c.is_nullable,
                        collation: c.collation_name === null || c.collation_name === undefined ? null : String(c.collation_name),
                        identity: c.is_identity ? { seed: String(c.seed), increment: String(c.increment) } : null,
                        computed: c.is_computed ? { definition: String(c.computed), persisted: !!c.is_persisted } : null,
                        default: c.default_name ? { name: String(c.default_name), definition: String(c.default_definition) } : null,
                        rowguid: !!c.is_rowguidcol,
                        rowversion: String(c.base_type).toLowerCase() === 'timestamp',
                        sparse: !!c.is_sparse,
                    };
                });
            const indexes = indexesOf(Number(table.object_id));
            const identityColumn = cols.find(c => c.is_identity);
            await out({
                t: 'table', schema, name, columns,
                primaryKey: indexes.find(i => i.constraint === 'primary') ?? null,
                identity: identityColumn ? { last: identityColumn.last_value === null || identityColumn.last_value === undefined ? null : String(identityColumn.last_value) } : null,
            });
            for (const index of indexes.filter(i => i.constraint !== 'primary')) laterIndexes.push({ schema, table: name, index });
            // The rows: written columns only (not computed, not rowversion)
            const written = columns.filter(c => !c.computed && !c.rowversion);
            if (written.length) totalRows += await dumpRows(reader, schema, name, written, out);
        }

        for (const entry of laterIndexes) await out({ t: 'index', ...entry });

        for (const c of (await run(reader, `
            SELECT SCHEMA_NAME(t.schema_id) AS s, t.name AS t, cc.name, cc.definition, cc.is_not_trusted, cc.is_disabled
            FROM sys.check_constraints cc JOIN sys.tables t ON t.object_id = cc.parent_object_id AND t.is_ms_shipped = 0 ORDER BY cc.object_id`)).recordset) {
            if (c.is_disabled) skipped.push(`disabled check ${c.s}.${c.t}.${c.name}`);
            else await out({ t: 'check', schema: String(c.s), table: String(c.t), name: String(c.name), definition: String(c.definition), trusted: !c.is_not_trusted });
        }

        const fkRows = (await run(reader, `
            SELECT fk.object_id, fk.name, SCHEMA_NAME(pt.schema_id) AS s, pt.name AS t, SCHEMA_NAME(rt.schema_id) AS rs, rt.name AS rt,
                   pc.name AS col, rc.name AS ref, fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
                   fk.is_not_trusted, fk.is_disabled
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
            JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
            JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
            JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            WHERE pt.is_ms_shipped = 0 ORDER BY fk.object_id, fkc.constraint_column_id`)).recordset;
        const fks = new Map<number, Extract<Line, { t: 'fk' }>>();
        for (const f of fkRows) {
            if (f.is_disabled) {
                skipped.push(`disabled foreign key ${f.s}.${f.t}.${f.name}`);
                continue;
            }
            const id = Number(f.object_id);
            const fk = fks.get(id) ?? {
                t: 'fk' as const, schema: String(f.s), table: String(f.t), name: String(f.name), columns: [], refSchema: String(f.rs), refTable: String(f.rt), refColumns: [],
                onDelete: String(f.on_delete).replace(/_/g, ' '), onUpdate: String(f.on_update).replace(/_/g, ' '), trusted: !f.is_not_trusted,
            };
            fk.columns.push(String(f.col));
            fk.refColumns.push(String(f.ref));
            fks.set(id, fk);
        }
        for (const fk of fks.values()) await out(fk);

        // Views, functions and procedures, then table triggers: each after what it uses
        const modules = (await run(reader, `
            SELECT o.object_id, SCHEMA_NAME(o.schema_id) AS s, o.name, o.type, m.definition, m.uses_quoted_identifier, m.uses_ansi_nulls
            FROM sys.objects o JOIN sys.sql_modules m ON m.object_id = o.object_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('V', 'FN', 'IF', 'TF', 'P', 'TR')
            ORDER BY o.object_id`)).recordset;
        const depends = (await run(reader, `
            SELECT DISTINCT d.referencing_id, d.referenced_id FROM sys.sql_expression_dependencies d
            WHERE d.referenced_id IS NOT NULL AND d.referencing_id <> d.referenced_id`)).recordset;
        for (const e of modules.filter(m => m.definition === null)) skipped.push(`${e.s}.${e.name} (encrypted)`);
        for (const tr of (await run(reader, 'SELECT name FROM sys.triggers WHERE parent_class = 0 AND is_ms_shipped = 0')).recordset) skipped.push(`database trigger ${tr.name}`);
        const ordered = orderModules(
            modules.filter(m => m.definition !== null).map(m => ({ id: Number(m.object_id), trigger: String(m.type).trim() === 'TR', row: m })),
            depends.map(d => [Number(d.referencing_id), Number(d.referenced_id)] as [number, number]),
        );
        for (const { row } of ordered) {
            await out({ t: 'module', schema: String(row.s), name: String(row.name), kind: String(row.type).trim(), definition: String(row.definition), quotedIdentifier: !!row.uses_quoted_identifier, ansiNulls: !!row.uses_ansi_nulls });
        }

        await out({ t: 'end', tables: tables.length, rows: totalRows, skipped });
        return { tables: tables.length, rows: totalRows, skipped, snapshot };
    } finally {
        if (snapshot) await tx.rollback().catch(() => {});
    }
}

/** Each line of a backup, in order (a damaged file fails on its line) */
async function* readBackup(file: string): AsyncGenerator<Line> {
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let first = true;
    try {
        for await (const text of lines) {
            if (first) {
                if (!text.startsWith(SQLSERVER_BACKUP_HEADER)) throw new Error('not a SQL Server backup made by bbdump');
                first = false;
            }
            if (text) yield JSON.parse(text) as Line;
        }
    } finally {
        lines.close();
        input.destroy();
    }
}

/** Reads a whole backup: its header, every line, and its last one with the counts it announces */
export async function verifySqlServerBackup(file: string): Promise<{ valid: boolean; error?: string; tables?: number }> {
    let rows = 0;
    let tables = 0;
    let end: Extract<Line, { t: 'end' }> | null = null;
    try {
        for await (const line of readBackup(file)) {
            if (end) return { valid: false, error: 'something follows the end of the backup' };
            if (line.t === 'rows') rows += line.rows.length;
            else if (line.t === 'table') tables++;
            else if (line.t === 'end') end = line;
        }
    } catch (error) {
        return { valid: false, error: `the backup cannot be read to its end (${getErrorMessage(error)})` };
    }
    if (!end) return { valid: false, error: 'the backup is incomplete (it has no end)' };
    if (end.rows !== rows || end.tables !== tables) return { valid: false, error: `the backup announces ${end.tables} table(s) and ${end.rows} row(s), it holds ${tables} and ${rows}` };
    return { valid: true, tables };
}

/** CREATE TABLE of a backed-up table (its primary key inline; other indexes and keys come later) */
export function createTableSql(line: Extract<Line, { t: 'table' }>): string {
    const columns = line.columns.map(c => {
        if (c.computed) return `${q(c.name)} AS ${c.computed.definition}${c.computed.persisted ? ' PERSISTED' : ''}`;
        const parts = [q(c.name), c.rowversion ? 'rowversion' : c.type];
        if (c.collation && /char|text/i.test(c.base)) parts.push(`COLLATE ${c.collation}`);
        if (c.sparse) parts.push('SPARSE');
        if (c.identity) parts.push(`IDENTITY(${c.identity.seed}, ${c.identity.increment})`);
        if (c.rowguid) parts.push('ROWGUIDCOL');
        parts.push(c.nullable ? 'NULL' : 'NOT NULL');
        if (c.default) parts.push(`CONSTRAINT ${q(c.default.name)} DEFAULT ${c.default.definition}`);
        return parts.join(' ');
    });
    const pk = line.primaryKey;
    if (pk) columns.push(`CONSTRAINT ${q(pk.name)} PRIMARY KEY ${pk.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${pk.columns.map(c => `${q(c.name)}${c.desc ? ' DESC' : ''}`).join(', ')})`);
    return `CREATE TABLE ${qualified(line.schema, line.name)} (\n  ${columns.join(',\n  ')}\n)`;
}

export function createIndexSql(line: Extract<Line, { t: 'index' }>): string {
    const { index } = line;
    const columns = index.columns.map(c => `${q(c.name)}${c.desc ? ' DESC' : ''}`).join(', ');
    if (index.constraint === 'unique') {
        return `ALTER TABLE ${qualified(line.schema, line.table)} ADD CONSTRAINT ${q(index.name)} UNIQUE ${index.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${columns})`;
    }
    return `CREATE ${index.unique ? 'UNIQUE ' : ''}${index.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${q(index.name)} ON ${qualified(line.schema, line.table)} (${columns})`
        + `${index.include.length ? ` INCLUDE (${index.include.map(q).join(', ')})` : ''}${index.filter ? ` WHERE ${index.filter}` : ''}`;
}

const SPATIAL = ['geography', 'geometry', 'hierarchyid'];

/** Inserts one `rows` line: at most 2100 parameters and 1000 rows per statement */
async function insertRows(tx: Transaction, table: string, line: Extract<Line, { t: 'rows' }>, columns: DumpColumn[]): Promise<void> {
    const types = await mssql();
    const kinds = line.columns.map(name => columns.find(c => c.name === name));
    const perStatement = Math.max(1, Math.min(1000, Math.floor(2000 / Math.max(1, line.columns.length))));
    for (let at = 0; at < line.rows.length; at += perStatement) {
        const request = new types.Request(tx);
        let n = 0;
        const values = line.rows.slice(at, at + perStatement).map(row => `(${row.map((value, i) => {
            const decoded = decodeValue(value);
            if (decoded === null || decoded === undefined) return 'NULL';
            const name = `p${++n}`;
            bind(request, name, decoded, types);
            const base = kinds[i]?.base ?? '';
            return SPATIAL.includes(base) ? `CAST(@${name} AS ${base})` : `@${name}`;
        }).join(', ')})`);
        await request.query(`INSERT INTO ${table} (${line.columns.map(q).join(', ')}) VALUES ${values.join(', ')}`);
    }
}

/** Puts the backup's lines into the target, inside `tx` (the caller commits or rolls back) */
async function replayBackup(tx: Transaction, file: string): Promise<{ tables: number; rows: number; modules: number; skipped: string[] }> {
    const tableColumns = new Map<string, DumpColumn[]>();
    const identities = new Map<string, string | null>();
    const filled = new Set<string>();
    const modules: Array<Extract<Line, { t: 'module' }>> = [];
    let rows = 0;
    let tables = 0;
    let skipped: string[] = [];
    let identityOn: string | null = null;
    const identityOff = async () => {
        if (!identityOn) return;
        await run(tx, `SET IDENTITY_INSERT ${identityOn} OFF`);
        identityOn = null;
    };
    for await (const line of readBackup(file)) {
        switch (line.t) {
            case 'header':
                break;
            case 'schema':
                await run(tx, 'IF SCHEMA_ID(@p1) IS NULL EXEC(@p2)', [line.name, `CREATE SCHEMA ${q(line.name)}`]);
                break;
            case 'sequence': {
                const next = line.current === null ? line.start : (BigInt(line.current) + BigInt(line.increment)).toString();
                const start = BigInt(next) >= BigInt(line.min) && BigInt(next) <= BigInt(line.max) ? next : line.start;
                await run(tx, `CREATE SEQUENCE ${qualified(line.schema, line.name)} AS ${line.type} START WITH ${start} INCREMENT BY ${line.increment} MINVALUE ${line.min} MAXVALUE ${line.max} ${line.cycle ? 'CYCLE' : 'NO CYCLE'}`);
                break;
            }
            case 'table':
                await identityOff();
                await run(tx, createTableSql(line));
                tableColumns.set(`${line.schema}.${line.name}`, line.columns);
                if (line.identity) identities.set(`${line.schema}.${line.name}`, line.identity.last);
                tables++;
                break;
            case 'rows': {
                const key = `${line.schema}.${line.name}`;
                const table = qualified(line.schema, line.name);
                if (identities.has(key) && identityOn !== table) {
                    await identityOff();
                    await run(tx, `SET IDENTITY_INSERT ${table} ON`);
                    identityOn = table;
                }
                await insertRows(tx, table, line, tableColumns.get(key) ?? []);
                rows += line.rows.length;
                filled.add(key);
                break;
            }
            case 'index':
                await identityOff();
                await run(tx, createIndexSql(line));
                break;
            case 'check':
                await identityOff();
                await run(tx, `ALTER TABLE ${qualified(line.schema, line.table)} WITH ${line.trusted ? 'CHECK' : 'NOCHECK'} ADD CONSTRAINT ${q(line.name)} CHECK ${line.definition}`);
                break;
            case 'fk':
                await identityOff();
                await run(tx, `ALTER TABLE ${qualified(line.schema, line.table)} WITH ${line.trusted ? 'CHECK' : 'NOCHECK'} ADD CONSTRAINT ${q(line.name)} FOREIGN KEY (${line.columns.map(q).join(', ')}) REFERENCES ${qualified(line.refSchema, line.refTable)} (${line.refColumns.map(q).join(', ')}) ON DELETE ${line.onDelete} ON UPDATE ${line.onUpdate}`);
                break;
            case 'module':
                await identityOff();
                modules.push(line);
                break;
            case 'end':
                skipped = line.skipped ?? [];
                break;
        }
    }
    await identityOff();
    // Identities go on where the source was (rows deleted there do not give their ids again)
    for (const [key, last] of identities) {
        if (last === null || !filled.has(key)) continue;
        const [schema, ...rest] = key.split('.');
        await run(tx, `DBCC CHECKIDENT (N'${qualified(schema, rest.join('.')).replace(/'/g, "''")}', RESEED, ${BigInt(last).toString()}) WITH NO_INFOMSGS`);
    }
    // Modules in the backup's order; one that needs another not created yet is tried again after it
    let left = modules;
    for (let round = 0; left.length && round < 5; round++) {
        const failed: typeof left = [];
        let lastError = '';
        for (const module of left) {
            await run(tx, 'SAVE TRANSACTION bbdump_module');
            try {
                // CREATE VIEW / PROCEDURE… must be alone in its batch; its SET options are its own
                await run(tx, `SET QUOTED_IDENTIFIER ${module.quotedIdentifier ? 'ON' : 'OFF'}; SET ANSI_NULLS ${module.ansiNulls ? 'ON' : 'OFF'};`);
                await run(tx, module.definition);
            } catch (error) {
                if (await transactionState(tx) !== 1) throw error;
                await run(tx, 'ROLLBACK TRANSACTION bbdump_module');
                lastError = getErrorMessage(error);
                failed.push(module);
            } finally {
                await run(tx, 'SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON;').catch(() => {});
            }
        }
        if (failed.length === left.length) throw new Error(`${failed.map(m => `${m.schema}.${m.name}`).join(', ')} could not be created: ${lastError}`);
        left = failed;
    }
    if (left.length) throw new Error(`${left.map(m => `${m.schema}.${m.name}`).join(', ')} could not be created`);
    return { tables, rows, modules: modules.length, skipped };
}

/** Removes the target's user objects (foreign keys, modules, tables, sequences, then its empty schemas), inside `tx` */
async function emptyDatabase(tx: Transaction): Promise<number> {
    for (const fk of (await run(tx, 'SELECT SCHEMA_NAME(t.schema_id) AS s, t.name AS t, fk.name FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id = fk.parent_object_id WHERE t.is_ms_shipped = 0')).recordset) {
        await run(tx, `ALTER TABLE ${qualified(String(fk.s), String(fk.t))} DROP CONSTRAINT ${q(String(fk.name))}`);
    }
    const modules = (await run(tx, "SELECT SCHEMA_NAME(o.schema_id) AS s, o.name, o.type FROM sys.objects o WHERE o.is_ms_shipped = 0 AND o.type IN ('V', 'FN', 'IF', 'TF', 'P') ORDER BY o.object_id DESC")).recordset;
    const kind = (type: string) => (type === 'V' ? 'VIEW' : type === 'P' ? 'PROCEDURE' : 'FUNCTION');
    // A schema-bound module goes once what it binds is gone: a few rounds
    let left = modules;
    for (let round = 0; left.length && round < 5; round++) {
        const failed: typeof left = [];
        for (const m of left) {
            await run(tx, 'SAVE TRANSACTION bbdump_empty');
            try {
                await run(tx, `DROP ${kind(String(m.type).trim())} ${qualified(String(m.s), String(m.name))}`);
            } catch (error) {
                if (await transactionState(tx) !== 1) throw error;
                await run(tx, 'ROLLBACK TRANSACTION bbdump_empty');
                failed.push(m);
            }
        }
        if (failed.length === left.length) break;
        left = failed;
    }
    // A system-versioned table: versioning off first, then both tables go
    for (const t of (await run(tx, 'SELECT SCHEMA_NAME(schema_id) AS s, name FROM sys.tables WHERE temporal_type = 2')).recordset) {
        await run(tx, `ALTER TABLE ${qualified(String(t.s), String(t.name))} SET (SYSTEM_VERSIONING = OFF)`);
    }
    const tables = (await run(tx, 'SELECT SCHEMA_NAME(schema_id) AS s, name FROM sys.tables WHERE is_ms_shipped = 0')).recordset;
    for (const t of tables) await run(tx, `DROP TABLE ${qualified(String(t.s), String(t.name))}`);
    for (const s of (await run(tx, 'SELECT SCHEMA_NAME(schema_id) AS s, name FROM sys.sequences')).recordset) {
        await run(tx, `DROP SEQUENCE ${qualified(String(s.s), String(s.name))}`);
    }
    for (const s of (await run(tx, `
        SELECT s.name FROM sys.schemas s WHERE s.schema_id BETWEEN 5 AND 16383 AND s.name NOT IN ('guest', 'sys', 'INFORMATION_SCHEMA')
        AND NOT EXISTS (SELECT 1 FROM sys.objects o WHERE o.schema_id = s.schema_id)
        AND NOT EXISTS (SELECT 1 FROM sys.types ty WHERE ty.schema_id = s.schema_id)`)).recordset) {
        await run(tx, `DROP SCHEMA ${q(String(s.name))}`);
    }
    return tables.length + modules.length;
}

async function databaseSize(target: SqlServerTarget): Promise<number | null> {
    const pool = await poolFor(target);
    const { recordset } = await run(pool, 'SELECT SUM(CAST(size AS bigint)) * 8192 AS bytes FROM sys.database_files');
    const size = Number(recordset[0]?.bytes);
    return Number.isFinite(size) ? size : null;
}

/** "2022 (16.0.4135.4)", "Azure SQL 12.0…" */
export function sqlserverVersionLabel(version: string, engineEdition: number): string {
    if (engineEdition === 5 || engineEdition === 8) return `Azure SQL ${version}`.trim();
    const year: Record<number, string> = { 17: '2025', 16: '2022', 15: '2019', 14: '2017', 13: '2016', 12: '2014', 11: '2012' };
    const major = Number(version.split('.')[0]);
    return year[major] ? `${year[major]} (${version})` : version;
}

// --- The driver ----------------------------------------------------------------------------------

export const sqlserverDriver: EngineDriver = {
    manifest: SQLSERVER,

    connection: {
        test: async input => {
            const conn = sqlserverConnection(targetOf({ ...input, name: input.database }));
            logger.info(`SQL Server connection test: ${conn.label}`);
            const { ConnectionPool: Pool } = await mssql();
            const pool = new Pool(mssqlConfig(conn, 1));
            try {
                await pool.connect();
            } catch (error) {
                pool.close().catch(() => {});
                throw new Error(friendly(error));
            }
            try {
                const { recordset } = await run(pool, `
                    SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS version, CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition,
                           (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS tables`);
                return { version: sqlserverVersionLabel(String(recordset[0]?.version ?? ''), Number(recordset[0]?.edition ?? 0)), tables: Number(recordset[0]?.tables ?? 0) };
            } finally {
                await pool.close().catch(() => {});
            }
        },
    },

    stats: {
        size: async dbId => databaseSize(await saved(dbId)),
    },

    catalog: {
        listNamespaces: async dbId => {
            const pool = await poolFor(await saved(dbId));
            const { recordset } = await run(pool, `
                SELECT s.name, COUNT(t.object_id) AS n FROM sys.schemas s
                LEFT JOIN sys.tables t ON t.schema_id = s.schema_id AND t.is_ms_shipped = 0
                WHERE ${USER_SCHEMAS}
                GROUP BY s.name, s.schema_id
                HAVING s.schema_id = 1 OR COUNT(t.object_id) > 0
                ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name`);
            return { schemas: recordset.map(r => ({ name: String(r.name), table_count: Number(r.n) })) };
        },

        listEntities: async (dbId, namespace) => {
            const schema = namespace || SQLSERVER_DEFAULT_SCHEMA;
            const pool = await poolFor(await saved(dbId));
            const { recordset } = await run(pool, `
                SELECT t.name, SUM(p.rows) AS estimate FROM sys.tables t
                JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
                WHERE t.is_ms_shipped = 0 AND t.schema_id = SCHEMA_ID(@p1)
                GROUP BY t.name ORDER BY t.name`, [schema]);
            const tables = recordset.map(r => ({ name: String(r.name), row_count: r.estimate === null ? null : Number(r.estimate), row_count_estimated: true }));
            // Exact counts below a million rows (the catalog's count is close, not always exact)
            const small = tables.filter(t => (t.row_count ?? 0) <= EXACT_COUNT_MAX_ROWS);
            if (small.length) {
                const counts = await run(pool, small.map((t, i) => `SELECT @p${i + 1} AS name, COUNT_BIG(*) AS n FROM ${qualified(schema, t.name)}`).join(' UNION ALL '), small.map(t => t.name));
                const exact = new Map(counts.recordset.map(c => [String(c.name), Number(c.n)]));
                for (const table of tables) {
                    if (exact.has(table.name)) {
                        table.row_count = exact.get(table.name) ?? 0;
                        table.row_count_estimated = false;
                    }
                }
            }
            return { schema, tables };
        },

        describeEntity: async (dbId, args) => {
            const schema = args.schema || SQLSERVER_DEFAULT_SCHEMA;
            const pool = await poolFor(await saved(dbId));
            const [columns, keys, uniques, fks] = await Promise.all([
                columnsOf(pool, schema, args.table),
                primaryKeyColumns(pool, schema, args.table),
                run(pool, `
                    SELECT MIN(c.name) AS column_name, COUNT(*) AS n FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE i.object_id = OBJECT_ID(@p1) AND i.is_unique = 1 AND i.is_primary_key = 0 AND i.has_filter = 0
                    GROUP BY i.index_id`, [qualified(schema, args.table)]).then(r => r.recordset),
                run(pool, `${FOREIGN_KEYS_SQL} WHERE fk.parent_object_id = OBJECT_ID(@p1) ORDER BY fk.name, fkc.constraint_column_id`, [qualified(schema, args.table)]).then(r => r.recordset),
            ]);
            const unique = new Set(uniques.filter(u => Number(u.n) === 1).map(u => String(u.column_name)));
            return {
                schema,
                columns: columns.map(col => {
                    const fk = fks.find(f => f.source_column === col.column_name);
                    return {
                        ...describeSqlServerColumn(col),
                        is_primary: keys.includes(col.column_name),
                        is_unique: unique.has(col.column_name),
                        is_foreign: !!fk,
                        foreign_key: fk ? { schema: String(fk.target_schema), table: String(fk.target_table), column: String(fk.target_column) } : null,
                    };
                }),
            };
        },

        entityRelations: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const { recordset } = await run(pool, `${FOREIGN_KEYS_SQL} WHERE fk.parent_object_id = OBJECT_ID(@p1) ORDER BY fk.name, fkc.constraint_column_id`, [qualified(args.schema, args.table)]);
            return {
                relations: recordset.map(fk => ({
                    constraint_name: String(fk.constraint_name),
                    column_name: String(fk.source_column),
                    foreign_table_schema: String(fk.target_schema),
                    foreign_table_name: String(fk.target_table),
                    foreign_column_name: String(fk.target_column),
                })),
            };
        },

        fullSchema: async (dbId, namespace) => {
            const pool = await poolFor(await saved(dbId));
            const only = namespace ? ' AND s.name = @p1' : '';
            const values = namespace ? [namespace] : [];
            const [tables, columns, keys, fks] = await Promise.all([
                run(pool, `SELECT s.name AS [schema], t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0${only} ORDER BY s.name, t.name`, values),
                run(pool, `
                    SELECT s.name AS table_schema, t.name AS table_name, c.name AS column_name, TYPE_NAME(c.user_type_id) AS type_name,
                           c.max_length, c.precision, c.scale, CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable, dc.definition AS column_default
                    FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id AND t.is_ms_shipped = 0
                    JOIN sys.schemas s ON s.schema_id = t.schema_id
                    LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
                    WHERE 1 = 1${only} ORDER BY s.name, t.name, c.column_id`, values),
                run(pool, `
                    SELECT s.name AS table_schema, t.name AS table_name, c.name AS column_name FROM sys.indexes i
                    JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE i.is_primary_key = 1${only}`, values),
                run(pool, `${FOREIGN_KEYS_SQL}${namespace ? ' WHERE SCHEMA_NAME(ps.schema_id) = @p1' : ''} ORDER BY ps.name, fk.name, fkc.constraint_column_id`, values),
            ]);
            return {
                schema: namespace ?? null,
                tables: tables.recordset as Array<{ schema: string; name: string }>,
                columns: columns.recordset.map(c => ({
                    table_schema: String(c.table_schema), table_name: String(c.table_name), column_name: String(c.column_name),
                    data_type: sqlserverTypeText(String(c.type_name), Number(c.max_length), Number(c.precision), Number(c.scale)),
                    is_nullable: String(c.is_nullable), column_default: c.column_default === null || c.column_default === undefined ? null : String(c.column_default),
                })),
                primaryKeys: keys.recordset as Array<{ table_schema: string; table_name: string; column_name: string }>,
                foreignKeys: fks.recordset as Array<{ constraint_name: string; source_schema: string; source_table: string; source_column: string; target_schema: string; target_table: string; target_column: string }>,
            };
        },

        // No enum types in SQL Server
        enumValues: async () => ({ values: [] }),
    },

    records: {
        count: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const { recordset } = await run(pool, `SELECT COUNT_BIG(*) AS n FROM ${qualified(args.schema, args.table)}`);
            return { count: Number(recordset[0]?.n ?? 0) };
        },

        page: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const table = qualified(args.schema, args.table);
            const offset = Math.max(0, Number(args.offset) || 0);
            const limit = Math.max(1, Math.min(10000, Number(args.limit) || 50));
            const [columns, keys] = await Promise.all([columnsOf(pool, args.schema, args.table), primaryKeyColumns(pool, args.schema, args.table)]);
            // OFFSET … FETCH needs an order: the one asked, else the key, else none in particular
            const order = args.sortBy && columns.some(c => c.column_name === args.sortBy)
                ? `ORDER BY ${q(args.sortBy)} ${args.sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`
                : keys.length ? `ORDER BY ${keys.map(q).join(', ')}` : 'ORDER BY (SELECT NULL)';
            const search = args.search?.trim();
            const values: unknown[] = [];
            let where = '';
            if (search) {
                values.push(likeLiteral(search));
                where = `WHERE ${columns.filter(searchable).map(c => `CAST(${q(c.column_name)} AS nvarchar(max)) LIKE @p1`).join(' OR ') || '1 = 0'}`;
            }
            const estimate = Number((await run(pool, 'SELECT SUM(p.rows) AS n FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@p1) AND p.index_id IN (0, 1)', [table])).recordset[0]?.n ?? 0);
            const useEstimate = !search && estimate > EXACT_COUNT_MAX_ROWS;
            const page = await run(pool, `SELECT * FROM ${table} ${where} ${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, values);
            let total = estimate;
            if (!useEstimate) {
                const counted = await run(pool, search
                    ? `SELECT COUNT_BIG(*) AS n FROM (SELECT TOP (${SEARCH_COUNT_CAP + 1}) 1 AS x FROM ${table} ${where}) matches`
                    : `SELECT COUNT_BIG(*) AS n FROM ${table}`, values);
                total = Number(counted.recordset[0]?.n ?? 0);
            }
            let totalIsEstimate = useEstimate;
            if (search && total > SEARCH_COUNT_CAP) {
                total = SEARCH_COUNT_CAP;
                totalIsEstimate = true;
            }
            const rows = page.recordset;
            return { rows, total, totalIsEstimate, offset, hasMore: offset + rows.length < total || (totalIsEstimate && rows.length === limit) };
        },

        lookup: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const { recordset } = await run(pool, `SELECT TOP (1) * FROM ${qualified(args.schema, args.table)} WHERE ${q(args.column)} = @p1`, [args.value]);
            return { row: recordset[0] || null };
        },

        update: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const types = await mssql();
            const tx = new types.Transaction(pool);
            await tx.begin();
            const results: Array<{ success: boolean; column: string; error: string; rowsAffected?: undefined } | { success: boolean; column: string; rowsAffected: number | null; error?: undefined }> = [];
            try {
                const table = qualified(args.schema, args.table);
                for (const change of args.changes) {
                    const values: unknown[] = [change.newValue];
                    let where = '';
                    if (change.rowId !== undefined && change.rowId !== null && change.primaryKeyColumn) {
                        values.push(change.rowId);
                        where = `${q(change.primaryKeyColumn)} = @p2`;
                    } else if (change.rowData) {
                        where = Object.entries(change.rowData)
                            .filter(([key]) => key !== change.column)
                            .map(([key, value]) => {
                                if (value === null) return `${q(key)} IS NULL`;
                                values.push(value);
                                return `${q(key)} = @p${values.length}`;
                            }).join(' AND ') || '1 = 1';
                    } else {
                        results.push({ success: false, column: change.column, error: 'No row identifier provided' });
                        continue;
                    }
                    try {
                        // Without a key, one matching row only
                        const done = await run(tx, `UPDATE ${change.primaryKeyColumn ? '' : 'TOP (1) '}${table} SET ${q(change.column)} = @p1 WHERE ${where}`, values);
                        results.push({ success: true, column: change.column, rowsAffected: done.rowsAffected[0] ?? null });
                    } catch (error) {
                        results.push({ success: false, column: change.column, error: getErrorMessage(error) });
                        // Some errors end the transaction on SQL Server: nothing more can run in it
                        if (await transactionState(tx) !== 1) break;
                    }
                }
                const success = results.length === args.changes.length && results.every(r => r.success);
                if (success) await tx.commit();
                else await tx.rollback().catch(() => {});
                return { success, results };
            } catch (error) {
                await tx.rollback().catch(() => {});
                throw new Error(`Failed to update table data: ${getErrorMessage(error)}`);
            }
        },

        remove: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            try {
                const done = await run(pool, `DELETE FROM ${qualified(args.schema, args.table)} WHERE ${q(args.primaryKeyColumn)} = @p1`, [args.rowId]);
                return { success: true, rowsAffected: done.rowsAffected[0] ?? 0 };
            } catch (error) {
                throw new Error(`Failed to delete row: ${getErrorMessage(error)}`);
            }
        },

        insert: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const table = qualified(args.schema, args.table);
            const columns = Object.keys(args.rowData);
            const values = Object.values(args.rowData);
            const into = columns.length ? `(${columns.map(q).join(', ')})` : '';
            const valuesSql = columns.length ? `VALUES (${columns.map((_, i) => `@p${i + 1}`).join(', ')})` : 'DEFAULT VALUES';
            try {
                try {
                    const done = await run(pool, `INSERT INTO ${table} ${into} OUTPUT INSERTED.* ${valuesSql}`, values);
                    return { success: true, row: done.recordset[0] ?? args.rowData };
                } catch (error) {
                    // A table with triggers refuses OUTPUT without INTO: insert, then read the row back by its new id
                    if (!/OUTPUT clause|trigger/i.test(getErrorMessage(error))) throw error;
                    const done = await run(pool, `INSERT INTO ${table} ${into} ${valuesSql}; SELECT SCOPE_IDENTITY() AS id`, values);
                    const keys = await primaryKeyColumns(pool, args.schema, args.table);
                    const id = done.recordsets.at(-1)?.[0]?.id;
                    if (keys.length === 1 && id !== null && id !== undefined && args.rowData[keys[0]] === undefined) {
                        const back = await run(pool, `SELECT * FROM ${table} WHERE ${q(keys[0])} = @p1`, [String(id)]);
                        return { success: true, row: back.recordset[0] ?? args.rowData };
                    }
                    return { success: true, row: args.rowData };
                }
            } catch (error) {
                throw new Error(`Failed to insert row: ${getErrorMessage(error)}`);
            }
        },
    },

    query: {
        run: async (dbId, args) => runReadOnly(await saved(dbId), args),

        /** The SQL editor's changes: in a transaction, committed when the statement worked */
        runMutation: async (dbId, args) => {
            const pool = await poolFor(await saved(dbId));
            const types = await mssql();
            const maxRows = Math.max(1, Number(args.maxRows) || 5000);
            const timeoutMs = clampTimeout(args.timeoutMs);
            const tx = new types.Transaction(pool);
            await tx.begin();
            const request = new types.Request(tx);
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; request.cancel(); }, timeoutMs);
            try {
                const start = Date.now();
                const result = await request.query(args.sql);
                const duration = Date.now() - start;
                await tx.commit();
                const rows = (result.recordset ?? []) as Row[];
                return {
                    rows: rows.slice(0, maxRows),
                    fields: rows.length ? Object.keys(rows[0]) : Object.keys(result.recordset?.columns ?? {}),
                    rowCount: rows.length || (result.rowsAffected ?? []).reduce((sum, n) => sum + n, 0),
                    truncated: rows.length > maxRows,
                    duration,
                    command: statementKind(args.sql, 'tsql'),
                };
            } catch (error) {
                await tx.rollback().catch(() => {});
                throw timedOut ? stopped(timeoutMs) : new Error(getErrorMessage(error));
            } finally {
                clearTimeout(timer);
            }
        },
    },

    backup: {
        /** bbdump's own backup: the catalog and the rows as gzipped JSON lines, then read back to its end */
        dump: async db => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, db.name);
                return { success: false, database: db.name, timestamp, error };
            };
            const target = targetOf(db);
            let pool: ConnectionPool;
            try {
                pool = await poolFor(target);
            } catch (error) {
                return fail(getErrorMessage(error));
            }
            const prepared = await backupManager.prepareBackupFile(db, timestamp, () => databaseSize(target).catch(() => null));
            if ('failure' in prepared) return prepared.failure;
            const gzip = zlib.createGzip({ level: 6 });
            const file = fs.createWriteStream(prepared.file);
            const finished = new Promise<void>((resolve, reject) => {
                file.on('finish', () => resolve());
                file.on('error', reject);
                gzip.on('error', reject);
            });
            gzip.pipe(file);
            const write = (line: Line) => new Promise<void>((resolve, reject) => {
                if (gzip.write(`${JSON.stringify(line)}\n`, error => { if (error) reject(error); })) resolve();
                else gzip.once('drain', () => resolve());
            });
            try {
                const summary = await writeBackup(pool, write, db.name);
                gzip.end();
                await finished;
                logger.info(`SQL Server backup: ${summary.tables} table(s), ${summary.rows} row(s)${summary.snapshot ? '' : ' (not one snapshot: the database does not allow snapshot isolation)'}`, db.name);
                for (const item of summary.skipped) logger.warn(`Not in the backup: ${item}`, db.name);
            } catch (error) {
                gzip.destroy();
                file.destroy();
                try { fs.rmSync(prepared.file, { force: true }); } catch { /* nothing written */ }
                return fail(`SQL Server backup failed: ${getErrorMessage(error)}`);
            }
            return backupManager.finishDump(db, { file: prepared.file, timestamp, verify: copy => verifySqlServerBackup(copy) });
        },
    },

    restore: {
        /**
         * Replaces the content of the target with the backup's, in one transaction: its objects
         * are removed (unless `replace: false`), then the backup is replayed; any error rolls it
         * all back. The backup is read to its end first.
         */
        restore: async (backupFile, target, options = {}) => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, target.name);
                return { success: false, database: target.name, timestamp, error };
            };
            const opened = await backupManager.openBackupForRestore(backupFile, target.name, 'sqlserver', timestamp);
            if ('failure' in opened) return opened.failure;
            try {
                const checked = await verifySqlServerBackup(opened.file);
                if (!checked.valid) return fail(`This backup cannot be restored: ${checked.error}. Nothing was changed`);
                const pool = await poolFor(targetOf(target));
                const types = await mssql();
                const tx = new types.Transaction(pool);
                await tx.begin();
                try {
                    if (options.replace !== false) {
                        const removed = await emptyDatabase(tx);
                        logger.info(`[restore] ${removed} object(s) of ${target.name} removed before loading the backup`, target.name);
                    }
                    const done = await replayBackup(tx, opened.file);
                    await tx.commit();
                    for (const item of done.skipped) logger.warn(`Not in the backup: ${item}`, target.name);
                    const message = `Restore successful from ${backupFile} to ${target.name} (${done.tables} table(s), ${done.rows} row(s), ${done.modules} view(s), function(s), procedure(s) and trigger(s))`;
                    logger.info(message, target.name);
                    return { success: true, database: target.name, timestamp, message };
                } catch (error) {
                    await tx.rollback().catch(() => {});
                    return fail(`Restore failed, nothing was changed: ${friendly(error)}`);
                }
            } catch (error) {
                return fail(`Restore failed: ${friendly(error)}`);
            } finally {
                opened.cleanup();
            }
        },
    },
};

/** Runs `fn` with queries on a saved SQL Server database (restore into a new database uses it) */
export async function withSavedSqlServer<T>(dbId: string, fn: (query: (sql: string, values?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
    const pool = await poolFor(await saved(dbId));
    return fn(async (sql, values = []) => (await run(pool, sql, values)).recordset);
}

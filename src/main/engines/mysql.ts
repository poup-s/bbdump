/**
 * MySQL and MariaDB: one driver (mysql2, loaded on first use), two manifests. The explorer's
 * facets return the shapes of dbViewer.ts (PostgreSQL), so the table explorer, the SQL editor
 * and dashboards work as they are. A saved database is one MySQL database ("schema").
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Writable } from 'stream';
import type { Pool, PoolConnection, RowDataPacket, FieldPacket, ResultSetHeader } from 'mysql2/promise';
import { connectionParamsFor } from '../savedConnection';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { sqlDumpHeader } from '../backupFormat';
import { requireMysqlTool, mysqlToolInfo, type MysqlFlavour } from '../tools/mysqlTools';
import { MARIADB, MYSQL } from '../../shared/engines/manifests';
import { mysqlConnection, mysqlIdent as q, type MysqlConnection, type MysqlTarget } from '../../shared/engines/mysqlUri';
import { readOnlyProblem, statementCount, statementKind } from '../../shared/engines/sqlGuard';
import type { BackupResult } from '../../types/config';
import type { EngineDriver } from './driver';

// --- Connections ---------------------------------------------------------------------------------

type Mysql2 = typeof import('mysql2/promise');
let mysql2: Mysql2 | null = null;
async function driver(): Promise<Mysql2> {
    if (!mysql2) mysql2 = await import('mysql2/promise');
    return mysql2;
}

interface PoolEntry { pool: Pool; lastUse: number; mariadb?: boolean }
const pools = new Map<string, PoolEntry>();
const POOL_IDLE_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
    for (const [key, entry] of pools) {
        if (Date.now() - entry.lastUse > POOL_IDLE_MS) {
            pools.delete(key);
            entry.pool.end().catch(() => {});
        }
    }
}, 60 * 1000);
cleanupTimer.unref?.();

export async function closeMysqlPools(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map(entry => entry.pool.end().catch(() => {})));
}

function tlsOptions(conn: MysqlConnection) {
    if (!conn.tls) return undefined;
    const ca = conn.tls.caFile ? fs.readFileSync(conn.tls.caFile) : undefined;
    return {
        ca,
        rejectUnauthorized: conn.tls.verifyServer,
        ...(conn.tls.verifyName ? {} : { checkServerIdentity: () => undefined }),
    };
}

const poolKey = (conn: MysqlConnection) => `${conn.user}@${conn.label}/${conn.database}#${JSON.stringify(conn.tls ?? null)}`;

async function poolFor(target: MysqlTarget): Promise<PoolEntry> {
    const conn = mysqlConnection(target);
    const key = poolKey(conn);
    const found = pools.get(key);
    if (found) {
        found.lastUse = Date.now();
        return found;
    }
    const { createPool } = await driver();
    const pool = createPool({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database || undefined,
        ssl: tlsOptions(conn),
        connectionLimit: 5,
        connectTimeout: 10000,
        // Dates as written (no time zone shift when a cell is edited and saved back)
        dateStrings: true,
        supportBigNumbers: true,
        charset: 'utf8mb4',
        // BOOLEAN is TINYINT(1): read it as a boolean
        typeCast: (field, next) => {
            if (field.type === 'TINY' && field.length === 1) {
                const value = field.string();
                return value === null ? null : value === '1';
            }
            return next();
        },
    });
    const entry: PoolEntry = { pool, lastUse: Date.now() };
    pools.set(key, entry);
    return entry;
}

/** Runs `fn` with a pooled connection, always released */
async function withConnection<T>(target: MysqlTarget, fn: (conn: PoolConnection, entry: PoolEntry) => Promise<T>): Promise<T> {
    const entry = await poolFor(target);
    let conn: PoolConnection;
    try {
        conn = await entry.pool.getConnection();
    } catch (error) {
        // A wrong password or an unreachable server: never keep that pool
        pools.delete(poolKey(mysqlConnection(target)));
        entry.pool.end().catch(() => {});
        throw error;
    }
    try {
        return await fn(conn, entry);
    } finally {
        conn.release();
    }
}

async function isMariaDb(conn: PoolConnection, entry: PoolEntry): Promise<boolean> {
    if (entry.mariadb === undefined) {
        const [rows] = await conn.query<RowDataPacket[]>('SELECT VERSION() AS v');
        entry.mariadb = /mariadb/i.test(String(rows[0]?.v ?? ''));
    }
    return entry.mariadb;
}

/** A saved database, reached (password decrypted, SSH tunnel open) */
async function saved(dbId: string): Promise<MysqlTarget> {
    const params = await connectionParamsFor(dbId);
    return { ...params, sslMode: params.sslMode as MysqlTarget['sslMode'] };
}

/** Values bound to a statement: objects and arrays (JSON columns) as JSON text */
function bindable(value: unknown): unknown {
    if (value === undefined) return null;
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        return JSON.stringify(value);
    }
    return value;
}

// --- Catalog -------------------------------------------------------------------------------------

/** Below this size, a table's row count is exact (InnoDB's own count is an estimate) */
const EXACT_COUNT_MAX_BYTES = 8 * 1024 * 1024;
const EXACT_COUNT_MAX_ROWS = 1_000_000;
const SEARCH_COUNT_CAP = 10_000;

interface ColumnRow extends RowDataPacket {
    column_name: string; data_type: string; column_type: string; is_nullable: string; column_default: string | null;
    character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null; extra: string; column_key: string;
}

interface ForeignKeyRow extends RowDataPacket {
    constraint_name: string; source_schema: string; source_table: string; source_column: string;
    target_schema: string; target_table: string; target_column: string;
}

const FOREIGN_KEYS_SQL = `
    SELECT CONSTRAINT_NAME AS constraint_name, TABLE_SCHEMA AS source_schema, TABLE_NAME AS source_table,
           COLUMN_NAME AS source_column, REFERENCED_TABLE_SCHEMA AS target_schema,
           REFERENCED_TABLE_NAME AS target_table, REFERENCED_COLUMN_NAME AS target_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE REFERENCED_TABLE_NAME IS NOT NULL`;

async function columnsOf(conn: PoolConnection, database: string, table: string): Promise<ColumnRow[]> {
    const [rows] = await conn.query<ColumnRow[]>(`
        SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
               IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
               CHARACTER_MAXIMUM_LENGTH AS character_maximum_length, NUMERIC_PRECISION AS numeric_precision,
               NUMERIC_SCALE AS numeric_scale, EXTRA AS extra, COLUMN_KEY AS column_key
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`, [database, table]);
    return rows;
}

/** information_schema of MySQL, in the shape of PostgreSQL's (what the explorer reads) */
export function describeMysqlColumn(col: { column_name: string; data_type: string; column_type?: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null; extra?: string }) {
    const extra = String(col.extra ?? '').toLowerCase();
    const type = String(col.column_type ?? col.data_type).toLowerCase();
    const isBool = /^tinyint\(1\)/.test(type);
    return {
        column_name: col.column_name,
        data_type: type,
        udt_schema: null,
        udt_name: isBool ? 'bool' : String(col.data_type).toLowerCase(),
        is_nullable: col.is_nullable,
        column_default: col.column_default,
        character_maximum_length: col.character_maximum_length,
        numeric_precision: col.numeric_precision,
        numeric_scale: col.numeric_scale,
        is_identity: extra.includes('auto_increment') ? 'YES' : 'NO',
        identity_generation: extra.includes('auto_increment') ? 'BY DEFAULT' : null,
        // "VIRTUAL GENERATED" / "STORED GENERATED" (MySQL), "VIRTUAL" / "PERSISTENT" (MariaDB); not DEFAULT_GENERATED
        is_generated: /\b(virtual|stored|persistent)\b/.test(extra) ? 'ALWAYS' : 'NEVER',
    };
}

async function foreignKeys(conn: PoolConnection, database: string, table?: string): Promise<ForeignKeyRow[]> {
    const [rows] = await conn.query<ForeignKeyRow[]>(
        `${FOREIGN_KEYS_SQL} AND TABLE_SCHEMA = ?${table ? ' AND TABLE_NAME = ?' : ''} ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        table ? [database, table] : [database],
    );
    return rows;
}

async function primaryKeyColumns(conn: PoolConnection, database: string, table: string): Promise<string[]> {
    const [rows] = await conn.query<RowDataPacket[]>(`
        SELECT COLUMN_NAME AS column_name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`, [database, table]);
    return rows.map(r => r.column_name as string);
}

// --- Read-only queries ---------------------------------------------------------------------------

/** Column types as PostgreSQL OIDs where dashboards need them: bigint (20) and decimal (1700) come as text */
function typeIds(fields: FieldPacket[] | undefined): number[] {
    return (fields ?? []).map(f => (f.columnType === 246 || f.columnType === 0 ? 1700 : f.columnType === 8 ? 20 : 0));
}

async function setStatementTimeout(conn: PoolConnection, entry: PoolEntry, timeoutMs: number): Promise<void> {
    if (await isMariaDb(conn, entry)) await conn.query(`SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(3)}`);
    // MySQL: SELECT statements only (the others are refused before, or run in the editor's own transaction)
    else await conn.query(`SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`);
}

async function resetStatementTimeout(conn: PoolConnection, entry: PoolEntry): Promise<void> {
    if (await isMariaDb(conn, entry)) await conn.query('SET SESSION max_statement_time = 0').catch(() => {});
    else await conn.query('SET SESSION max_execution_time = 0').catch(() => {});
}

const clampTimeout = (ms: unknown) => Math.max(100, Math.min(600000, Math.floor(Number(ms) || 60000)));

/** One reading statement in a READ ONLY transaction (DDL is refused before: MySQL would commit it) */
export async function runReadOnly(target: MysqlTarget, args: { sql: string; maxRows?: number; timeoutMs?: number; values?: unknown[] }) {
    const problem = readOnlyProblem(args.sql, 'mysql');
    if (problem) throw new Error(problem);
    const maxRows = args.maxRows || 5000;
    return withConnection(target, async (conn, entry) => {
        await setStatementTimeout(conn, entry, clampTimeout(args.timeoutMs));
        await conn.query('START TRANSACTION READ ONLY');
        try {
            const start = Date.now();
            const [result, fields] = await conn.query({ sql: args.sql, values: (args.values ?? []).map(bindable) });
            const duration = Date.now() - start;
            await conn.query('COMMIT');
            const all = Array.isArray(result) ? result as RowDataPacket[] : [];
            const truncated = all.length > maxRows;
            return {
                rows: truncated ? all.slice(0, maxRows) : all,
                fields: (fields ?? []).map(f => f.name),
                types: typeIds(fields),
                rowCount: all.length,
                truncated,
                duration,
            };
        } catch (error) {
            await conn.query('ROLLBACK').catch(() => {});
            throw new Error(getErrorMessage(error));
        } finally {
            await resetStatementTimeout(conn, entry);
        }
    });
}

// --- Backups -------------------------------------------------------------------------------------

/** The connection in an option file only this user can read: never on a command line */
export function mysqlOptionFileText(conn: MysqlConnection, toolFlavour: MysqlFlavour): string {
    const value = (text: string) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    // TCP always: a host named localhost would be the Unix socket otherwise
    const lines = ['[client]', `user=${value(conn.user)}`, `password=${value(conn.password)}`, `host=${value(conn.host)}`, `port=${conn.port}`, 'protocol=TCP'];
    // Each vendor's tools have their own TLS options
    if (toolFlavour === 'mysql') {
        if (!conn.tls) lines.push('ssl-mode=DISABLED');
        else lines.push(`ssl-mode=${conn.tls.verifyName ? 'VERIFY_IDENTITY' : conn.tls.verifyServer ? 'VERIFY_CA' : 'REQUIRED'}`);
    } else if (!conn.tls) {
        lines.push('skip-ssl');
    } else {
        lines.push('ssl', conn.tls.verifyServer ? 'ssl-verify-server-cert' : 'skip-ssl-verify-server-cert');
    }
    if (conn.tls?.caFile) lines.push(`ssl-ca=${value(conn.tls.caFile)}`);
    return `${lines.join('\n')}\n`;
}

function optionFile(conn: MysqlConnection, toolFlavour: MysqlFlavour): { file: string; remove: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-mysql-'));
    const file = path.join(dir, 'client.cnf');
    fs.writeFileSync(file, mysqlOptionFileText(conn, toolFlavour), { mode: 0o600 });
    return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Reads a whole dump (gzip stream): its first line is bbdump's for this engine, and it ends with
 * the tool's "Dump completed" line (a dump cut short has none).
 */
export async function verifyMysqlDump(file: string, engine: MysqlFlavour): Promise<{ valid: boolean; error?: string }> {
    let head = '';
    let tail = '';
    try {
        // Read to the decompressed end: a cut archive fails there ("unexpected end of file"),
        // after the compressed input is consumed, so the reading side must be part of the pipeline
        const sink = new Writable({
            write(chunk: Buffer, _encoding, done) {
                if (head.length < 200) head += chunk.toString('utf8', 0, Math.min(chunk.length, 200));
                tail = (tail + chunk.toString('utf8')).slice(-400);
                done();
            },
        });
        await pipeline(fs.createReadStream(file), zlib.createGunzip(), sink);
    } catch (error) {
        return { valid: false, error: `the archive cannot be read to its end (${getErrorMessage(error)})` };
    }
    if (!head.startsWith(sqlDumpHeader(engine))) return { valid: false, error: `not a ${engine === 'mariadb' ? 'MariaDB' : 'MySQL'} backup made by bbdump` };
    if (!/-- Dump completed/.test(tail)) return { valid: false, error: 'the dump is incomplete (it does not end with "Dump completed")' };
    return { valid: true };
}

/** Runs a client with a stream on its standard input; the end of stderr kept for the message */
function runClient(command: string, args: string[], input: NodeJS.ReadableStream, timeoutMs: number): Promise<{ code: number; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(command, args, { windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-64 * 1024); });
        child.stdout.on('data', () => { /* nothing expected */ });
        child.stdin.on('error', () => { /* the client stopped reading: its exit code says why */ });
        input.on('error', (error: Error) => { stderr += `\n${error.message}`; child.kill('SIGTERM'); });
        input.pipe(child.stdin);
        child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stderr: error.message }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }); });
    });
}

const RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const lastLines = (text: string, count = 6) => text.trim().split(/\r?\n/).filter(line => !/Using a password/i.test(line)).slice(-count).join('\n');

function targetOf(db: { name: string; host: string; port: number; user: string; password?: string; connectionString?: string; sslMode?: string; sslRootCert?: string; viaTunnel?: boolean }): MysqlTarget {
    return {
        connectionString: db.connectionString,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.name,
        sslMode: db.sslMode as MysqlTarget['sslMode'],
        sslRootCert: db.sslRootCert,
        viaTunnel: db.viaTunnel,
    };
}

async function databaseSize(target: MysqlTarget): Promise<number | null> {
    return withConnection(target, async conn => {
        const [rows] = await conn.query<RowDataPacket[]>(
            'SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS size FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
        const size = Number(rows[0]?.size);
        return Number.isFinite(size) ? size : null;
    });
}

/**
 * Arguments of the dump tool: one consistent snapshot (InnoDB), routines and triggers, binary
 * data as hex. A tool of the other vendor gets what it needs to dump this server.
 */
export function mysqlDumpArgs(optionFilePath: string, database: string, toolFlavour: MysqlFlavour, serverEngine: MysqlFlavour): string[] {
    const args = [
        // Must come first
        `--defaults-extra-file=${optionFilePath}`,
        '--single-transaction',
        '--quick',
        '--routines',
        '--triggers',
        '--hex-blob',
        '--no-tablespaces',
        '--default-character-set=utf8mb4',
    ];
    if (toolFlavour === 'mysql') {
        // No GTID statements in the dump (they break a restore elsewhere)
        args.push('--set-gtid-purged=OFF');
        // MySQL 8's mysqldump queries column statistics MariaDB does not have
        if (serverEngine === 'mariadb') args.push('--column-statistics=0');
    }
    args.push(database);
    return args;
}

// --- The driver ----------------------------------------------------------------------------------

function makeDriver(engine: MysqlFlavour): EngineDriver {
    const manifest = engine === 'mariadb' ? MARIADB : MYSQL;

    return {
        manifest,

        connection: {
            test: async input => {
                const conn = mysqlConnection(targetOf({ ...input, name: input.database }));
                logger.info(`${manifest.label} connection test: ${conn.label}`);
                const { createConnection } = await driver();
                const client = await createConnection({
                    host: conn.host, port: conn.port, user: conn.user, password: conn.password,
                    database: conn.database || undefined, ssl: tlsOptions(conn), connectTimeout: 10000,
                });
                try {
                    const [rows] = await client.query<RowDataPacket[]>(`
                        SELECT VERSION() AS version,
                               (SELECT COUNT(*) FROM information_schema.TABLES
                                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS tables`);
                    const version = String(rows[0]?.version ?? '');
                    // A MariaDB server saved as MySQL (or the other way round) works; the test says which it is
                    const isMariaDb = /mariadb/i.test(version);
                    const other = isMariaDb !== (engine === 'mariadb') ? ` (${isMariaDb ? 'MariaDB' : 'MySQL'})` : '';
                    return { version: version.split('-')[0] + other, tables: Number(rows[0]?.tables ?? 0) };
                } finally {
                    await client.end().catch(() => {});
                }
            },
        },

        stats: {
            size: async dbId => databaseSize(await saved(dbId)),
        },

        catalog: {
            listNamespaces: async dbId => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [rows] = await conn.query<RowDataPacket[]>(
                        "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
                    return { schemas: [{ name: target.database, table_count: Number(rows[0]?.n ?? 0) }] };
                });
            },

            listEntities: async dbId => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [rows] = await conn.query<RowDataPacket[]>(`
                        SELECT TABLE_NAME AS name, TABLE_ROWS AS estimate, DATA_LENGTH AS size
                        FROM information_schema.TABLES
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
                        ORDER BY TABLE_NAME`);
                    const tables = rows.map(r => ({
                        name: String(r.name),
                        row_count: r.estimate === null ? null : Number(r.estimate),
                        row_count_estimated: true,
                    }));
                    // Exact counts for small tables (InnoDB's estimate can be far off, or 0)
                    const small = rows.filter(r => Number(r.size ?? 0) <= EXACT_COUNT_MAX_BYTES).map(r => String(r.name));
                    if (small.length) {
                        const [counts] = await conn.query<RowDataPacket[]>(
                            small.map(name => `SELECT ${conn.escape(name)} AS name, COUNT(*) AS n FROM ${q(name)}`).join(' UNION ALL '));
                        const exact = new Map(counts.map(c => [String(c.name), Number(c.n)]));
                        for (const table of tables) {
                            if (exact.has(table.name)) {
                                table.row_count = exact.get(table.name) ?? 0;
                                table.row_count_estimated = false;
                            }
                        }
                    }
                    return { schema: target.database, tables };
                });
            },

            describeEntity: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [columns, keys, uniques, fks] = await Promise.all([
                        columnsOf(conn, target.database, args.table),
                        primaryKeyColumns(conn, target.database, args.table),
                        conn.query<RowDataPacket[]>(`
                            SELECT INDEX_NAME AS index_name, MIN(COLUMN_NAME) AS column_name, COUNT(*) AS n
                            FROM information_schema.STATISTICS
                            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
                            GROUP BY INDEX_NAME`, [target.database, args.table]).then(([rows]) => rows),
                        foreignKeys(conn, target.database, args.table),
                    ]);
                    const unique = new Set(uniques.filter(u => Number(u.n) === 1).map(u => String(u.column_name)));
                    return {
                        schema: target.database,
                        columns: columns.map(col => {
                            const fk = fks.find(f => f.source_column === col.column_name);
                            return {
                                ...describeMysqlColumn(col),
                                is_primary: keys.includes(col.column_name),
                                is_unique: unique.has(col.column_name),
                                is_foreign: !!fk,
                                foreign_key: fk ? { schema: fk.target_schema, table: fk.target_table, column: fk.target_column } : null,
                            };
                        }),
                    };
                });
            },

            entityRelations: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => ({
                    relations: (await foreignKeys(conn, target.database, args.table)).map(fk => ({
                        constraint_name: fk.constraint_name,
                        column_name: fk.source_column,
                        foreign_table_schema: fk.target_schema,
                        foreign_table_name: fk.target_table,
                        foreign_column_name: fk.target_column,
                    })),
                }));
            },

            fullSchema: async dbId => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [[tables], [columns], [keys], fks] = await Promise.all([
                        conn.query<RowDataPacket[]>(`
                            SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name FROM information_schema.TABLES
                            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`),
                        conn.query<RowDataPacket[]>(`
                            SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
                                   LOWER(c.COLUMN_TYPE) AS data_type, c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default
                            FROM information_schema.COLUMNS c
                            JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
                            WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
                            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`),
                        conn.query<RowDataPacket[]>(`
                            SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, COLUMN_NAME AS column_name
                            FROM information_schema.STATISTICS
                            WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY'`),
                        foreignKeys(conn, target.database),
                    ]);
                    return {
                        schema: target.database,
                        tables: tables as Array<{ schema: string; name: string }>,
                        columns: columns as Array<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>,
                        primaryKeys: keys as Array<{ table_schema: string; table_name: string; column_name: string }>,
                        foreignKeys: fks,
                    };
                });
            },

            // ENUM columns list their values in their type: enum('a','b')
            enumValues: async (_dbId, args) => {
                const match = String(args.typeName).match(/^enum\((.*)\)$/i);
                if (!match) return { values: [] };
                return { values: [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'")) };
            },
        },

        records: {
            count: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${q(args.table)}`);
                    return { count: Number(rows[0]?.n ?? 0) };
                });
            },

            page: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const offset = Math.max(0, Number(args.offset) || 0);
                    const limit = Math.max(1, Math.min(10000, Number(args.limit) || 50));
                    const order = args.sortBy ? `ORDER BY ${q(args.sortBy)} ${args.sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}` : '';
                    const search = args.search?.trim();
                    let where = '';
                    const values: unknown[] = [];
                    if (search) {
                        const columns = await columnsOf(conn, target.database, args.table);
                        // The connection's collation: case-insensitive for the usual ones
                        where = `WHERE ${columns.map(c => `CAST(${q(c.column_name)} AS CHAR) LIKE ?`).join(' OR ')}`;
                        for (let i = 0; i < columns.length; i++) values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
                    }
                    const [estimateRows] = await conn.query<RowDataPacket[]>(
                        'SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [args.table]);
                    const estimate = Number(estimateRows[0]?.n ?? 0);
                    const useEstimate = !search && estimate > EXACT_COUNT_MAX_ROWS;
                    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${q(args.table)} ${where} ${order} LIMIT ? OFFSET ?`, [...values, limit, offset]);
                    let total = estimate;
                    if (!useEstimate) {
                        const [countRows] = await conn.query<RowDataPacket[]>(
                            search ? `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q(args.table)} ${where} LIMIT ${SEARCH_COUNT_CAP + 1}) matches` : `SELECT COUNT(*) AS n FROM ${q(args.table)}`,
                            values);
                        total = Number(countRows[0]?.n ?? 0);
                    }
                    let totalIsEstimate = useEstimate;
                    if (search && total > SEARCH_COUNT_CAP) {
                        total = SEARCH_COUNT_CAP;
                        totalIsEstimate = true;
                    }
                    return {
                        rows,
                        total,
                        totalIsEstimate,
                        offset,
                        hasMore: offset + rows.length < total || (totalIsEstimate && rows.length === limit),
                    };
                });
            },

            lookup: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${q(args.table)} WHERE ${q(args.column)} = ? LIMIT 1`, [bindable(args.value)]);
                    return { row: rows[0] || null };
                });
            },

            update: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    await conn.beginTransaction();
                    const results: Array<{ success: boolean; column: string; error: string; rowsAffected?: undefined } | { success: boolean; column: string; rowsAffected: number | null; error?: undefined }> = [];
                    try {
                        for (const change of args.changes) {
                            let where = '';
                            const whereValues: unknown[] = [];
                            if (change.rowId !== undefined && change.rowId !== null && change.primaryKeyColumn) {
                                where = `${q(change.primaryKeyColumn)} = ?`;
                                whereValues.push(bindable(change.rowId));
                            } else if (change.rowData) {
                                where = Object.entries(change.rowData)
                                    .filter(([key]) => key !== change.column)
                                    .map(([key, value]) => {
                                        if (value === null) return `${q(key)} IS NULL`;
                                        whereValues.push(bindable(value));
                                        return `${q(key)} = ?`;
                                    }).join(' AND ');
                            } else {
                                results.push({ success: false, column: change.column, error: 'No row identifier provided' });
                                continue;
                            }
                            try {
                                // Without a key, one matching row only
                                const [result] = await conn.query<ResultSetHeader>(
                                    `UPDATE ${q(args.table)} SET ${q(change.column)} = ? WHERE ${where}${change.primaryKeyColumn ? '' : ' LIMIT 1'}`,
                                    [bindable(change.newValue), ...whereValues]);
                                results.push({ success: true, column: change.column, rowsAffected: result.affectedRows });
                            } catch (error) {
                                results.push({ success: false, column: change.column, error: getErrorMessage(error) });
                            }
                        }
                        const success = results.every(r => r.success);
                        if (success) await conn.commit();
                        else await conn.rollback();
                        return { success, results };
                    } catch (error) {
                        await conn.rollback().catch(() => {});
                        throw new Error(`Failed to update table data: ${getErrorMessage(error)}`);
                    }
                });
            },

            remove: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    try {
                        const [result] = await conn.query<ResultSetHeader>(`DELETE FROM ${q(args.table)} WHERE ${q(args.primaryKeyColumn)} = ?`, [bindable(args.rowId)]);
                        return { success: true, rowsAffected: result.affectedRows };
                    } catch (error) {
                        throw new Error(`Failed to delete row: ${getErrorMessage(error)}`);
                    }
                });
            },

            insert: async (dbId, args) => {
                const target = await saved(dbId);
                return withConnection(target, async conn => {
                    try {
                        const columns = Object.keys(args.rowData);
                        const [result] = await conn.query<ResultSetHeader>(
                            columns.length
                                ? `INSERT INTO ${q(args.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
                                : `INSERT INTO ${q(args.table)} () VALUES ()`,
                            Object.values(args.rowData).map(bindable));
                        // No RETURNING: read the row back by its key (the new auto-increment id, or the values given)
                        const keys = await primaryKeyColumns(conn, target.database, args.table);
                        let row: RowDataPacket | undefined;
                        if (keys.length === 1 && result.insertId && args.rowData[keys[0]] === undefined) {
                            [[row]] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${q(args.table)} WHERE ${q(keys[0])} = ?`, [result.insertId]);
                        } else if (keys.length && keys.every(k => args.rowData[k] !== undefined)) {
                            [[row]] = await conn.query<RowDataPacket[]>(
                                `SELECT * FROM ${q(args.table)} WHERE ${keys.map(k => `${q(k)} = ?`).join(' AND ')}`, keys.map(k => bindable(args.rowData[k])));
                        }
                        return { success: true, row: row ?? args.rowData };
                    } catch (error) {
                        throw new Error(`Failed to insert row: ${getErrorMessage(error)}`);
                    }
                });
            },
        },

        query: {
            run: async (dbId, args) => runReadOnly(await saved(dbId), args),

            runMutation: async (dbId, args) => {
                if (statementCount(args.sql, 'mysql') > 1) throw new Error('Run one statement at a time');
                const target = await saved(dbId);
                const maxRows = args.maxRows || 5000;
                return withConnection(target, async (conn, entry) => {
                    await setStatementTimeout(conn, entry, clampTimeout(args.timeoutMs));
                    // DDL commits on its own in MySQL; data changes are in this transaction
                    await conn.beginTransaction();
                    try {
                        const start = Date.now();
                        const [result, fields] = await conn.query(args.sql);
                        const duration = Date.now() - start;
                        await conn.commit();
                        const rows = Array.isArray(result) ? result as RowDataPacket[] : [];
                        const header = Array.isArray(result) ? undefined : result as ResultSetHeader;
                        return {
                            rows: rows.slice(0, maxRows),
                            fields: (fields ?? []).map(f => f.name),
                            rowCount: header ? header.affectedRows : rows.length,
                            truncated: rows.length > maxRows,
                            duration,
                            command: statementKind(args.sql, 'mysql'),
                        };
                    } catch (error) {
                        await conn.rollback().catch(() => {});
                        throw new Error(getErrorMessage(error));
                    } finally {
                        await resetStatementTimeout(conn, entry);
                    }
                });
            },
        },

        backup: {
            /** One gzipped SQL dump per backup, its first line naming the engine */
            dump: async db => {
                const timestamp = new Date().toISOString();
                const fail = (error: string): BackupResult => {
                    logger.error(error, db.name);
                    return { success: false, database: db.name, timestamp, error };
                };
                const target = targetOf(db);
                let tool: string;
                let toolFlavour: MysqlFlavour;
                try {
                    tool = await requireMysqlTool('dump', engine);
                    toolFlavour = (await mysqlToolInfo(tool)).flavour;
                } catch (error) {
                    return fail(getErrorMessage(error));
                }
                const prepared = await backupManager.prepareBackupFile(db, timestamp, () => databaseSize(target).catch(() => null));
                if ('failure' in prepared) return prepared.failure;

                const conn = mysqlConnection(target);
                const options = optionFile(conn, toolFlavour);
                logger.info(`Using ${path.basename(tool)} on ${conn.label}`, db.name);
                try {
                    return await backupManager.runDumpProcess(db, {
                        command: tool,
                        label: path.basename(tool),
                        args: mysqlDumpArgs(options.file, conn.database, toolFlavour, engine),
                        env: process.env,
                        file: prepared.file,
                        timestamp,
                        stdoutTo: { header: sqlDumpHeader(engine) },
                        verify: async file => verifyMysqlDump(file, engine),
                    });
                } finally {
                    options.remove();
                }
            },
        },

        restore: {
            /**
             * Replaces the tables of the target with the backup's (they are dropped first, unless
             * `replace: false`), into the same database or another one. The archive is read to its
             * end before anything changes; there is no transaction around DDL in MySQL, hence
             * "back up first" in the dialog.
             */
            restore: async (backupFile, target, options = {}) => {
                const timestamp = new Date().toISOString();
                const fail = (error: string): BackupResult => {
                    logger.error(error, target.name);
                    return { success: false, database: target.name, timestamp, error };
                };
                let client: string;
                let toolFlavour: MysqlFlavour;
                try {
                    client = await requireMysqlTool('client', engine);
                    toolFlavour = (await mysqlToolInfo(client)).flavour;
                } catch (error) {
                    return fail(getErrorMessage(error));
                }
                const opened = await backupManager.openBackupForRestore(backupFile, target.name, engine, timestamp);
                if ('failure' in opened) return opened.failure;
                const reached = targetOf(target);
                const conn = mysqlConnection(reached);
                let optionsFile: { file: string; remove: () => void } | undefined;
                try {
                    const checked = await verifyMysqlDump(opened.file, engine);
                    if (!checked.valid) return fail(`This backup cannot be restored: ${checked.error}. Nothing was changed`);

                    if (options.replace !== false) {
                        const dropped = await withConnection(reached, async c => {
                            const [rows] = await c.query<RowDataPacket[]>(
                                'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
                            await c.query('SET FOREIGN_KEY_CHECKS = 0');
                            try {
                                for (const row of rows.filter(r => r.type === 'VIEW')) await c.query(`DROP VIEW IF EXISTS ${q(row.name)}`);
                                for (const row of rows.filter(r => r.type !== 'VIEW')) await c.query(`DROP TABLE IF EXISTS ${q(row.name)}`);
                            } finally {
                                await c.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
                            }
                            return rows.length;
                        });
                        logger.info(`[restore] ${dropped} table(s) and view(s) of ${target.name} removed before loading the backup`, target.name);
                    }

                    optionsFile = optionFile(conn, toolFlavour);
                    const args = [`--defaults-extra-file=${optionsFile.file}`, '--default-character-set=utf8mb4', conn.database];
                    logger.info(`[restore] ${path.basename(client)} into ${target.name}`, target.name);
                    const input = fs.createReadStream(opened.file).pipe(zlib.createGunzip());
                    const result = await runClient(client, args, input, RESTORE_TIMEOUT_MS);
                    if (result.code !== 0) return fail(`${path.basename(client)} failed with code ${result.code}\n${lastLines(result.stderr)}`);

                    const tables = await withConnection(reached, async c => {
                        const [rows] = await c.query<RowDataPacket[]>(
                            "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
                        return Number(rows[0]?.n ?? 0);
                    });
                    const message = `Restore successful from ${backupFile} to ${target.name} (${tables} table(s))`;
                    logger.info(message, target.name);
                    return { success: true, database: target.name, timestamp, message };
                } catch (error) {
                    return fail(`Restore failed: ${getErrorMessage(error)}`);
                } finally {
                    optionsFile?.remove();
                    opened.cleanup();
                }
            },
        },
    };
}

export const mysqlDriver = makeDriver('mysql');
export const mariadbDriver = makeDriver('mariadb');

/** Runs `fn` with a connection to a saved MySQL / MariaDB database (the AI journal's undo uses it) */
export async function withSavedMysql<T>(dbId: string, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    return withConnection(await saved(dbId), conn => fn(conn));
}

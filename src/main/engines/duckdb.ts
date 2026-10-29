/**
 * DuckDB: a database file on this computer, reached through DuckDB's own command-line tool
 * (installed by the user, like pg_dump): bbdump embeds no native module. Each call runs the tool
 * once, on stdin, with JSON out; a query that runs too long has its process killed.
 *
 * Queries written by someone (SQL editor, dashboards, the AI) run with file access turned off
 * (`enable_external_access`): a SELECT cannot read other files of this computer. Backups and
 * restores attach the backup file themselves and copy its schemas, types, sequences, tables
 * (referenced ones first), indexes, views and macros, in one transaction.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../ipc/configIpc';
import { backupManager } from '../backup';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { DUCKDB } from '../../shared/engines/manifests';
import { quoteIdent, readOnlyProblem, statementCount, statementKind } from '../../shared/engines/sqlGuard';
import { bindDuckdb, duckdbLiteral, runDuckdbTool, type DuckdbRunOptions } from '../../shared/engines/duckdbCli';
import { requireDuckdb } from '../tools/duckdbTools';
import type { BackupResult } from '../../types/config';
import type { EngineDriver } from './driver';

type Row = Record<string, unknown>;
const q = (name: string) => quoteIdent(name, 'duckdb');
const lit = duckdbLiteral;
export const DUCKDB_DEFAULT_SCHEMA = 'main';

function fileOf(dbId: string): string {
    const db = getConfig()?.databases?.find(d => d.id === dbId);
    if (!db) throw new Error(`Database with id "${dbId}" not found in configuration`);
    const file = db.duckdb?.path;
    if (!file) throw new Error('This DuckDB database has no file');
    return file;
}

export type { DuckdbRunOptions };

/**
 * One run of the tool on `file` (":memory:" for scripts that attach files themselves): the
 * script on stdin, the rows of each statement that returns some.
 */
export async function runDuckdb(file: string, script: string, options: DuckdbRunOptions = {}): Promise<Row[][]> {
    if (file !== ':memory:' && !fs.existsSync(file)) throw new Error(`The DuckDB file was not found: ${file}`);
    return runDuckdbTool(await requireDuckdb(), file, script, options);
}

/** The rows of a single reading statement */
async function rows(file: string, sql: string, values: unknown[] = []): Promise<Row[]> {
    const results = await runDuckdb(file, `${bindDuckdb(sql, values)};`, { readOnly: true });
    return results[results.length - 1] ?? [];
}

/** Strips the trailing semicolons of a statement (it is wrapped or followed by others) */
const statement = (sql: string) => sql.trim().replace(/;+\s*$/, '');

/** Kinds of statement that are queries (they can be wrapped in a SELECT … LIMIT) */
const QUERY_STARTS = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', '(', 'TABLE', 'PIVOT', 'UNPIVOT']);

function fileSize(file: string): number | null {
    try {
        let size = fs.statSync(file).size;
        try { size += fs.statSync(`${file}.wal`).size; } catch { /* no WAL file */ }
        return size;
    } catch {
        return null;
    }
}

// --- Catalog -------------------------------------------------------------------------------------

/** User schemas of the file: main (marked internal by DuckDB) and the ones created in it */
const SCHEMAS_SQL = "SELECT schema_name AS name FROM duckdb_schemas() WHERE database_name = current_database() AND (schema_name = 'main' OR NOT internal) ORDER BY schema_name = 'main' DESC, schema_name";

interface DuckColumn { column_name: string; data_type: string; is_nullable: boolean; column_default: string | null; character_maximum_length: number | null; numeric_precision: number | null; numeric_scale: number | null; column_index: number }
interface DuckConstraint { constraint_type: string; constraint_column_names: string[]; referenced_table: string | null; referenced_column_names: string[] | null; table_name: string; schema_name: string; constraint_index: number }

async function columnsOf(file: string, schema: string, table: string): Promise<DuckColumn[]> {
    return await rows(file, 'SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale, column_index FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ? AND table_name = ? ORDER BY column_index', [schema, table]) as unknown as DuckColumn[];
}

async function constraintsOf(file: string, schema: string, table?: string): Promise<DuckConstraint[]> {
    return await rows(file, `SELECT constraint_type, constraint_column_names, referenced_table, referenced_column_names, table_name, schema_name, constraint_index FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = ?${table ? ' AND table_name = ?' : ''} AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY') ORDER BY table_name, constraint_index`, table ? [schema, table] : [schema]) as unknown as DuckConstraint[];
}

/** A DuckDB column in the shape of PostgreSQL's information_schema (what the explorer reads) */
export function describeDuckdbColumn(col: DuckColumn) {
    const type = String(col.data_type || '').toLowerCase();
    const sequence = /nextval\(/i.test(String(col.column_default ?? ''));
    return {
        column_name: col.column_name,
        data_type: type,
        udt_schema: null,
        udt_name: type === 'boolean' ? 'bool' : (type.match(/^[a-z]+/)?.[0] ?? type),
        is_nullable: col.is_nullable ? 'YES' : 'NO',
        column_default: col.column_default,
        character_maximum_length: col.character_maximum_length ?? null,
        numeric_precision: col.numeric_precision ?? null,
        numeric_scale: col.numeric_scale ?? null,
        // A default from a sequence: the next number comes by itself
        is_identity: sequence ? 'YES' : 'NO',
        identity_generation: sequence ? 'BY DEFAULT' : null,
        is_generated: 'NEVER',
    };
}

const foreignKeys = (schema: string, constraints: DuckConstraint[]) => constraints
    .filter(c => c.constraint_type === 'FOREIGN KEY' && c.referenced_table)
    .flatMap(c => c.constraint_column_names.map((column, i) => ({
        constraint_name: `${c.table_name}_fk_${c.constraint_index}`,
        source_schema: schema,
        source_table: c.table_name,
        source_column: column,
        target_schema: schema,
        target_table: c.referenced_table as string,
        target_column: c.referenced_column_names?.[i] ?? column,
    })));

/** A where clause for one row: its key, else the values it has (one row only, by rowid) */
function rowWhere(table: string, change: { rowId?: unknown; primaryKeyColumn?: string; rowData?: Row; column?: string }): string | null {
    if (change.rowId !== undefined && change.rowId !== null && change.primaryKeyColumn) return `${q(change.primaryKeyColumn)} = ${lit(change.rowId)}`;
    if (change.rowData) {
        const conditions = Object.entries(change.rowData)
            .filter(([key]) => key !== change.column)
            .map(([key, value]) => (value === null ? `${q(key)} IS NULL` : `${q(key)} = ${lit(value)}`))
            .join(' AND ');
        return `rowid = (SELECT rowid FROM ${table} WHERE ${conditions || 'TRUE'} LIMIT 1)`;
    }
    return null;
}

const SEARCH_COUNT_CAP = 10_000;

// --- Backups -------------------------------------------------------------------------------------

/** The backup file opened read-only: its tables counted (a damaged file fails here) */
async function checkBackup(file: string, timeoutMs: number): Promise<{ valid: boolean; error?: string; tables?: number }> {
    try {
        const result = await runDuckdb(file, 'SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = current_database();', { readOnly: true, timeoutMs });
        return { valid: true, tables: Number(result[0]?.[0]?.n ?? 0) };
    } catch (error) {
        return { valid: false, error: getErrorMessage(error) };
    }
}

/** Tables in an order where each comes after the ones its foreign keys reference (a cycle: as listed) */
export function referencedFirst<T extends Row>(tables: T[], keys: Row[]): T[] {
    const key = (s: unknown, n: unknown) => `${String(s)}.${String(n)}`;
    const needs = keys.filter(k => k.r && k.r !== k.n).map(k => ({ from: key(k.s, k.n), to: key(k.s, k.r) }));
    const ordered: T[] = [];
    let left = tables;
    while (left.length) {
        const pending = new Set(left.map(t => key(t.s, t.n)));
        const ready = left.filter(t => !needs.some(e => e.from === key(t.s, t.n) && pending.has(e.to)));
        const next = ready.length ? ready : left;
        ordered.push(...next);
        const done = new Set(next.map(t => key(t.s, t.n)));
        left = left.filter(t => !done.has(key(t.s, t.n)));
    }
    return ordered;
}

/**
 * The statements that copy the database of `sourceFile` (attached as `from`) into the default
 * database of the session: its schemas, ENUM types, sequences (at their next value), tables
 * (referenced ones first, their rows in that order), indexes, views and macros. DuckDB's own
 * COPY FROM DATABASE fills tables in any order before 2.0, which foreign keys refuse.
 */
async function copyStatements(sourceFile: string, from: string): Promise<string[]> {
    const [schemas = [], types = [], sequences = [], tables = [], keys = [], indexes = [], views = [], macros = []] = await runDuckdb(sourceFile, [
        "SELECT schema_name AS s FROM duckdb_schemas() WHERE database_name = current_database() AND NOT internal AND schema_name <> 'main'",
        "SELECT schema_name AS s, type_name AS n, labels FROM duckdb_types() WHERE database_name = current_database() AND NOT internal AND logical_type = 'ENUM' AND labels IS NOT NULL",
        'SELECT schema_name AS s, sequence_name AS n, start_value, min_value, max_value, increment_by, cycle, last_value FROM duckdb_sequences() WHERE database_name = current_database() AND NOT temporary',
        'SELECT schema_name AS s, table_name AS n, sql FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY table_oid',
        "SELECT schema_name AS s, table_name AS n, referenced_table AS r FROM duckdb_constraints() WHERE database_name = current_database() AND constraint_type = 'FOREIGN KEY'",
        'SELECT sql FROM duckdb_indexes() WHERE database_name = current_database() AND sql IS NOT NULL',
        'SELECT sql FROM duckdb_views() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY view_oid',
        "SELECT schema_name AS s, function_name AS n, function_type AS kind, macro_definition AS body, parameters FROM duckdb_functions() WHERE database_name = current_database() AND NOT internal AND function_type IN ('macro', 'table_macro')",
    ].map(sql => `${sql};`).join('\n'), { readOnly: true });
    const name = (row: Row) => `${q(String(row.s))}.${q(String(row.n))}`;
    const ordered = referencedFirst(tables, keys);
    return [
        // A restore empties the target's schemas without removing them
        ...schemas.map(row => `CREATE SCHEMA IF NOT EXISTS ${q(String(row.s))};`),
        ...types.map(row => `CREATE TYPE ${name(row)} AS ENUM (${(row.labels as unknown[]).map(lit).join(', ')});`),
        ...sequences.map(row => {
            // Never below the next value the source would give (DuckDB 1.x and 2.x report these two
            // differently: a gap is possible, a value given twice is not)
            const start = BigInt(String(row.start_value));
            const after = row.last_value === null || row.last_value === undefined ? start : BigInt(String(row.last_value)) + BigInt(String(row.increment_by));
            const next = BigInt(String(row.increment_by)) < 0n ? (after < start ? after : start) : (after > start ? after : start);
            return `CREATE SEQUENCE ${name(row)} INCREMENT BY ${row.increment_by} MINVALUE ${row.min_value} MAXVALUE ${row.max_value} START ${next} ${row.cycle ? 'CYCLE' : 'NO CYCLE'};`;
        }),
        ...ordered.map(row => `${String(row.sql).replace(/;\s*$/, '')};`),
        ...ordered.map(row => `INSERT INTO ${name(row)} SELECT * FROM ${q(from)}.${name(row)};`),
        ...indexes.map(row => `${String(row.sql).replace(/;\s*$/, '')};`),
        ...views.map(row => `${String(row.sql).replace(/;\s*$/, '')};`),
        ...macros.map(row => `CREATE MACRO ${name(row)}(${(row.parameters as unknown[]).map(p => q(String(p))).join(', ')}) AS ${row.kind === 'table_macro' ? 'TABLE ' : ''}${row.body};`),
    ];
}

/** What a restore drops in the target first: its views, macros, tables, sequences and types */
async function objectsToDrop(target: string): Promise<string[]> {
    const listed = await runDuckdb(target, [
        "SELECT 'VIEW' AS kind, schema_name AS s, view_name AS n FROM duckdb_views() WHERE database_name = current_database() AND NOT internal",
        "SELECT 'MACRO' AS kind, schema_name AS s, function_name AS n FROM duckdb_functions() WHERE database_name = current_database() AND NOT internal AND function_type = 'macro'",
        "SELECT 'MACRO TABLE' AS kind, schema_name AS s, function_name AS n FROM duckdb_functions() WHERE database_name = current_database() AND NOT internal AND function_type = 'table_macro'",
        "SELECT 'TABLE' AS kind, schema_name AS s, table_name AS n FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal",
        "SELECT 'SEQUENCE' AS kind, schema_name AS s, sequence_name AS n FROM duckdb_sequences() WHERE database_name = current_database() AND NOT temporary",
        "SELECT 'TYPE' AS kind, schema_name AS s, type_name AS n FROM duckdb_types() WHERE database_name = current_database() AND NOT internal AND logical_type = 'ENUM'",
        "SELECT 'FK' AS kind, schema_name AS s, table_name AS n, referenced_table AS r FROM duckdb_constraints() WHERE database_name = current_database() AND constraint_type = 'FOREIGN KEY'",
    ].map(sql => `${sql};`).join('\n'), { readOnly: true });
    const all = listed.flat();
    const key = (s: unknown, n: unknown) => `${String(s)}.${String(n)}`;
    // DuckDB does not drop a table others still reference (CASCADE or not): the referencing ones first
    const edges = all.filter(o => o.kind === 'FK' && o.r && o.r !== o.n).map(o => ({ from: key(o.s, o.n), to: key(o.s, o.r) }));
    let tables = all.filter(o => o.kind === 'TABLE');
    const orderedTables: Row[] = [];
    while (tables.length) {
        const left = new Set(tables.map(t => key(t.s, t.n)));
        const free = tables.filter(t => !edges.some(e => e.to === key(t.s, t.n) && left.has(e.from)));
        const next = free.length ? free : tables; // a cycle: in any order (the drop then says why)
        orderedTables.push(...next);
        const gone = new Set(next.map(t => key(t.s, t.n)));
        tables = tables.filter(t => !gone.has(key(t.s, t.n)));
    }
    const drop = (o: Row) => `DROP ${o.kind} IF EXISTS tgt.${q(String(o.s))}.${q(String(o.n))} CASCADE;`;
    return [
        ...all.filter(o => o.kind === 'VIEW' || o.kind === 'MACRO' || o.kind === 'MACRO TABLE').map(drop),
        ...orderedTables.map(drop),
        ...all.filter(o => o.kind === 'SEQUENCE' || o.kind === 'TYPE').map(drop),
    ];
}

// --- The driver ----------------------------------------------------------------------------------

export const duckdbDriver: EngineDriver = {
    manifest: DUCKDB,

    connection: {
        test: async input => {
            const file = input.duckdb?.path;
            if (!file) throw new Error('Choose the DuckDB file');
            logger.info(`DuckDB connection test: ${file}`);
            const [row] = await rows(file, 'SELECT version() AS v, (SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database()) AS n');
            return { version: String(row?.v ?? '').replace(/^v/, ''), tables: Number(row?.n ?? 0) };
        },
    },

    stats: {
        size: async dbId => fileSize(fileOf(dbId)),
    },

    catalog: {
        listNamespaces: async dbId => {
            const schemas = await rows(fileOf(dbId), `SELECT s.name, (SELECT count(*) FROM duckdb_tables() t WHERE t.database_name = current_database() AND t.schema_name = s.name) AS table_count FROM (${SCHEMAS_SQL}) s`);
            return { schemas: schemas.map(s => ({ name: String(s.name), table_count: Number(s.table_count) })) };
        },

        listEntities: async (dbId, namespace) => {
            const file = fileOf(dbId);
            const schema = namespace || DUCKDB_DEFAULT_SCHEMA;
            // DuckDB keeps each table's row count: an exact COUNT(*) is cheap
            const tables = await rows(file, 'SELECT table_name AS name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = ? AND NOT internal ORDER BY table_name', [schema]);
            const counts = tables.length
                ? await rows(file, tables.map(t => `SELECT ${lit(String(t.name))} AS name, count(*) AS n FROM ${q(schema)}.${q(String(t.name))}`).join(' UNION ALL '))
                : [];
            const byName = new Map(counts.map(c => [String(c.name), Number(c.n)]));
            return { schema, tables: tables.map(t => ({ name: String(t.name), row_count: byName.get(String(t.name)) ?? null, row_count_estimated: false })) };
        },

        describeEntity: async (dbId, args) => {
            const file = fileOf(dbId);
            const schema = args.schema || DUCKDB_DEFAULT_SCHEMA;
            const columns = await columnsOf(file, schema, args.table);
            const constraints = await constraintsOf(file, schema, args.table);
            const keys = constraints.filter(c => c.constraint_type === 'PRIMARY KEY').flatMap(c => c.constraint_column_names);
            const unique = new Set(constraints.filter(c => c.constraint_type === 'UNIQUE' && c.constraint_column_names.length === 1).map(c => c.constraint_column_names[0]));
            const fks = foreignKeys(schema, constraints);
            return {
                schema,
                columns: columns.map(col => {
                    const fk = fks.find(f => f.source_column === col.column_name);
                    return {
                        ...describeDuckdbColumn(col),
                        is_primary: keys.includes(col.column_name),
                        is_unique: unique.has(col.column_name),
                        is_foreign: !!fk,
                        foreign_key: fk ? { schema: fk.target_schema, table: fk.target_table, column: fk.target_column } : null,
                    };
                }),
            };
        },

        entityRelations: async (dbId, args) => {
            const schema = args.schema || DUCKDB_DEFAULT_SCHEMA;
            return {
                relations: foreignKeys(schema, await constraintsOf(fileOf(dbId), schema, args.table)).map(fk => ({
                    constraint_name: fk.constraint_name,
                    column_name: fk.source_column,
                    foreign_table_schema: fk.target_schema,
                    foreign_table_name: fk.target_table,
                    foreign_column_name: fk.target_column,
                })),
            };
        },

        fullSchema: async (dbId, namespace) => {
            const file = fileOf(dbId);
            const schema = namespace || DUCKDB_DEFAULT_SCHEMA;
            const tables = await rows(file, 'SELECT table_name AS name FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = ? AND NOT internal ORDER BY table_name', [schema]);
            const columns = await rows(file, 'SELECT table_name, column_name, data_type, is_nullable, column_default FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ? AND NOT internal ORDER BY table_name, column_index', [schema]);
            const constraints = await constraintsOf(file, schema);
            return {
                schema,
                tables: tables.map(t => ({ schema, name: String(t.name) })),
                columns: columns.map(c => ({
                    table_schema: schema, table_name: String(c.table_name), column_name: String(c.column_name),
                    data_type: String(c.data_type).toLowerCase(), is_nullable: c.is_nullable ? 'YES' : 'NO', column_default: (c.column_default as string | null) ?? null,
                })),
                primaryKeys: constraints.filter(c => c.constraint_type === 'PRIMARY KEY').flatMap(c => c.constraint_column_names.map(column => ({ table_schema: schema, table_name: c.table_name, column_name: column }))),
                foreignKeys: foreignKeys(schema, constraints),
            };
        },

        enumValues: async (dbId, args) => {
            const schema = args.typeSchema || DUCKDB_DEFAULT_SCHEMA;
            try {
                const values = await rows(fileOf(dbId), `SELECT unnest(enum_range(NULL::${q(schema)}.${q(args.typeName)})) AS v`);
                return { values: values.map(v => String(v.v)) };
            } catch {
                return { values: [] };
            }
        },
    },

    records: {
        count: async (dbId, args) => {
            const [row] = await rows(fileOf(dbId), `SELECT count(*) AS n FROM ${q(args.schema || DUCKDB_DEFAULT_SCHEMA)}.${q(args.table)}`);
            return { count: Number(row?.n ?? 0) };
        },

        page: async (dbId, args) => {
            const file = fileOf(dbId);
            const schema = args.schema || DUCKDB_DEFAULT_SCHEMA;
            const table = `${q(schema)}.${q(args.table)}`;
            const offset = Math.max(0, Number(args.offset) || 0);
            const limit = Math.max(1, Math.min(10000, Number(args.limit) || 50));
            const order = args.sortBy ? `ORDER BY ${q(args.sortBy)} ${args.sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'}` : '';
            const search = args.search?.trim();
            let where = '';
            if (search) {
                const columns = await columnsOf(file, schema, args.table);
                const pattern = lit(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
                where = `WHERE ${columns.map(c => `CAST(${q(c.column_name)} AS VARCHAR) ILIKE ${pattern} ESCAPE '\\'`).join(' OR ') || 'FALSE'}`;
            }
            const results = await runDuckdb(file, [
                `SELECT * FROM ${table} ${where} ${order} LIMIT ${limit} OFFSET ${offset};`,
                search ? `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} ${where} LIMIT ${SEARCH_COUNT_CAP + 1});` : `SELECT count(*) AS n FROM ${table};`,
            ].join('\n'), { readOnly: true });
            const page = results[0] ?? [];
            let total = Number(results[1]?.[0]?.n ?? 0);
            let totalIsEstimate = false;
            if (search && total > SEARCH_COUNT_CAP) {
                total = SEARCH_COUNT_CAP;
                totalIsEstimate = true;
            }
            return { rows: page, total, totalIsEstimate, offset, hasMore: offset + page.length < total || (totalIsEstimate && page.length === limit) };
        },

        lookup: async (dbId, args) => {
            const [row] = await rows(fileOf(dbId), `SELECT * FROM ${q(args.schema || DUCKDB_DEFAULT_SCHEMA)}.${q(args.table)} WHERE ${q(args.column)} = ? LIMIT 1`, [args.value]);
            return { row: row ?? null };
        },

        update: async (dbId, args) => {
            const table = `${q(args.schema || DUCKDB_DEFAULT_SCHEMA)}.${q(args.table)}`;
            const statements: string[] = [];
            for (const change of args.changes) {
                const where = rowWhere(table, change);
                if (!where) return { success: false, results: [{ success: false, column: change.column, error: 'No row identifier provided' }] };
                statements.push(`UPDATE ${table} SET ${q(change.column)} = ${lit(change.newValue)} WHERE ${where} RETURNING 1 AS changed;`);
            }
            try {
                // All or nothing: the tool stops at the first error, before COMMIT
                const done = await runDuckdb(fileOf(dbId), ['BEGIN;', ...statements, 'COMMIT;'].join('\n'));
                return { success: true, results: args.changes.map((change, i) => ({ success: true, column: change.column, rowsAffected: done[i]?.length ?? 0 })) };
            } catch (error) {
                return { success: false, results: [{ success: false, column: args.changes[0]?.column ?? '', error: getErrorMessage(error) }] };
            }
        },

        remove: async (dbId, args) => {
            try {
                const done = await runDuckdb(fileOf(dbId), `DELETE FROM ${q(args.schema || DUCKDB_DEFAULT_SCHEMA)}.${q(args.table)} WHERE ${q(args.primaryKeyColumn)} = ${lit(args.rowId)} RETURNING 1 AS deleted;`);
                return { success: true, rowsAffected: done[0]?.length ?? 0 };
            } catch (error) {
                throw new Error(`Failed to delete row: ${getErrorMessage(error)}`);
            }
        },

        insert: async (dbId, args) => {
            try {
                const table = `${q(args.schema || DUCKDB_DEFAULT_SCHEMA)}.${q(args.table)}`;
                const columns = Object.keys(args.rowData);
                const sql = columns.length
                    ? `INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES (${Object.values(args.rowData).map(lit).join(', ')}) RETURNING *;`
                    : `INSERT INTO ${table} DEFAULT VALUES RETURNING *;`;
                const done = await runDuckdb(fileOf(dbId), sql);
                return { success: true, row: done[0]?.[0] ?? args.rowData };
            } catch (error) {
                throw new Error(`Failed to insert row: ${getErrorMessage(error)}`);
            }
        },
    },

    query: {
        run: async (dbId, args) => {
            const problem = readOnlyProblem(args.sql, 'duckdb');
            if (problem) throw new Error(problem);
            const file = fileOf(dbId);
            const maxRows = Math.max(1, Math.min(100000, Number(args.maxRows) || 5000));
            // Filter values (dashboards) written as literals: the tool takes no parameters
            const sql = statement(bindDuckdb(args.sql, args.values ?? []));
            const isQuery = QUERY_STARTS.has(statementKind(sql, 'duckdb'));
            const start = Date.now();
            const [result = []] = await runDuckdb(file, `${isQuery ? `SELECT * FROM (${sql}) LIMIT ${maxRows + 1}` : sql};`, { readOnly: true, timeoutMs: args.timeoutMs });
            const duration = Date.now() - start;
            let fields = result.length ? Object.keys(result[0]) : [];
            // No row: the columns from DESCRIBE
            if (!fields.length && isQuery) fields = (await rows(file, `DESCRIBE ${sql}`).catch(() => [])).map(r => String(r.column_name));
            return { rows: result.slice(0, maxRows), fields, types: fields.map(() => 0), rowCount: Math.min(result.length, maxRows), truncated: result.length > maxRows, duration };
        },

        runMutation: async (dbId, args) => {
            if (statementCount(args.sql, 'duckdb') > 1) throw new Error('Run one statement at a time');
            const start = Date.now();
            const [result = []] = await runDuckdb(fileOf(dbId), `${statement(args.sql)};`, { timeoutMs: args.timeoutMs });
            const maxRows = Math.max(1, Number(args.maxRows) || 5000);
            return {
                rows: result.slice(0, maxRows), fields: result.length ? Object.keys(result[0]) : [], rowCount: result.length,
                truncated: result.length > maxRows, duration: Date.now() - start, command: statementKind(args.sql, 'duckdb'),
            };
        },
    },

    backup: {
        /** The whole database copied into a new file, consistent (one transaction) */
        dump: async db => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, db.name);
                return { success: false, database: db.name, timestamp, error };
            };
            const file = db.duckdb?.path;
            if (!file) return fail('This DuckDB database has no file');
            if (!fs.existsSync(file)) return fail(`The DuckDB file was not found: ${file}`);
            const prepared = await backupManager.prepareBackupFile(db, timestamp, async () => fileSize(file));
            if ('failure' in prepared) return prepared.failure;
            try {
                // DuckDB writes a database into a file that does not exist yet
                fs.rmSync(prepared.file, { force: true });
                const copy = await copyStatements(file, 'bbdump_source');
                await runDuckdb(':memory:', [
                    `ATTACH ${lit(path.resolve(file))} AS bbdump_source (READ_ONLY);`,
                    `ATTACH ${lit(prepared.file)} AS bbdump_backup;`,
                    'USE bbdump_backup;',
                    'BEGIN;',
                    ...copy,
                    'COMMIT;',
                    'CHECKPOINT bbdump_backup;',
                    'USE memory;',
                    'DETACH bbdump_backup;',
                ].join('\n'), { sandbox: false, timeoutMs: db.backupTimeout ?? 30 * 60 * 1000 });
                logger.info(`DuckDB backup of ${file}`, db.name);
            } catch (error) {
                try { fs.rmSync(prepared.file, { force: true }); fs.rmSync(`${prepared.file}.wal`, { force: true }); } catch { /* nothing written */ }
                return fail(`DuckDB backup failed: ${getErrorMessage(error)}`);
            }
            return backupManager.finishDump(db, {
                file: prepared.file,
                timestamp,
                verify: copy => checkBackup(copy, db.backupTimeout ?? 30 * 60 * 1000),
            });
        },
    },

    restore: {
        /**
         * Replaces the content of the target file with the backup's, in one transaction: its
         * objects are dropped, then the backup is copied in (all or nothing). The backup is
         * checked first.
         */
        restore: async (backupFile, target) => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, target.name);
                return { success: false, database: target.name, timestamp, error };
            };
            const file = target.duckdb?.path;
            if (!file) return fail('This DuckDB database has no file');
            const opened = await backupManager.openBackupForRestore(backupFile, target.name, 'duckdb', timestamp);
            if ('failure' in opened) return opened.failure;
            try {
                const checked = await checkBackup(opened.file, 30 * 60 * 1000);
                if (!checked.valid) return fail(`This backup cannot be restored: ${checked.error}. Nothing was changed`);
                // A new file is created by DuckDB itself; an existing one is emptied first
                const drops = fs.existsSync(file) ? await objectsToDrop(file) : [];
                const copy = await copyStatements(opened.file, 'bbdump_source');
                await runDuckdb(':memory:', [
                    `ATTACH ${lit(opened.file)} AS bbdump_source (READ_ONLY);`,
                    `ATTACH ${lit(path.resolve(file))} AS tgt;`,
                    'USE tgt;',
                    'BEGIN;',
                    ...drops,
                    ...copy,
                    'COMMIT;',
                    'CHECKPOINT tgt;',
                    'USE memory;',
                ].join('\n'), { sandbox: false, timeoutMs: 2 * 60 * 60 * 1000 });
                const message = `Restore successful from ${backupFile} to ${file} (${checked.tables ?? 0} table(s))`;
                logger.info(message, target.name);
                return { success: true, database: target.name, timestamp, message };
            } catch (error) {
                return fail(`Restore failed: ${getErrorMessage(error)}`);
            } finally {
                opened.cleanup();
            }
        },
    },
};

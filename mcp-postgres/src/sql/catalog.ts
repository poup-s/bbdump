/**
 * The catalog of the active MySQL, MariaDB, SQL Server, SQLite or DuckDB database: tables,
 * columns, keys, foreign keys (with their ON DELETE rule, for undo points) and indexes. Read from
 * information_schema (MySQL / MariaDB), sys.* views (SQL Server), PRAGMA functions (SQLite) or
 * duckdb_* functions (DuckDB). A table of another schema than dbo / main is named schema.table.
 */
import type { DatabaseSync } from 'node:sqlite';
import { quoteIdent } from '../shared/sqlGuard.js';
import { duckdbRows, mssqlRows, sqlActive, withSqliteRead } from './client.js';

type Row = Record<string, unknown>;

export interface ColumnInfo { name: string; type: string; nullable: boolean; default: unknown; primary: boolean; extra?: string }
export interface ForeignKey { name: string; columns: string[]; table: string; references: string[]; on_delete: string }
export interface IndexInfo { name: string; columns: string[]; unique: boolean }

/** Quotes an identifier for the active database */
export const qi = (name: string) => {
  const engine = sqlActive().engine;
  return quoteIdent(name, engine === 'sqlite' || engine === 'duckdb' ? engine : engine === 'sqlserver' ? 'tsql' : 'mysql');
};

// --- SQL Server (a table of another schema than dbo is named schema.table) -----------------------

const msName = (row: Row) => (row.s === 'dbo' ? String(row.n) : `${row.s}.${row.n}`);
const MS_OBJECTS = `SELECT SCHEMA_NAME(o.schema_id) AS s, o.name AS n, CASE o.type WHEN 'U' THEN 'table' ELSE 'view' END AS kind, o.object_id
  FROM sys.objects o WHERE o.is_ms_shipped = 0 AND o.type IN ('U', 'V')
  ORDER BY CASE WHEN SCHEMA_NAME(o.schema_id) = 'dbo' THEN 0 ELSE 1 END, s, n`;

async function msObject(name: string): Promise<Row | null> {
  return (await mssqlRows(MS_OBJECTS)).find((row) => msName(row) === name) ?? null;
}

/** "nvarchar(50)", "decimal(10,2)"… */
function msType(row: Row): string {
  const type = String(row.type_name).toLowerCase();
  const length = Number(row.max_length);
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) return `${type}(${length === -1 ? 'max' : length})`;
  if (['nvarchar', 'nchar'].includes(type)) return `${type}(${length === -1 ? 'max' : length / 2})`;
  if (['decimal', 'numeric'].includes(type)) return `${type}(${row.precision},${row.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(type)) return `${type}(${row.scale})`;
  return type;
}

async function msTables() {
  const objects = await mssqlRows(MS_OBJECTS);
  const counts = await mssqlRows("SELECT p.object_id, SUM(p.rows) AS n FROM sys.partitions p WHERE p.index_id IN (0, 1) GROUP BY p.object_id");
  const estimate = new Map(counts.map((c) => [Number(c.object_id), Number(c.n)]));
  const tables = [];
  for (const row of objects.filter((o) => o.kind === 'table')) {
    const rows = estimate.get(Number(row.object_id)) ?? 0;
    // Exact under a million rows (the catalog's count is close, not always exact)
    const exact = rows <= 1_000_000 ? Number((await mssqlRows(`SELECT COUNT_BIG(*) AS n FROM ${quoteIdent(String(row.s), 'tsql')}.${quoteIdent(String(row.n), 'tsql')}`))[0]?.n ?? 0) : null;
    tables.push({ name: msName(row), rows: exact ?? rows, rows_estimated: exact === null });
  }
  return { tables, views: objects.filter((o) => o.kind === 'view').map(msName) };
}

async function msDescribe(name: string) {
  const object = await msObject(name);
  if (!object) throw new Error(`No table or view "${name}" in this database: sql_list_tables lists them.`);
  const id = Number(object.object_id);
  const columns = await mssqlRows(`
    SELECT c.name, TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
           dc.definition AS dflt
    FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    WHERE c.object_id = @p1 ORDER BY c.column_id`, [id]);
  const indexRows = await mssqlRows(`
    SELECT i.name, i.is_unique, i.is_primary_key, c.name AS col FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = @p1 ORDER BY i.index_id, ic.key_ordinal`, [id]);
  const indexes = new Map<string, IndexInfo & { primary: boolean }>();
  for (const row of indexRows) {
    const index = indexes.get(String(row.name)) ?? { name: String(row.name), columns: [], unique: !!row.is_unique, primary: !!row.is_primary_key };
    index.columns.push(String(row.col));
    indexes.set(index.name, index);
  }
  const primary = [...indexes.values()].find((i) => i.primary)?.columns ?? [];
  const fkRows = await mssqlRows(`
    SELECT fk.object_id, fk.name, fk.parent_object_id, SCHEMA_NAME(pt.schema_id) AS ps, pt.name AS pt, SCHEMA_NAME(rt.schema_id) AS rs, rt.name AS rt,
           pc.name AS col, rc.name AS ref, fk.delete_referential_action_desc AS on_delete
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.tables pt ON pt.object_id = fk.parent_object_id JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE fk.parent_object_id = @p1 OR fk.referenced_object_id = @p1 ORDER BY fk.object_id, fkc.constraint_column_id`, [id]);
  const grouped = new Map<number, ForeignKey & { from: number; source: string; target: string }>();
  for (const row of fkRows) {
    const key = Number(row.object_id);
    const fk = grouped.get(key) ?? {
      name: String(row.name), columns: [], table: '', references: [], on_delete: String(row.on_delete).replace(/_/g, ' '),
      from: Number(row.parent_object_id), source: msName({ s: row.ps, n: row.pt }), target: msName({ s: row.rs, n: row.rt }),
    };
    fk.columns.push(String(row.col));
    fk.references.push(String(row.ref));
    grouped.set(key, fk);
  }
  const all = [...grouped.values()];
  return {
    columns: columns.map((c) => ({
      name: String(c.name), type: msType(c), nullable: !!c.is_nullable, default: c.dflt ?? null, primary: primary.includes(String(c.name)),
      extra: c.is_identity ? 'identity (auto)' : c.is_computed ? 'computed' : undefined,
    })),
    primary_key: primary,
    foreign_keys: all.filter((fk) => fk.from === id).map(({ from: _from, source: _source, target, ...fk }) => ({ ...fk, table: target })),
    referenced_by: all.filter((fk) => fk.target === name).map(({ from: _from, source, target: _target, ...fk }) => ({ ...fk, table: source })),
    indexes: [...indexes.values()].filter((i) => !i.primary).map(({ primary: _primary, ...index }) => index),
  };
}

// --- DuckDB --------------------------------------------------------------------------------------

// DuckDB 1.x orders a UNION by its columns only: the order goes outside it
const DUCK_OBJECTS = `SELECT * FROM (SELECT schema_name AS s, table_name AS n, 'table' AS kind, estimated_size AS estimate FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal
  UNION ALL SELECT schema_name, view_name, 'view', NULL FROM duckdb_views() WHERE database_name = current_database() AND NOT internal) objects
  ORDER BY s = 'main' DESC, s, n`;
const duckName = (row: Row) => (row.s === 'main' ? String(row.n) : `${row.s}.${row.n}`);

/** The schema and table of a name as listed (schema.table outside main) */
async function duckObject(file: string, name: string): Promise<{ schema: string; table: string; kind: string } | null> {
  const found = (await duckdbRows(file, DUCK_OBJECTS)).find((row) => duckName(row) === name);
  return found ? { schema: String(found.s), table: String(found.n), kind: String(found.kind) } : null;
}

async function duckTables(file: string) {
  const objects = await duckdbRows(file, DUCK_OBJECTS);
  const tables = [];
  for (const row of objects.filter((r) => r.kind === 'table')) {
    // Exact under a million estimated rows, else DuckDB's estimate
    const estimate = Number(row.estimate ?? 0);
    const exact = estimate <= 1_000_000
      ? Number((await duckdbRows(file, `SELECT count(*) AS n FROM ${quoteIdent(String(row.s), 'duckdb')}.${quoteIdent(String(row.n), 'duckdb')}`))[0]?.n ?? 0)
      : null;
    tables.push({ name: duckName(row), rows: exact ?? estimate, rows_estimated: exact === null });
  }
  return { tables, views: objects.filter((r) => r.kind === 'view').map(duckName) };
}

interface DuckConstraint { constraint_type: string; constraint_column_names: string[]; referenced_table: string | null; referenced_column_names: string[] | null; table_name: string; schema_name: string; constraint_index: number }

async function duckDescribe(file: string, name: string) {
  const object = await duckObject(file, name);
  if (!object) throw new Error(`No table or view "${name}" in this database: sql_list_tables lists them.`);
  const { schema, table } = object;
  const columns = await duckdbRows(file, 'SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ? AND table_name = ? ORDER BY column_index', [schema, table]);
  const constraints = await duckdbRows(file, "SELECT constraint_type, constraint_column_names, referenced_table, referenced_column_names, table_name, schema_name, constraint_index FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = ? AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY') ORDER BY table_name, constraint_index", [schema]) as unknown as DuckConstraint[];
  const indexes = await duckdbRows(file, 'SELECT index_name, is_unique, expressions FROM duckdb_indexes() WHERE database_name = current_database() AND schema_name = ? AND table_name = ?', [schema, table]);
  const own = constraints.filter((c) => c.table_name === table);
  const primary = own.find((c) => c.constraint_type === 'PRIMARY KEY')?.constraint_column_names ?? [];
  const toKey = (c: DuckConstraint, other: string): ForeignKey => ({
    name: `${c.table_name}_fk_${c.constraint_index}`, columns: c.constraint_column_names, table: other,
    references: c.referenced_column_names ?? c.constraint_column_names, on_delete: 'NO ACTION',
  });
  const qualify = (t: string) => (schema === 'main' ? t : `${schema}.${t}`);
  return {
    columns: columns.map((c) => ({
      name: String(c.column_name), type: String(c.data_type), nullable: !!c.is_nullable, default: c.column_default ?? null, primary: primary.includes(String(c.column_name)),
      extra: /nextval\(/i.test(String(c.column_default ?? '')) ? 'sequence (auto)' : undefined,
    })),
    primary_key: primary,
    foreign_keys: own.filter((c) => c.constraint_type === 'FOREIGN KEY' && c.referenced_table).map((c) => toKey(c, qualify(String(c.referenced_table)))),
    referenced_by: constraints.filter((c) => c.constraint_type === 'FOREIGN KEY' && c.referenced_table === table).map((c) => toKey(c, qualify(c.table_name))),
    indexes: [
      ...own.filter((c) => c.constraint_type === 'UNIQUE').map((c) => ({ name: `${table}_unique_${c.constraint_index}`, columns: c.constraint_column_names, unique: true })),
      ...indexes.map((i) => ({ name: String(i.index_name), columns: Array.isArray(i.expressions) ? i.expressions.map(String) : [String(i.expressions ?? '(expression)')], unique: !!i.is_unique })),
    ],
  };
}

async function mysqlRows(sql: string, values: unknown[] = []): Promise<Row[]> {
  const db = sqlActive();
  const [rows] = await db.pool!.query({ sql, values }) as unknown as [Row[]];
  return rows;
}

const sqliteTables = (db: DatabaseSync, type: 'table' | 'view') =>
  db.prepare(`SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all(type).map((r) => String(r.name));

/** Tables (with their row count: exact on SQLite and small MySQL tables, else an estimate) and views */
export async function listTables(): Promise<{ tables: Array<{ name: string; rows: number | null; rows_estimated: boolean }>; views: string[] }> {
  const db = sqlActive();
  if (db.engine === 'duckdb') return duckTables(db.file!);
  if (db.engine === 'sqlserver') return msTables();
  if (db.engine === 'sqlite') {
    return withSqliteRead(db.file!, (sqlite) => ({
      tables: sqliteTables(sqlite, 'table').map((name) => ({ name, rows: Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name, 'sqlite')}`).get()?.n ?? 0), rows_estimated: false })),
      views: sqliteTables(sqlite, 'view'),
    }));
  }
  const rows = await mysqlRows(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimate, DATA_LENGTH AS size
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
  const tables = [];
  for (const row of rows.filter((r) => r.type === 'BASE TABLE')) {
    const small = Number(row.size ?? 0) <= 8 * 1024 * 1024;
    const exact = small ? Number((await mysqlRows(`SELECT COUNT(*) AS n FROM ${quoteIdent(String(row.name), 'mysql')}`))[0]?.n ?? 0) : null;
    tables.push({ name: String(row.name), rows: exact ?? (row.estimate === null ? null : Number(row.estimate)), rows_estimated: exact === null });
  }
  return { tables, views: rows.filter((r) => r.type === 'VIEW').map((r) => String(r.name)) };
}

async function tableExists(table: string): Promise<boolean> {
  const db = sqlActive();
  if (db.engine === 'duckdb') return !!(await duckObject(db.file!, table));
  if (db.engine === 'sqlserver') return !!(await msObject(table));
  if (db.engine === 'sqlite') return withSqliteRead(db.file!, (sqlite) => !!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?").get(table));
  return (await mysqlRows('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).length > 0;
}

/** A table name that exists (a clear error otherwise: the AI checks the list first) */
export async function knownTable(table: string): Promise<string> {
  if (!table || !(await tableExists(table))) throw new Error(`No table or view "${table}" in this database: sql_list_tables lists them.`);
  return table;
}

export async function describeTable(table: string): Promise<{ columns: ColumnInfo[]; primary_key: string[]; foreign_keys: ForeignKey[]; referenced_by: ForeignKey[]; indexes: IndexInfo[] }> {
  const db = sqlActive();
  if (db.engine === 'duckdb') return duckDescribe(db.file!, table);
  if (db.engine === 'sqlserver') return msDescribe(table);
  await knownTable(table);
  if (db.engine === 'sqlite') {
    return withSqliteRead(db.file!, (sqlite) => {
      const info = sqlite.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table) as unknown as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number }>;
      const keys = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const rowid = keys.length === 1 && /^integer$/i.test(String(info.find((c) => c.pk > 0)?.type ?? '').trim());
      const indexes = (sqlite.prepare('SELECT * FROM pragma_index_list(?)').all(table) as unknown as Array<{ name: string; unique: number; origin: string }>).map((index) => ({
        name: index.name,
        unique: !!index.unique,
        columns: (sqlite.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as unknown as Array<{ name: string | null }>).map((c) => c.name ?? '(expression)'),
      }));
      return {
        columns: info.filter((c) => c.hidden !== 1).map((c) => ({
          name: c.name, type: c.type || 'any', nullable: !c.notnull && !(rowid && c.pk > 0), default: c.dflt_value, primary: c.pk > 0,
          extra: rowid && c.pk > 0 ? 'rowid (auto)' : c.hidden === 2 || c.hidden === 3 ? 'generated' : undefined,
        })),
        primary_key: keys,
        foreign_keys: sqliteForeignKeys(sqlite, table),
        referenced_by: sqliteTables(sqlite, 'table').flatMap((other) => sqliteForeignKeys(sqlite, other).filter((fk) => fk.table === table).map((fk) => ({ ...fk, table: other }))),
        indexes,
      };
    });
  }
  const columns = await mysqlRows(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey, EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
  const indexRows = await mysqlRows(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [table]);
  const indexes = new Map<string, IndexInfo>();
  for (const row of indexRows) {
    const index = indexes.get(String(row.name)) ?? { name: String(row.name), columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(String(row.col ?? '(expression)'));
    indexes.set(index.name, index);
  }
  const all = await mysqlForeignKeys();
  return {
    columns: columns.map((c) => ({ name: String(c.name), type: String(c.type), nullable: c.nullable === 'YES', default: c.dflt, primary: c.ckey === 'PRI', extra: String(c.extra || '') || undefined })),
    primary_key: indexes.get('PRIMARY')?.columns ?? [],
    foreign_keys: all.filter((fk) => fk.source === table).map(({ source: _source, ...fk }) => fk),
    referenced_by: all.filter((fk) => fk.table === table).map(({ source, ...fk }) => ({ ...fk, table: source })),
    indexes: [...indexes.values()],
  };
}

function sqliteForeignKeys(sqlite: DatabaseSync, table: string): ForeignKey[] {
  const rows = sqlite.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table) as unknown as Array<{ id: number; seq: number; table: string; from: string; to: string | null; on_delete: string }>;
  const grouped = new Map<number, ForeignKey>();
  for (const row of rows.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    const fk = grouped.get(row.id) ?? { name: `${table}_fk_${row.id}`, columns: [], table: row.table, references: [], on_delete: row.on_delete };
    fk.columns.push(row.from);
    const targetKey = (sqlite.prepare('SELECT name, pk FROM pragma_table_info(?)').all(row.table) as unknown as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    fk.references.push(row.to ?? targetKey[row.seq] ?? 'rowid');
    grouped.set(row.id, fk);
  }
  return [...grouped.values()];
}

/** Every foreign key of the database, with the table it starts from (`source`) */
async function mysqlForeignKeys(): Promise<Array<ForeignKey & { source: string }>> {
  const rows = await mysqlRows(`SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS source, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS target,
      k.REFERENCED_COLUMN_NAME AS ref, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`);
  const grouped = new Map<string, ForeignKey & { source: string }>();
  for (const row of rows) {
    const key = `${row.source}.${row.name}`;
    const fk = grouped.get(key) ?? { name: String(row.name), source: String(row.source), columns: [], table: String(row.target), references: [], on_delete: String(row.on_delete) };
    fk.columns.push(String(row.col));
    fk.references.push(String(row.ref));
    grouped.set(key, fk);
  }
  return [...grouped.values()];
}

export async function primaryKey(table: string): Promise<string[]> {
  return (await describeTable(table)).primary_key;
}

/** Foreign keys of other tables pointing at this one (to follow cascades) */
export async function referencingKeys(table: string): Promise<ForeignKey[]> {
  return (await describeTable(table)).referenced_by;
}

/** Every table with its columns, keys and links, in a compact text the AI reads in one call */
export async function schemaOverview(): Promise<string> {
  const { tables, views } = await listTables();
  const lines: string[] = [];
  for (const table of tables) {
    const info = await describeTable(table.name);
    const columns = info.columns.map((c) => {
      const fk = info.foreign_keys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
      return `${c.name} ${c.type}${c.primary ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}${fk ? ` → ${fk.table}.${fk.references[0]}` : ''}`;
    });
    const multi = info.foreign_keys.filter((f) => f.columns.length > 1).map((f) => `(${f.columns.join(', ')}) → ${f.table}(${f.references.join(', ')})`);
    lines.push(`${table.name} (${table.rows ?? '?'}${table.rows_estimated ? '~' : ''} rows): ${[...columns, ...multi].join(', ')}`);
  }
  if (views.length) lines.push(`Views: ${views.join(', ')}`);
  return lines.join('\n');
}

/**
 * The catalog of the active MySQL, MariaDB, SQLite or DuckDB database: tables, columns, keys,
 * foreign keys (with their ON DELETE rule, for undo points) and indexes. Read from
 * information_schema (MySQL / MariaDB), PRAGMA functions (SQLite) or duckdb_* functions (DuckDB,
 * where a table of another schema than main is named schema.table).
 */
import type { DatabaseSync } from 'node:sqlite';
import { quoteIdent } from '../shared/sqlGuard.js';
import { duckdbRows, sqlActive, withSqliteRead } from './client.js';

type Row = Record<string, unknown>;

export interface ColumnInfo { name: string; type: string; nullable: boolean; default: unknown; primary: boolean; extra?: string }
export interface ForeignKey { name: string; columns: string[]; table: string; references: string[]; on_delete: string }
export interface IndexInfo { name: string; columns: string[]; unique: boolean }

/** Quotes an identifier for the active database */
export const qi = (name: string) => {
  const engine = sqlActive().engine;
  return quoteIdent(name, engine === 'sqlite' || engine === 'duckdb' ? engine : 'mysql');
};

// --- DuckDB --------------------------------------------------------------------------------------

const DUCK_OBJECTS = `SELECT schema_name AS s, table_name AS n, 'table' AS kind, estimated_size AS estimate FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal
  UNION ALL SELECT schema_name, view_name, 'view', NULL FROM duckdb_views() WHERE database_name = current_database() AND NOT internal
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

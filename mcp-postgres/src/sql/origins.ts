/**
 * Where the columns of a query result come from, for SQL Server and DuckDB (their drivers do not
 * say it), so a masked column is replaced by its fake and the others are shown as they are. Read
 * only when the database has masked columns. Anything not certain is left unknown: the masking
 * then stars it, as for any expression.
 *
 * SQL Server: sys.dm_exec_describe_first_result_set in browse mode (the query is compiled, not run).
 * DuckDB: the query's parse tree (json_serialize_sql), read only for a plain SELECT whose columns
 * are columns or stars of tables joined in FROM; any other shape leaves every column unknown.
 */
import { bindDuckdb } from '../shared/duckdbCli.js';
import { replacePlaceholders } from '../shared/sqlGuard.js';
import { mssqlRows, runDuckdb } from './client.js';

export interface ColumnOrigin { schema?: string | null; table: string | null; column: string | null }

type Node = Record<string, any>;

const NONE: ColumnOrigin = { schema: null, table: null, column: null };
const unknown = (count: number): ColumnOrigin[] => Array.from({ length: count }, () => ({ ...NONE }));

/** The origins of the `fieldCount` columns of a SQL Server or DuckDB read, unknown where unsure */
export async function originsOf(engine: string, target: { file?: string }, sql: string, values: unknown[], fieldCount: number): Promise<ColumnOrigin[]> {
  try {
    if (engine === 'sqlserver') return (await sqlServerOrigins(sql, values, fieldCount)) ?? unknown(fieldCount);
    if (engine === 'duckdb' && target.file) return (await duckdbOrigins(target.file, sql, values, fieldCount)) ?? unknown(fieldCount);
  } catch {
    // A query the describe step cannot read: every column stays unknown
  }
  return unknown(fieldCount);
}

// --- SQL Server ----------------------------------------------------------------------------------

async function sqlServerOrigins(sql: string, values: unknown[], fieldCount: number): Promise<ColumnOrigin[] | null> {
  const text = replacePlaceholders(sql, 'tsql', (i) => `@p${i + 1}`);
  const declared = values.map((_, i) => `@p${i + 1} nvarchar(4000)`).join(', ');
  const rows = await mssqlRows(`SELECT source_server, source_database, source_schema, source_table, source_column, DB_NAME() AS current_db
    FROM sys.dm_exec_describe_first_result_set(@p1, @p2, 1) WHERE is_hidden = 0 ORDER BY column_ordinal`, [text, declared || null]);
  return sqlServerOriginsFrom(rows, fieldCount);
}

/** Origins from the describe rows: a column of another server or database stays unknown */
export function sqlServerOriginsFrom(rows: Array<Record<string, unknown>>, fieldCount: number): ColumnOrigin[] | null {
  if (rows.length !== fieldCount) return null;
  return rows.map((row) => {
    const elsewhere = row.source_server || (row.source_database && String(row.source_database) !== String(row.current_db));
    if (elsewhere || !row.source_table || !row.source_column) return { ...NONE };
    return { schema: String(row.source_schema || 'dbo'), table: String(row.source_table), column: String(row.source_column) };
  });
}

// --- DuckDB --------------------------------------------------------------------------------------

export interface DuckColumn { schema: string; table: string; column: string }

const DUCK_COLUMNS = `SELECT c.schema_name AS schema, c.table_name AS "table", c.column_name AS "column"
  FROM duckdb_columns() c JOIN duckdb_tables() t ON t.database_name = c.database_name AND t.schema_name = c.schema_name AND t.table_name = c.table_name
  WHERE c.database_name = current_database() ORDER BY c.schema_name, c.table_name, c.column_index`;

async function duckdbOrigins(file: string, sql: string, values: unknown[], fieldCount: number): Promise<ColumnOrigin[] | null> {
  const bound = bindDuckdb(sql, values).trim().replace(/;+\s*$/, '');
  const literal = `'${bound.replace(/'/g, "''")}'`;
  const [parsed = [], columns = []] = await runDuckdb(file, `SELECT CAST(json_serialize_sql(${literal}) AS VARCHAR) AS tree;\n${DUCK_COLUMNS};`);
  const tree = parsed[0]?.tree;
  return resolveDuckdbOrigins(typeof tree === 'string' ? JSON.parse(tree) : tree as Node, columns as unknown as DuckColumn[], fieldCount);
}

interface Table { schema: string; table: string; columns: string[] }
interface Source extends Table { alias: string }

const lower = (value: unknown) => String(value ?? '').toLowerCase();

/** The tables a FROM clause joins, in order; false when it holds anything else (subquery, view, function, NATURAL / USING join…) */
function sourcesOf(ref: Node | null | undefined, tables: Map<string, Table>, out: Source[]): boolean {
  if (!ref || ref.type === 'EMPTY_FROM' || ref.type === 'EMPTY') return true;
  if (ref.type === 'BASE_TABLE') {
    if (ref.catalog_name || ref.at_clause || ref.sample || (ref.column_name_alias ?? []).length) return false;
    const table = tables.get(`${lower(ref.schema_name || 'main')}.${lower(ref.table_name)}`);
    // A view, a CTE or an unknown name: its columns are not followed
    if (!table) return false;
    out.push({ ...table, alias: lower(ref.alias || ref.table_name) });
    return true;
  }
  if (ref.type === 'JOIN') {
    // NATURAL, USING, SEMI and ANTI joins change which columns a star gives
    if (!['REGULAR', 'CROSS'].includes(String(ref.ref_type))) return false;
    if ((ref.using_columns ?? []).length || !['INNER', 'LEFT', 'RIGHT', 'OUTER', 'INVALID'].includes(String(ref.join_type ?? 'INNER'))) return false;
    return sourcesOf(ref.left, tables, out) && sourcesOf(ref.right, tables, out);
  }
  return false;
}

/**
 * The origins of a DuckDB query from its parse tree and the columns of the file's tables; null when
 * the query is not a plain SELECT over tables (every column then stays unknown)
 */
export function resolveDuckdbOrigins(parsed: Node | null | undefined, columns: DuckColumn[], fieldCount: number): ColumnOrigin[] | null {
  const statements = parsed?.statements;
  if (!parsed || parsed.error || !Array.isArray(statements) || statements.length !== 1) return null;
  const node = statements[0]?.node;
  if (node?.type !== 'SELECT_NODE' || (node.cte_map?.map ?? []).length) return null;
  const tables = new Map<string, Table>();
  for (const c of columns) {
    const key = `${lower(c.schema)}.${lower(c.table)}`;
    if (!tables.has(key)) tables.set(key, { schema: String(c.schema), table: String(c.table), columns: [] });
    tables.get(key)!.columns.push(String(c.column));
  }
  const sources: Source[] = [];
  if (!sourcesOf(node.from_table, tables, sources)) return null;
  const columnOf = (source: Source, name: string): ColumnOrigin | null => {
    const column = source.columns.find((c) => lower(c) === lower(name));
    return column ? { schema: source.schema, table: source.table, column } : null;
  };
  const origins: ColumnOrigin[] = [];
  for (const item of node.select_list ?? []) {
    if (item?.class === 'COLUMN_REF') {
      const path: string[] = (item.column_names ?? []).map(String);
      const holders = path.length === 1 ? sources.filter((s) => columnOf(s, path[0]))
        : path.length === 2 ? sources.filter((s) => s.alias === lower(path[0]))
          : path.length === 3 ? sources.filter((s) => lower(s.schema) === lower(path[0]) && lower(s.table) === lower(path[1]))
            : [];
      // Ambiguous or not a column of these tables (a struct field, an alias…): unknown
      origins.push((holders.length === 1 && columnOf(holders[0], path[path.length - 1])) || { ...NONE });
      continue;
    }
    if (item?.class === 'STAR') {
      const plain = !item.columns && !item.expr && !(item.exclude_list ?? []).length && !(item.replace_list ?? []).length
        && !(item.rename_list ?? []).length && !(item.qualified_exclude_list ?? []).length;
      if (!plain) return null;
      const from = item.relation_name ? sources.filter((s) => s.alias === lower(item.relation_name)) : sources;
      if (!from.length) return null;
      for (const source of from) for (const column of source.columns) origins.push({ schema: source.schema, table: source.table, column });
      continue;
    }
    // An expression: its value is not a column's
    origins.push({ ...NONE });
  }
  return origins.length === fieldCount ? origins : null;
}

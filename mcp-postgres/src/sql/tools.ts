/**
 * Reading tools for MySQL, MariaDB and SQLite databases: tables, one table in detail, the whole
 * schema in one call, read-only queries and their plan. The personal columns chosen in bbdump
 * come masked; a result column whose origin is unknown (an expression, a view) is masked too
 * when the database has any.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, textResult, type ToolResult } from '../types.js';
import { READ } from '../tools/common.js';
import { toCsv, toMarkdown } from '../sql.js';
import { fakeValue, readMaskingFile, rulesFromFile, type MaskKind } from '../masking.js';
import { activeSql, keepReachable, readQuery, sqlActive, sqlError, type ReadResult } from './client.js';
import { describeTable, listTables, schemaOverview } from './catalog.js';

type Row = Record<string, unknown>;

export const MAX_ROWS = 1000;
const MAX_RESULT_CHARS = 150_000;

const MASKING_NOTE = 'Some values were masked by the user in bbdump (partly starred such as ****234@email.fr, realistic fakes such as Camille Martin, XXXX…, NULL, numbers with ±10 % noise, dates moved or rounded). Work with them as they are: never try to find the real values.';

/** A value the AI can read in JSON: bigints as text, binary data as its size */
export function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  return value;
}

/** The masking rules of the active database (column → kind), null when masking is off for it */
function rules(): Map<string, MaskKind> | null {
  const db = sqlActive();
  return rulesFromFile(readMaskingFile(), [db.id]);
}

const isClear = (value: unknown) => value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint';

/**
 * Rows for the AI: chosen columns replaced by their fake, and columns of unknown origin (an
 * expression, a view) partly starred when the database has masked columns at all.
 */
async function protect(result: ReadResult): Promise<{ rows: Row[]; masked: string[] }> {
  const masking = rules();
  if (!masking || !masking.size) return { rows: result.rows, masked: [] };
  const db = sqlActive();
  const schema = db.database;
  const { tables } = await listTables();
  const base = new Set(tables.map((t) => t.name));
  const plan = result.fields.map((field, i) => {
    const origin = result.origins[i];
    if (origin?.table && origin.column && base.has(origin.table)) {
      return { field, kind: masking.get(`${schema}.${origin.table}.${origin.column}`) ?? null, unknown: false };
    }
    // Unknown origin: never sent as is
    return { field, kind: 'partial' as MaskKind, unknown: true };
  });
  const masked = new Set<string>();
  const rows = result.rows.map((row) => {
    const out: Row = { ...row };
    for (const { field, kind, unknown } of plan) {
      if (!kind || !(field in out)) continue;
      if (unknown && isClear(out[field])) continue;
      out[field] = fakeValue(out[field], kind);
      masked.add(field);
    }
    return out;
  });
  return { rows, masked: [...masked] };
}

function rowsResult(fields: string[], rows: Row[], format: 'json' | 'markdown' | 'csv', info: Row): ToolResult {
  let kept = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plainValue(v)])));
  let leftOut = 0;
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_RESULT_CHARS) {
    const next = kept.slice(0, Math.ceil(kept.length * 0.8));
    leftOut += kept.length - next.length;
    kept = next;
  }
  const note = leftOut ? { left_out: leftOut, note: `${leftOut} rows left out: the result was too long. Select fewer columns or rows.` } : {};
  if (format === 'json') return jsonResult({ ...info, ...note, columns: fields, rows: kept });
  const header = Object.entries({ ...info, ...note }).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  const body = format === 'csv' ? toCsv(fields, kept) : (kept.length ? toMarkdown(fields, kept) : '(no rows)');
  return textResult(`${header}\n\n${body}`);
}

async function run(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    await keepReachable();
    return await work();
  } catch (err) {
    return errorResult(sqlError(err));
  }
}

const tableParam = z.string().min(1).describe('Table (or view) name, as listed by sql_list_tables');
const formatParam = z.enum(['json', 'markdown', 'csv']).default('json').describe('json (default), markdown (compact table) or csv');

export function registerSqlTools(server: McpServer) {
  server.registerTool('sql_list_tables', {
    title: 'List tables (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: the tables of the active database with their row count (exact for small tables, ~ for an estimate) and its views. Call use_connection on such a database first.',
    inputSchema: {},
    annotations: READ,
  }, async () => run(async () => {
    const db = sqlActive();
    return jsonResult({ database: db.label, engine: db.engine, ...(await listTables()) });
  }));

  server.registerTool('sql_describe_table', {
    title: 'Describe a table (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: the columns of a table (type, nullable, default, key), its primary key, foreign keys both ways (with ON DELETE) and indexes. Read it before writing a query or a change.',
    inputSchema: { table: tableParam },
    annotations: READ,
  }, async ({ table }) => run(async () => jsonResult({ table, ...(await describeTable(table)) })));

  server.registerTool('sql_schema_overview', {
    title: 'Schema overview (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: every table with its columns, keys and links (col → table.col) in one compact text. The fastest way to learn a database.',
    inputSchema: {},
    annotations: READ,
  }, async () => run(async () => {
    const db = sqlActive();
    return textResult(`${db.engine} database "${db.label}"\n${await schemaOverview()}`);
  }));

  server.registerTool('sql_query', {
    title: 'Run a read-only query (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: runs one reading statement (SELECT, WITH, SHOW, EXPLAIN…; PRAGMA on SQLite) read-only and returns its rows. Use ? placeholders with params for values. '
      + 'Dialect: MySQL / MariaDB quote names with `backticks`; SQLite with "double quotes". Writes, DDL and several statements are refused here (sql_execute writes, with the user\'s approval).',
    inputSchema: {
      sql: z.string().min(1).describe('One reading statement'),
      params: z.array(z.any()).optional().describe('Values for the ? placeholders, in order'),
      limit: z.number().int().min(1).max(MAX_ROWS).default(200).describe(`Rows returned (at most ${MAX_ROWS})`),
      format: formatParam,
    },
    annotations: READ,
  }, async ({ sql, params, limit, format }) => run(async () => {
    const result = await readQuery(sql, params ?? [], { maxRows: limit });
    const shown = await protect(result);
    const masking = shown.masked.length ? { masked_columns: shown.masked, masking: MASKING_NOTE } : {};
    return rowsResult(result.fields, shown.rows, format, {
      rows: shown.rows.length,
      ...(result.truncated ? { truncated: true, note_limit: `Only the first ${limit} rows: add a LIMIT, filters or an aggregate.` } : {}),
      duration_ms: result.duration,
      ...masking,
    });
  }));

  server.registerTool('sql_explain', {
    title: 'Explain a query (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: the plan of a reading query (EXPLAIN on MySQL / MariaDB, EXPLAIN QUERY PLAN on SQLite), without running it. Shows full scans and the indexes used.',
    inputSchema: { sql: z.string().min(1).describe('One reading statement') },
    annotations: READ,
  }, async ({ sql }) => run(async () => {
    const db = sqlActive();
    const explained = db.engine === 'sqlite' ? `EXPLAIN QUERY PLAN ${sql}` : `EXPLAIN ${sql}`;
    const result = await readQuery(explained, [], { maxRows: 500 });
    return rowsResult(result.fields, result.rows, 'markdown', { engine: db.engine });
  }));
}

/** The database the sql_* tools work on, for list_connections */
export function sqlConnectionLabel(): Row | null {
  const db = activeSql();
  return db && { name: db.label, engine: db.engine, target: db.engine === 'sqlite' ? db.where : `${db.where}/${db.database}` };
}

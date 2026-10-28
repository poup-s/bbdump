/**
 * Changes to MySQL, MariaDB and SQLite tables. Each one waits for the user's approval in bbdump,
 * and the structured ones (insert, update, delete rows) save an undo point when they can: the
 * rows before and after, by primary key, including the rows a foreign key cascades to, in the
 * same encrypted journal as the other engines. The bbdump app undoes them.
 *
 * The rows are read first, in the change's own transaction, and the change then only touches
 * those (by primary key): what the confirmation showed is what changes.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult, jsonResult, type ToolResult } from '../types.js';
import { WRITE } from '../tools/common.js';
import { requestConfirmation, refusalMessage } from '../confirm.js';
import { journalAvailable, writeEntry, MAX_UNDO_ROWS, type UndoTable } from '../journal.js';
import { currentClientName } from '../tools/mutations.js';
import { encodeRow, rowKey } from '../shared/sqlRows.js';
import { statementCount, statementKind } from '../shared/sqlGuard.js';
import { activeSql, keepReachable, sqlActive, sqlError, withWrite, type WriteSession } from './client.js';
import { describeTable, knownTable, qi } from './catalog.js';
import { plainValue } from './tools.js';

type Row = Record<string, unknown>;
const MAX_INSERT = 1000;

/** A WHERE clause from {column: value}: null → IS NULL, an array → IN (…) */
function whereOf(where: Row): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(where)) {
    if (value === null) parts.push(`${qi(column)} IS NULL`);
    else if (Array.isArray(value)) {
      if (!value.length) parts.push('1 = 0');
      else {
        parts.push(`${qi(column)} IN (${value.map(() => '?').join(', ')})`);
        values.push(...value);
      }
    } else {
      parts.push(`${qi(column)} = ?`);
      values.push(value);
    }
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', values };
}

/** The SQL as the user reads it in the confirmation (values written in) */
function shown(sql: string, values: unknown[]): string {
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    const value = plainValue(values[i++]);
    return value === null || value === undefined ? 'NULL' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${String(typeof value === 'object' ? JSON.stringify(value) : value).replace(/'/g, "''")}'`;
  });
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** Rows of a table matched by their primary keys (several columns: OR of ANDs) */
function byKeys(primaryKey: string[], keys: unknown[][]): { sql: string; values: unknown[] } {
  if (!keys.length) return { sql: '1 = 0', values: [] };
  if (primaryKey.length === 1) return { sql: `${qi(primaryKey[0])} IN (${keys.map(() => '?').join(', ')})`, values: keys.map((k) => k[0]) };
  return {
    sql: keys.map(() => `(${primaryKey.map((c) => `${qi(c)} = ?`).join(' AND ')})`).join(' OR '),
    values: keys.flat(),
  };
}

const keyOf = (row: Row, primaryKey: string[]) => primaryKey.map((c) => row[c] ?? null);

/**
 * The rows that would follow a delete through foreign keys (CASCADE deletes them, SET NULL /
 * SET DEFAULT change them), to keep them in the undo point too. A few levels deep.
 */
async function cascadeRows(session: WriteSession, table: string, rows: Row[], depth = 0): Promise<Array<{ table: string; primaryKey: string[]; rows: Row[] }>> {
  if (depth > 4 || !rows.length) return [];
  const info = await describeTable(table);
  const found: Array<{ table: string; primaryKey: string[]; rows: Row[] }> = [];
  for (const fk of info.referenced_by.filter((f) => /cascade|set null|set default/i.test(f.on_delete))) {
    const parentValues = rows.map((row) => fk.references.map((c) => row[c]));
    const match = fk.columns.length === 1
      ? { sql: `${qi(fk.columns[0])} IN (${parentValues.map(() => '?').join(', ')})`, values: parentValues.map((v) => v[0]) }
      : { sql: parentValues.map(() => `(${fk.columns.map((c) => `${qi(c)} = ?`).join(' AND ')})`).join(' OR '), values: parentValues.flat() };
    const children = await session.rows(`SELECT * FROM ${qi(fk.table)} WHERE ${match.sql}`, match.values);
    if (!children.length) continue;
    const childKey = (await describeTable(fk.table)).primary_key;
    if (!childKey.length) throw new Error(`the table ${fk.table} (reached by ${fk.on_delete}) has no primary key`);
    found.push({ table: fk.table, primaryKey: childKey, rows: children });
    if (/cascade/i.test(fk.on_delete)) found.push(...await cascadeRows(session, fk.table, children, depth + 1));
  }
  return found;
}

/** The undo point of captured tables: rows before, and the same rows (by key) after the change */
async function undoTables(session: WriteSession, captured: Array<{ table: string; primaryKey: string[]; rows: Row[]; after?: Row[] }>): Promise<UndoTable[]> {
  const schema = activeSql()?.database ?? '';
  const tables: UndoTable[] = [];
  for (const entry of captured) {
    let after = entry.after;
    if (!after) {
      const keys = byKeys(entry.primaryKey, entry.rows.map((row) => keyOf(row, entry.primaryKey)));
      after = await session.rows(`SELECT * FROM ${qi(entry.table)} WHERE ${keys.sql}`, keys.values);
    }
    tables.push({ schema, table: entry.table, primaryKey: entry.primaryKey, before: entry.rows.map(encodeRow), after: after.map(encodeRow) });
  }
  return tables;
}

const touched = (tables: UndoTable[]) => tables.reduce((n, t) => n + new Set([...t.before, ...t.after].map((r) => rowKey(r, t.primaryKey))).size, 0);

/** Records the change; returns what the tool answers about its undo */
function journal(params: { tool: string; table: string; sql: string; description: string; affected: number | null; tables: UndoTable[] | null; reason?: string }) {
  const db = activeSql();
  if (!db) return {};
  const rows = params.tables ? touched(params.tables) : 0;
  const available = !!params.tables && rows > 0;
  const id = writeEntry({
    engine: db.engine,
    client: currentClientName(),
    tool: params.tool,
    databaseId: db.id,
    connection: { label: db.label, host: db.where, port: db.port, database: db.database, user: db.user },
    sql: params.sql,
    description: params.description,
    rowsAffected: params.affected,
    undo: {
      available,
      reason: available ? undefined : (params.reason ?? (params.tables ? 'nothing changed' : 'not captured')),
      rows,
      tables: (params.tables ?? [{ table: params.table }]).map((t) => `${db.database}.${t.table}`),
    },
  }, available ? params.tables : null);
  if (!id) return {};
  return {
    change_id: id,
    undo: available
      ? `Undo point saved: undo_change "${id}" (or the bbdump AI journal) restores the ${rows} row(s) touched.`
      : `No undo point: ${params.reason ?? 'nothing changed'}.`,
  };
}

async function confirm(tool: string, table: string | undefined, sql: string, description: string): Promise<ToolResult | null> {
  const db = sqlActive('mcp.write');
  const outcome = await requestConfirmation({ tool, engine: db.engine, database: db.label, table, schema: db.database, sql, description });
  return outcome.approved ? null : errorResult(refusalMessage(outcome));
}

const undoNote = (available: boolean, reason?: string) => {
  if (!journalAvailable()) return ' · no undo point (MCP server not set up by bbdump)';
  return available ? ' · undo point saved' : ` · NO undo point: ${reason}`;
};

async function run(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    await keepReachable();
    return await work();
  } catch (err) {
    return errorResult(sqlError(err));
  }
}

/** Rows the WHERE matches now (for the confirmation) */
async function countMatching(table: string, where: { sql: string; values: unknown[] }): Promise<number> {
  return withWrite(async (session) => Number((await session.rows(`SELECT COUNT(*) AS n FROM ${qi(table)} WHERE ${where.sql}`, where.values))[0]?.n ?? 0));
}

const tableParam = z.string().min(1).describe('Table name, as listed by sql_list_tables');
const whereParam = z.record(z.string(), z.any()).describe('Rows to change: {"column": value} (all must match; null = IS NULL; an array = IN (…)). {} matches every row and needs all_rows: true');

export function registerSqlWriteTools(server: McpServer) {
  server.registerTool('sql_insert_rows', {
    title: 'Insert rows (MySQL, MariaDB, SQLite)',
    description: `MySQL, MariaDB or SQLite: inserts rows ({"column": value} each, at most ${MAX_INSERT}). Columns left out get their default (auto-increment ids too). Confirmed by the user in bbdump; an undo point is saved (the table needs a primary key).`,
    inputSchema: { table: tableParam, rows: z.array(z.record(z.string(), z.any())).min(1).max(MAX_INSERT).describe('Rows to insert') },
    annotations: WRITE,
  }, async ({ table, rows }) => run(async () => {
    await knownTable(table);
    const info = await describeTable(table);
    const primaryKey = info.primary_key;
    const columnsOf = (row: Row) => Object.keys(row);
    const statement = (row: Row) => columnsOf(row).length
      ? `INSERT INTO ${qi(table)} (${columnsOf(row).map(qi).join(', ')}) VALUES (${columnsOf(row).map(() => '?').join(', ')})`
      : `INSERT INTO ${qi(table)} DEFAULT VALUES`;
    const preview = rows.slice(0, 3).map((row) => shown(statement(row), Object.values(row))).join(';\n') + (rows.length > 3 ? `;\n… (${rows.length} rows)` : '');
    const reason = primaryKey.length ? undefined : 'the table has no primary key';
    const refused = await confirm('sql_insert_rows', table, preview, `Insert ${rows.length} row(s) into ${table}${undoNote(!reason, reason)}`);
    if (refused) return refused;
    const result = await withWrite(async (session) => {
      const inserted: Row[] = [];
      for (const row of rows) {
        const sql = session.dialect === 'mysql' && !columnsOf(row).length ? `INSERT INTO ${qi(table)} () VALUES ()` : statement(row);
        const { insertId } = await session.run(sql, Object.values(row));
        if (!primaryKey.length) continue;
        // Read back by key: the auto-increment id given, or the key values sent
        const key = primaryKey.length === 1 && row[primaryKey[0]] === undefined ? [insertId] : primaryKey.map((c) => row[c]);
        const match = byKeys(primaryKey, [key]);
        inserted.push(...await session.rows(`SELECT * FROM ${qi(table)} WHERE ${match.sql}`, match.values));
      }
      const tables = primaryKey.length ? [{ schema: activeSql()?.database ?? '', table, primaryKey, before: [], after: inserted.map(encodeRow) }] : null;
      return { inserted, tables };
    });
    return jsonResult({
      inserted: rows.length,
      rows: result.inserted.slice(0, 20).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plainValue(v)]))),
      ...journal({ tool: 'sql_insert_rows', table, sql: preview, description: `Insert ${rows.length} row(s) into ${table}`, affected: rows.length, tables: result.tables, reason }),
    });
  }));

  server.registerTool('sql_update_rows', {
    title: 'Update rows (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: sets columns on the rows matching a where object. Confirmed by the user in bbdump (with the number of rows); the rows are read first and an undo point is saved (the table needs a primary key, and the key itself must not change).',
    inputSchema: {
      table: tableParam,
      where: whereParam,
      set: z.record(z.string(), z.any()).describe('Columns to change: {"status": "paid", "total": 12.5}'),
      all_rows: z.boolean().optional().describe('true to change every row of the table (an empty where)'),
    },
    annotations: WRITE,
  }, async ({ table, where, set, all_rows }) => run(async () => {
    await knownTable(table);
    if (!Object.keys(set).length) return errorResult('Nothing to set.');
    if (!Object.keys(where).length && !all_rows) return errorResult('An empty where matches every row: pass all_rows: true if that is what the user wants.');
    const primaryKey = (await describeTable(table)).primary_key;
    const condition = whereOf(where);
    const assignments = Object.keys(set).map((c) => `${qi(c)} = ?`).join(', ');
    const sql = `UPDATE ${qi(table)} SET ${assignments} WHERE ${condition.sql}`;
    const count = await countMatching(table, condition);
    if (!count) return jsonResult({ updated: 0, note: 'No row matches: nothing was changed.' });
    const reason = !primaryKey.length ? 'the table has no primary key'
      : primaryKey.some((c) => c in set) ? 'the primary key itself changes'
        : count > MAX_UNDO_ROWS ? `more than ${MAX_UNDO_ROWS} rows` : undefined;
    const refused = await confirm('sql_update_rows', table, shown(sql, [...Object.values(set), ...condition.values]), `Update ${count} row(s) of ${table}${undoNote(!reason, reason)}`);
    if (refused) return refused;
    const result = await withWrite(async (session) => {
      if (reason) return { affected: (await session.run(sql, [...Object.values(set), ...condition.values])).affected, tables: null };
      const lock = session.dialect === 'mysql' ? ' FOR UPDATE' : '';
      const before = await session.rows(`SELECT * FROM ${qi(table)} WHERE ${condition.sql}${lock}`, condition.values);
      const keys = byKeys(primaryKey, before.map((row) => keyOf(row, primaryKey)));
      const { affected } = await session.run(`UPDATE ${qi(table)} SET ${assignments} WHERE ${keys.sql}`, [...Object.values(set), ...keys.values]);
      return { affected, tables: await undoTables(session, [{ table, primaryKey, rows: before }]) };
    });
    return jsonResult({
      updated: result.affected,
      ...journal({ tool: 'sql_update_rows', table, sql: shown(sql, [...Object.values(set), ...condition.values]), description: `Update ${result.affected} row(s) of ${table}`, affected: result.affected, tables: result.tables, reason }),
    });
  }));

  server.registerTool('sql_delete_rows', {
    title: 'Delete rows (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: deletes the rows matching a where object. Confirmed by the user in bbdump; the rows (and those a foreign key cascades to) are read first and an undo point is saved.',
    inputSchema: { table: tableParam, where: whereParam, all_rows: z.boolean().optional().describe('true to delete every row of the table (an empty where)') },
    annotations: WRITE,
  }, async ({ table, where, all_rows }) => run(async () => {
    await knownTable(table);
    if (!Object.keys(where).length && !all_rows) return errorResult('An empty where matches every row: pass all_rows: true if that is what the user wants.');
    const primaryKey = (await describeTable(table)).primary_key;
    const condition = whereOf(where);
    const sql = `DELETE FROM ${qi(table)} WHERE ${condition.sql}`;
    const count = await countMatching(table, condition);
    if (!count) return jsonResult({ deleted: 0, note: 'No row matches: nothing was deleted.' });
    const reason = !primaryKey.length ? 'the table has no primary key' : count > MAX_UNDO_ROWS ? `more than ${MAX_UNDO_ROWS} rows` : undefined;
    const refused = await confirm('sql_delete_rows', table, shown(sql, condition.values), `Delete ${count} row(s) from ${table}${undoNote(!reason, reason)}`);
    if (refused) return refused;
    const result = await withWrite(async (session) => {
      if (reason) return { affected: (await session.run(sql, condition.values)).affected, tables: null, cascaded: 0, reason };
      const lock = session.dialect === 'mysql' ? ' FOR UPDATE' : '';
      const before = await session.rows(`SELECT * FROM ${qi(table)} WHERE ${condition.sql}${lock}`, condition.values);
      let children: Awaited<ReturnType<typeof cascadeRows>> = [];
      let cascadeProblem: string | undefined;
      try {
        children = await cascadeRows(session, table, before);
      } catch (err) {
        cascadeProblem = sqlError(err);
      }
      const keys = byKeys(primaryKey, before.map((row) => keyOf(row, primaryKey)));
      const { affected } = await session.run(`DELETE FROM ${qi(table)} WHERE ${keys.sql}`, keys.values);
      if (cascadeProblem) return { affected, tables: null, cascaded: 0, reason: cascadeProblem };
      const tables = await undoTables(session, [{ table, primaryKey, rows: before, after: [] }, ...children]);
      return { affected, tables, cascaded: children.reduce((n, c) => n + c.rows.length, 0), reason: undefined };
    });
    return jsonResult({
      deleted: result.affected,
      ...(result.cascaded ? { rows_reached_by_foreign_keys: result.cascaded } : {}),
      ...journal({ tool: 'sql_delete_rows', table, sql: shown(sql, condition.values), description: `Delete ${result.affected} row(s) from ${table}`, affected: result.affected, tables: result.tables, reason: result.reason }),
    });
  }));

  server.registerTool('sql_execute', {
    title: 'Run a statement that writes (MySQL, MariaDB, SQLite)',
    description: 'MySQL, MariaDB or SQLite: runs ONE statement that changes data or structure (INSERT … SELECT, UPDATE with joins, CREATE INDEX, ALTER TABLE…). Confirmed by the user in bbdump. No undo point: prefer sql_insert_rows / sql_update_rows / sql_delete_rows when they fit, and offer create_backup before a risky change.',
    inputSchema: { sql: z.string().min(1).describe('One statement'), params: z.array(z.any()).optional().describe('Values for the ? placeholders, in order') },
    annotations: WRITE,
  }, async ({ sql, params }) => run(async () => {
    const db = sqlActive('mcp.write');
    const dialect = db.engine === 'sqlite' ? 'sqlite' : 'mysql';
    if (statementCount(sql, dialect) !== 1) return errorResult('Run exactly one statement at a time.');
    const kind = statementKind(sql, dialect);
    const text = shown(sql, params ?? []);
    const refused = await confirm('sql_execute', undefined, text, `${kind || 'Statement'} on ${db.label}${undoNote(false, 'free SQL (back up first for a risky change)')}`);
    if (refused) return refused;
    const affected = await withWrite(async (session) => (await session.run(sql, params ?? [])).affected);
    return jsonResult({
      done: true,
      statement: kind,
      rows_affected: affected,
      ...journal({ tool: 'sql_execute', table: '', sql: text, description: `${kind || 'Statement'} on ${db.label}`, affected, tables: null, reason: 'free SQL: no undo point' }),
    });
  }));
}

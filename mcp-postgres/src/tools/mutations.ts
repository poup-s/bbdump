import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pg from 'pg';
import pgFormat from 'pg-format';
import { withClient, executeDryRun, executeReadOnly, getActiveConnectionInfo, resolveSchema, clampTimeout } from '../db.js';
import { jsonResult, errorResult, MAX_TIMEOUT_MS } from '../types.js';
import { buildWhereClause, type Filter } from '../filters.js';
import { requestConfirmation, refusalMessage, appApi } from '../confirm.js';
import { recordQuery } from '../history.js';
import { statementCount, findWriteKeyword } from '../sql.js';
import { findDatabase } from '../connections.js';
import { journalAvailable, listEntries, writeEntry, MAX_UNDO_ROWS, type UndoTable } from '../journal.js';
import {
  primaryKey, selectForUndo, captureDelete, modifiedTable, snapshotTable, diffSnapshots, touchedRows, startTriggerCapture, UndoUnavailable,
} from '../undo.js';
import { WRITE, READ, databaseParam, schemaParam, tableParam, filterSchema } from './common.js';

type Client = pg.PoolClient;

/** Rows sent back after a write (RETURNING *): enough to check, not the whole table */
const RETURNED_ROWS = 50;
/** PostgreSQL accepts 65535 bind parameters per statement */
const MAX_PARAMS = 65535;
/** Column added to RETURNING to keep each row as JSON for the undo point */
const ROW_JSON = '__bbdump_row';

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.any()), z.record(z.any())]);

/** node-postgres sends objects as JSON and arrays as PostgreSQL arrays */
const toParam = (value: unknown) => value;

const returned = (rows: Record<string, unknown>[]) => {
  const clean = rows.map(({ [ROW_JSON]: _json, ...rest }) => rest);
  return {
    rows: clean.slice(0, RETURNED_ROWS),
    ...(clean.length > RETURNED_ROWS ? { rows_truncated: `${clean.length - RETURNED_ROWS} more row(s) not shown` } : {}),
  };
};

let clientName: () => string | undefined = () => undefined;
/** The AI client's name (Claude, Cursor…), for the journal */
export function setClientNameSource(source: () => string | undefined) { clientName = source; }

/** BEGIN … COMMIT around a write and its undo capture; ROLLBACK on any error */
async function inWriteTransaction<T>(client: Client, timeoutMs: number | undefined, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL statement_timeout = ${clampTimeout(timeoutMs)}`);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** What the confirmation says about the undo point */
function undoNote(plan: { available: boolean; rows?: number; reason?: string }): string {
  if (!journalAvailable()) return ' · no undo point (MCP server not set up by bbdump)';
  return plan.available ? ` · undo point saved (${plan.rows} row(s))` : ` · NO undo point: ${plan.reason}`;
}

/** Records the change in the journal; returns what the tool answers about it */
function journal(params: {
  tool: string; database?: string; sql: string; description: string; rowsAffected: number | null;
  tables: UndoTable[] | null; reason?: string;
}) {
  const active = getActiveConnectionInfo();
  const sameDatabase = !params.database || params.database === active.database;
  const saved = sameDatabase && active.label ? findDatabase(active.label) : null;
  const rows = params.tables ? touchedRows(params.tables) : 0;
  const available = !!params.tables && rows > 0;
  const id = writeEntry({
    client: clientName(),
    tool: params.tool,
    databaseId: saved?.id,
    connection: { label: sameDatabase ? active.label : undefined, host: active.host, port: active.port, database: params.database || active.database, user: active.user },
    sql: params.sql,
    description: params.description,
    rowsAffected: params.rowsAffected,
    undo: {
      available,
      reason: available ? undefined : (params.reason ?? (params.tables ? 'nothing changed' : 'not captured')),
      rows,
      tables: (params.tables ?? []).map(t => `${t.schema}.${t.table}`),
    },
  }, params.tables);
  if (!id) return {};
  return {
    change_id: id,
    undo: available
      ? `Undo point saved: undo_change "${id}" (or the bbdump AI journal) restores the ${rows} row(s) touched.`
      : `No undo point: ${params.reason ?? 'not captured'}.`,
  };
}

/**
 * INSERT for rows with different keys: the union of the columns, a missing key becomes
 * DEFAULT (the column's default, not NULL).
 */
export function buildInsert(schema: string, table: string, rows: Record<string, unknown>[]): { sql: string; params: unknown[] } {
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  const params: unknown[] = [];
  const values = rows.map(row => `(${columns.map(column => {
    if (!Object.prototype.hasOwnProperty.call(row, column)) return 'DEFAULT';
    params.push(toParam(row[column]));
    return `$${params.length}`;
  }).join(', ')})`);
  const sql = pgFormat('INSERT INTO %I.%I', schema, table)
    + ` (${columns.map(c => pgFormat('%I', c)).join(', ')}) VALUES ${values.join(', ')} RETURNING *`;
  return { sql, params };
}

/** The same INSERT, also returning each row as JSON for the undo point */
const withRowJson = (sql: string, schema: string, table: string) =>
  sql.replace(pgFormat('INSERT INTO %I.%I', schema, table), pgFormat('INSERT INTO %I.%I AS t', schema, table))
    .replace(/ RETURNING \*$/, ` RETURNING t.*, row_to_json(t)::text AS ${ROW_JSON}`);

export function registerMutationTools(server: McpServer) {
  server.registerTool(
    'insert_rows',
    {
      title: 'Insert rows',
      description: 'Insert rows into a table (parameterized values). Rows may have different keys: a missing column gets its default value. Objects go to json/jsonb columns, arrays to array columns (for a JSON array in a jsonb column, pass it as a JSON string). Confirmed by the user in the bbdump app; an undo point is saved when the table has a primary key.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        rows: z.array(z.record(cellValue)).min(1).max(5000)
          .describe('Rows to insert, e.g. [{"name": "Alice", "age": 30}]'),
      },
      annotations: WRITE,
    },
    async ({ table, database, schema, rows }) => {
      const nsp = resolveSchema(schema);
      if (rows.every(row => Object.keys(row).length === 0)) return errorResult('Rows must have at least one column');
      const { sql, params } = buildInsert(nsp, table, rows);
      if (params.length > MAX_PARAMS) return errorResult(`Too many values in one call (${params.length}, max ${MAX_PARAMS}): split the rows in several calls.`);

      return withClient(database, async (client) => {
        const pk = await primaryKey(client, nsp, table);
        const plan = !pk ? { available: false, reason: 'the table has no primary key' }
          : rows.length > MAX_UNDO_ROWS ? { available: false, reason: `more than ${MAX_UNDO_ROWS} rows` }
            : { available: true, rows: rows.length };
        const dbName = database || getActiveConnectionInfo().database;
        const description = `INSERT ${rows.length} row(s) into ${nsp}.${table}`;
        const outcome = await requestConfirmation({ tool: 'insert_rows', database: dbName, table, schema: nsp, sql, description: description + undoNote(plan) });
        if (!outcome.approved) return errorResult(refusalMessage(outcome));

        const startTime = Date.now();
        const result = await inWriteTransaction(client, undefined, () => client.query(withRowJson(sql, nsp, table), params as any[]));
        recordQuery({ tool: 'insert_rows', database: dbName, sql, duration_ms: Date.now() - startTime, rows_affected: result.rowCount ?? undefined });
        const tables = plan.available && pk ? [{ schema: nsp, table, primaryKey: pk, before: [], after: result.rows.map((r: any) => r[ROW_JSON]) }] : null;
        return jsonResult({
          inserted: result.rowCount,
          table: `${nsp}.${table}`,
          ...journal({ tool: 'insert_rows', database, sql, description, rowsAffected: result.rowCount, tables, reason: plan.reason }),
          ...returned(result.rows),
        });
      });
    }
  );

  /** Rows a filtered UPDATE/DELETE will touch, shown in the confirmation */
  const countMatching = async (client: Client, nsp: string, table: string, clause: string, params: unknown[]) => {
    const result = await executeReadOnly(client, pgFormat('SELECT count(*)::bigint AS n FROM %I.%I ', nsp, table) + clause, params as any[], 15000);
    return Number(result.rows[0].n);
  };

  server.registerTool(
    'update_rows',
    {
      title: 'Update rows',
      description: 'Update rows matching structured filters (at least one filter, so a whole table is never updated by accident). The bbdump confirmation shows how many rows change; an undo point keeps their previous values.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        set: z.record(cellValue).describe('Columns to update, e.g. {"name": "Bob", "age": 31}'),
        filters: z.array(filterSchema).min(1).describe('Filters selecting the rows to update (at least one)'),
      },
      annotations: WRITE,
    },
    async ({ table, database, schema, set, filters }) => {
      const nsp = resolveSchema(schema);
      const setCols = Object.keys(set);
      if (setCols.length === 0) return errorResult('SET object must have at least one column to update');
      let where;
      try {
        where = buildWhereClause(filters as Filter[]);
      } catch (err: any) {
        return errorResult(err.message);
      }
      const setParams: unknown[] = setCols.map(col => toParam(set[col]));
      const shifted = buildWhereClause(filters as Filter[], setParams.length + 1);
      const setClause = setCols.map((col, i) => `${pgFormat('%I', col)} = $${i + 1}`).join(', ');
      const sql = pgFormat('UPDATE %I.%I AS t SET ', nsp, table) + setClause + ` ${shifted.clause} RETURNING t.*, row_to_json(t)::text AS ${ROW_JSON}`;
      const shownSql = pgFormat('UPDATE %I.%I SET ', nsp, table) + setClause + ` ${shifted.clause}`;

      return withClient(database, async (client) => {
        const matching = await countMatching(client, nsp, table, where.clause, where.params);
        if (matching === 0) return jsonResult({ updated: 0, note: 'No row matches these filters: nothing to update.' });
        const pk = await primaryKey(client, nsp, table);
        const plan = !pk ? { available: false, reason: 'the table has no primary key' }
          : matching * 2 > MAX_UNDO_ROWS ? { available: false, reason: `more than ${MAX_UNDO_ROWS / 2} rows` }
            : { available: true, rows: matching };

        const dbName = database || getActiveConnectionInfo().database;
        const description = `UPDATE ${matching} row(s) in ${nsp}.${table} (SET ${setCols.join(', ')})`;
        const outcome = await requestConfirmation({ tool: 'update_rows', database: dbName, table, schema: nsp, sql: shownSql, description: description + undoNote(plan) });
        if (!outcome.approved) return errorResult(refusalMessage(outcome));

        const startTime = Date.now();
        const { result, before } = await inWriteTransaction(client, undefined, async () => {
          const before = plan.available ? await selectForUndo(client, nsp, table, where.clause, where.params) : [];
          const result = await client.query(sql, [...setParams, ...shifted.params] as any[]);
          return { result, before };
        });
        recordQuery({ tool: 'update_rows', database: dbName, sql: shownSql, duration_ms: Date.now() - startTime, rows_affected: result.rowCount ?? undefined });
        const tables = plan.available && pk ? [{ schema: nsp, table, primaryKey: pk, before, after: result.rows.map((r: any) => r[ROW_JSON]) }] : null;
        return jsonResult({
          updated: result.rowCount,
          table: `${nsp}.${table}`,
          ...journal({ tool: 'update_rows', database, sql: shownSql, description, rowsAffected: result.rowCount, tables, reason: plan.reason }),
          ...returned(result.rows),
        });
      });
    }
  );

  server.registerTool(
    'delete_rows',
    {
      title: 'Delete rows',
      description: 'Delete rows matching structured filters (at least one filter). The bbdump confirmation shows how many rows go; the undo point also keeps the rows that foreign keys delete or change in cascade.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        filters: z.array(filterSchema).min(1).describe('Filters selecting the rows to delete (at least one)'),
      },
      annotations: WRITE,
    },
    async ({ table, database, schema, filters }) => {
      const nsp = resolveSchema(schema);
      let where;
      try {
        where = buildWhereClause(filters as Filter[]);
      } catch (err: any) {
        return errorResult(err.message);
      }
      const sql = pgFormat('DELETE FROM %I.%I ', nsp, table) + where.clause;

      return withClient(database, async (client) => {
        const matching = await countMatching(client, nsp, table, where.clause, where.params);
        if (matching === 0) return jsonResult({ deleted: 0, note: 'No row matches these filters: nothing to delete.' });
        const pk = await primaryKey(client, nsp, table);
        const plan = !pk ? { available: false, reason: 'the table has no primary key' }
          : matching > MAX_UNDO_ROWS ? { available: false, reason: `more than ${MAX_UNDO_ROWS} rows` }
            : { available: true, rows: matching };

        const dbName = database || getActiveConnectionInfo().database;
        const description = `DELETE ${matching} row(s) from ${nsp}.${table}`;
        const outcome = await requestConfirmation({ tool: 'delete_rows', database: dbName, table, schema: nsp, sql, description: description + undoNote(plan) });
        if (!outcome.approved) return errorResult(refusalMessage(outcome));

        const startTime = Date.now();
        let reason = plan.reason;
        const { result, tables } = await inWriteTransaction(client, undefined, async () => {
          let capture: Awaited<ReturnType<typeof captureDelete>> | null = null;
          if (plan.available && pk) {
            try {
              capture = await captureDelete(client, nsp, table, pk, await selectForUndo(client, nsp, table, where.clause, where.params));
            } catch (err) {
              if (!(err instanceof UndoUnavailable)) throw err;
              reason = err.message;
            }
          }
          const result = await client.query(pgFormat('DELETE FROM %I.%I AS t ', nsp, table) + where.clause + ` RETURNING t.*`, where.params as any[]);
          return { result, tables: capture ? await capture.complete() : null };
        });
        recordQuery({ tool: 'delete_rows', database: dbName, sql, duration_ms: Date.now() - startTime, rows_affected: result.rowCount ?? undefined });
        const cascaded = (tables ?? []).slice(1).filter(t => t.before.length);
        return jsonResult({
          deleted: result.rowCount,
          table: `${nsp}.${table}`,
          ...(cascaded.length ? { also_changed_by_foreign_keys: cascaded.map(t => `${t.schema}.${t.table}: ${t.before.length} row(s)`) } : {}),
          ...journal({ tool: 'delete_rows', database, sql, description, rowsAffected: result.rowCount, tables, reason }),
          ...returned(result.rows),
        });
      });
    }
  );

  server.registerTool(
    'execute_write_query',
    {
      title: 'Run a write query',
      description: 'Run SQL that changes data or schema (INSERT, UPDATE, DELETE, CREATE, ALTER, migrations…), in one transaction rolled back on error. Several statements are allowed. dry_run runs ONE statement and rolls it back, to preview its effect. Confirmed by the user in the bbdump app. A single INSERT/UPDATE/DELETE gets an undo point (rows it changes, cascades included, up to 20 000); for anything else (DDL, several statements), offer create_backup first.',
      inputSchema: {
        sql: z.string().describe('SQL to run'),
        database: databaseParam,
        timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(60000).describe('Statement timeout in milliseconds (default 60000, max 600000)'),
        dry_run: z.boolean().default(false).describe('Run one statement inside a transaction that is rolled back: nothing is changed'),
      },
      annotations: WRITE,
    },
    async ({ sql, database, timeout_ms, dry_run }) => {
      const statements = statementCount(sql);
      if (dry_run && statements > 1) {
        return errorResult('dry_run takes ONE statement (so it cannot be committed by a statement inside it). Run each statement separately, or without dry_run.');
      }

      return withClient(database, async (client) => {
        // Undo point for one INSERT/UPDATE/DELETE: rows watched by a temporary trigger, or
        // (when triggers are not allowed) the whole table compared if it is small
        let plan: { available: boolean; rows?: number; reason?: string } = { available: false, reason: 'only a single INSERT, UPDATE or DELETE gets one; use create_backup' };
        let target: { schema: string; table: string; pk: string[]; small: boolean } | null = null;
        const keyword = findWriteKeyword(sql);
        if (!dry_run && statements === 1 && (keyword === 'INSERT' || keyword === 'UPDATE' || keyword === 'DELETE')) {
          try {
            const found = await modifiedTable(client, sql);
            const pk = found ? await primaryKey(client, found.schema, found.table) : null;
            if (!found) plan = { available: false, reason: 'the modified table could not be found' };
            else if (!pk) plan = { available: false, reason: `${found.schema}.${found.table} has no primary key` };
            else {
              const size = await client.query(pgFormat('SELECT count(*)::int AS n FROM (SELECT 1 FROM %I.%I LIMIT %s) s', found.schema, found.table, MAX_UNDO_ROWS + 1));
              target = { ...found, pk, small: size.rows[0].n <= MAX_UNDO_ROWS };
              plan = { available: true };
            }
          } catch {
            plan = { available: false, reason: 'the statement could not be analyzed' };
          }
        }

        const dbName = database || getActiveConnectionInfo().database;
        // What the query does, in its own words: its first line, shortened
        const firstLine = sql.trim().split('\n')[0].replace(/\s+/g, ' ');
        const summary = firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine;
        const description = dry_run
          ? `[DRY RUN, rolled back] ${summary}`
          : `${summary}${statements > 1 ? ` (+${statements - 1} statement${statements > 2 ? 's' : ''})` : ''}`;
        const outcome = await requestConfirmation({
          tool: 'execute_write_query',
          database: dbName,
          sql,
          description: description + (dry_run ? '' : plan.available ? ' · undo point saved (rows it changes)' : undoNote(plan)),
        });
        if (!outcome.approved) return errorResult(refusalMessage(outcome));

        const startTime = Date.now();
        let tables: UndoTable[] | null = null;
        let result: pg.QueryResult & { statements?: number };
        if (dry_run) {
          result = await executeDryRun(client, sql, undefined, timeout_ms);
        } else {
          result = await inWriteTransaction(client, timeout_ms, async () => {
            let capture: Awaited<ReturnType<typeof startTriggerCapture>> | null = null;
            let before: Map<string, string> | null = null;
            if (target) {
              try {
                capture = await startTriggerCapture(client, target.schema, target.table);
              } catch (err) {
                if (!(err instanceof UndoUnavailable)) throw err;
                if (target.small) before = await snapshotTable(client, target.schema, target.table, target.pk);
                else plan = { available: false, reason: `${err.message}; ${target.schema}.${target.table} is too large to compare` };
              }
            }
            const raw = await client.query(sql) as pg.QueryResult | pg.QueryResult[];
            const last = Array.isArray(raw) ? Object.assign(raw[raw.length - 1] ?? { rows: [], fields: [], rowCount: 0 }, { statements: raw.length }) : raw;
            if (capture) {
              try {
                tables = await capture.finish();
              } catch (err) {
                if (!(err instanceof UndoUnavailable)) throw err;
                plan = { available: false, reason: err.message };
              }
            } else if (target && before) {
              const after = await snapshotTable(client, target.schema, target.table, target.pk);
              tables = [diffSnapshots(target.schema, target.table, target.pk, before, after)];
            }
            return last as pg.QueryResult & { statements?: number };
          });
        }
        const duration = Date.now() - startTime;
        recordQuery({
          tool: 'execute_write_query',
          database: dbName,
          sql: dry_run ? `[DRY RUN] ${sql}` : sql,
          duration_ms: duration,
          rows_affected: result.rowCount ?? undefined,
        });
        return jsonResult({
          command: result.command,
          affected_rows: result.rowCount,
          fields: result.fields?.map(f => f.name) || [],
          ...(dry_run ? {} : journal({ tool: 'execute_write_query', database, sql, description, rowsAffected: result.rowCount, tables, reason: plan.reason })),
          ...returned(result.rows || []),
          duration_ms: duration,
          dry_run,
          ...(statements > 1 ? { statements, note: 'Several statements: the result is the last one\'s.' } : {}),
          ...(dry_run ? { note: 'Transaction rolled back: nothing was changed.' } : {}),
        });
      });
    }
  );

  server.registerTool(
    'list_changes',
    {
      title: 'List AI changes',
      description: 'Changes made through this MCP server (any session), newest first: tool, SQL, rows, client, and whether an undo point exists. Default: the active database.',
      inputSchema: {
        all_databases: z.boolean().default(false).describe('Changes on every database'),
        limit: z.number().int().min(1).max(200).default(20).describe('Number of changes (default 20)'),
      },
      annotations: READ,
    },
    async ({ all_databases, limit }) => {
      if (!journalAvailable()) return errorResult('The change journal needs the MCP server set up by bbdump (Settings → MCP).');
      const active = getActiveConnectionInfo();
      const saved = active.label ? findDatabase(active.label) : null;
      const entries = listEntries(all_databases ? {} : saved ? { databaseId: saved.id } : { database: active.database }, limit);
      return jsonResult({
        changes: entries.map(e => ({
          change_id: e.id, at: e.createdAt, tool: e.tool, client: e.client, database: e.connection.label ?? e.connection.database,
          description: e.description, rows_affected: e.rowsAffected,
          undo: e.undoneAt ? `undone at ${e.undoneAt}` : e.undo.available ? `available (${e.undo.rows} rows)` : `none: ${e.undo.reason}`,
          sql: e.sql.length > 300 ? `${e.sql.slice(0, 300)}…` : e.sql,
        })),
        count: entries.length,
      });
    }
  );

  server.registerTool(
    'undo_change',
    {
      title: 'Undo an AI change',
      description: 'Undo a change listed by list_changes: rows inserted are deleted, rows updated or deleted get their previous values back, in one transaction. bbdump checks first that those rows were not changed since (else it refuses and says which), and asks the user to confirm.',
      inputSchema: { change_id: z.string().describe('change_id from list_changes or from the answer of the change') },
      annotations: WRITE,
    },
    async ({ change_id }) => {
      try {
        const result = await appApi<{ success: boolean; error?: string; conflicts?: unknown[]; restored?: Record<string, unknown>; refused?: boolean }>(
          'POST', '/undo', { id: change_id }, 5 * 60 * 1000,
        );
        if (result.refused) return errorResult('The user refused to undo this change in bbdump.');
        if (!result.success) {
          return errorResult(`Could not undo ${change_id}: ${result.error ?? 'unknown error'}${result.conflicts?.length ? ` — rows changed since: ${JSON.stringify(result.conflicts).slice(0, 600)}` : ''}`);
        }
        return jsonResult({ change_id, undone: true, ...result.restored });
      } catch (err: any) {
        return errorResult(err.message);
      }
    }
  );
}

/**
 * Undo points: the rows a change touches, read inside the change's own transaction
 * (FOR UPDATE), before and after. Rows are kept as row_to_json text, so every type
 * round-trips through json_populate_recordset when the bbdump app undoes the change.
 */
import pg from 'pg';
import pgFormat from 'pg-format';
import { MAX_UNDO_ROWS, type UndoTable } from './journal.js';

type Client = pg.PoolClient;

export class UndoUnavailable extends Error {}

const json = (rows: string[]) => `[${rows.join(',')}]`;
const cols = (alias: string, names: string[]) => names.map(n => pgFormat(`${alias}.%I`, n)).join(', ');

/** Primary key columns, in order, or null */
export async function primaryKey(client: Client, schema: string, table: string): Promise<string[] | null> {
  const result = await client.query(`
    SELECT ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'p' AND n.nspname = $1 AND c.relname = $2`, [schema, table]);
  return result.rows[0]?.cols ?? null;
}

interface ChildKey { schema: string; table: string; columns: string[]; refColumns: string[]; action: 'c' | 'n' | 'd' }

/** Foreign keys of other tables that react to a DELETE here (CASCADE, SET NULL, SET DEFAULT) */
async function reactingChildren(client: Client, schema: string, table: string): Promise<ChildKey[]> {
  const result = await client.query(`
    SELECT n.nspname AS schema, c.relname AS table, con.confdeltype AS action,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ref_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE con.contype = 'f' AND con.confdeltype IN ('c', 'n', 'd') AND pn.nspname = $1 AND p.relname = $2`, [schema, table]);
  return result.rows.map((r: any) => ({ schema: r.schema, table: r.table, columns: r.columns, refColumns: r.ref_columns, action: r.action }));
}

/** Rows of `where` in a table, locked for the rest of the transaction */
export async function selectForUndo(client: Client, schema: string, table: string, where: string, params: unknown[]): Promise<string[]> {
  const result = await client.query(pgFormat('SELECT row_to_json(t)::text AS j FROM %I.%I t ', schema, table) + where + ' FOR UPDATE OF t', params as any[]);
  return result.rows.map((r: any) => r.j);
}

/** The same rows again (by primary key), e.g. after a SET NULL cascade changed them */
async function reselect(client: Client, t: UndoTable): Promise<string[]> {
  const result = await client.query(pgFormat(
    'SELECT row_to_json(t)::text AS j FROM %I.%I t WHERE (%s) IN (SELECT %s FROM json_populate_recordset(NULL::%I.%I, $1::json) r)',
    t.schema, t.table, cols('t', t.primaryKey), cols('r', t.primaryKey), t.schema, t.table,
  ), [json(t.before)]);
  return result.rows.map((r: any) => r.j);
}

/** Total rows held by an undo point (before + after states: what the size limit counts) */
export const undoSize = (tables: UndoTable[]) => tables.reduce((n, t) => n + t.before.length + t.after.length, 0);

/** Distinct rows a change touched (an updated row has a before and an after state) */
export function touchedRows(tables: UndoTable[]): number {
  return tables.reduce((n, t) => {
    const keys = new Set([...t.before, ...t.after].map(row => {
      const parsed = JSON.parse(row);
      return JSON.stringify(t.primaryKey.map(c => parsed[c]));
    }));
    return n + keys.size;
  }, 0);
}

/**
 * Before a DELETE: the target rows plus every row the foreign keys will delete (CASCADE,
 * followed down) or change (SET NULL / SET DEFAULT). Returns the tables, parents first,
 * and a function to call after the DELETE to read the changed children again.
 */
export async function captureDelete(client: Client, schema: string, table: string, pk: string[], targetRows: string[]) {
  const tables: UndoTable[] = [{ schema, table, primaryKey: pk, before: targetRows, after: [] }];
  const changed: UndoTable[] = [];
  const queue: Array<{ t: UndoTable; depth: number }> = [{ t: tables[0], depth: 0 }];
  const byName = new Map<string, UndoTable>([[`${schema}.${table}`, tables[0]]]);

  while (queue.length) {
    const { t: parent, depth } = queue.shift()!;
    if (parent.before.length === 0) continue;
    if (depth > 8) throw new UndoUnavailable('foreign keys cascade too deep');
    for (const fk of await reactingChildren(client, parent.schema, parent.table)) {
      const rows = (await client.query(pgFormat(
        'SELECT row_to_json(c)::text AS j FROM %I.%I c WHERE (%s) IN (SELECT %s FROM json_populate_recordset(NULL::%I.%I, $1::json) p) FOR UPDATE OF c',
        fk.schema, fk.table, cols('c', fk.columns), cols('p', fk.refColumns), parent.schema, parent.table,
      ), [json(parent.before)])).rows.map((r: any) => r.j as string);
      if (rows.length === 0) continue;
      const childPk = await primaryKey(client, fk.schema, fk.table);
      if (!childPk) throw new UndoUnavailable(`${fk.schema}.${fk.table} (changed by a foreign key) has no primary key`);
      const name = `${fk.schema}.${fk.table}`;
      let child = byName.get(name);
      if (!child) {
        child = { schema: fk.schema, table: fk.table, primaryKey: childPk, before: [], after: [] };
        byName.set(name, child);
        tables.push(child);
      }
      const known = new Set(child.before);
      const fresh = rows.filter(r => !known.has(r));
      child.before.push(...fresh);
      if (undoSize(tables) > MAX_UNDO_ROWS) throw new UndoUnavailable(`more than ${MAX_UNDO_ROWS} rows involved`);
      if (fk.action === 'c') queue.push({ t: { ...child, before: fresh }, depth: depth + 1 });
      else if (!changed.includes(child)) changed.push(child);
    }
  }

  return {
    tables,
    /** After the DELETE: SET NULL / SET DEFAULT children still exist, with new values */
    async complete() {
      for (const t of changed) t.after = await reselect(client, t);
      return tables;
    },
  };
}

/** Target of a single INSERT/UPDATE/DELETE statement, from its plan (nothing runs) */
export async function modifiedTable(client: Client, sql: string, params?: unknown[]): Promise<{ schema: string; table: string } | null> {
  const plan = await client.query({ text: `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, values: params ?? [], queryMode: 'extended' } as pg.QueryConfig);
  const root = plan.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
  if (root?.['Node Type'] !== 'ModifyTable' || !root['Relation Name']) return null;
  return { schema: root.Schema, table: root['Relation Name'] };
}

/** Every row of a (small) table, keyed by primary key */
export async function snapshotTable(client: Client, schema: string, table: string, pk: string[]): Promise<Map<string, string>> {
  const key = pk.map(c => pgFormat('t.%I::text', c)).join(` || chr(31) || `);
  const result = await client.query(pgFormat('SELECT row_to_json(t)::text AS j, %s AS k FROM %I.%I t', key, schema, table));
  return new Map(result.rows.map((r: any) => [r.k as string, r.j as string]));
}

/** Tables whose rows a DELETE on this table also changes (CASCADE, SET NULL, SET DEFAULT), followed down */
async function reactingTables(client: Client, schema: string, table: string): Promise<Array<{ schema: string; table: string }>> {
  const seen = new Map<string, { schema: string; table: string }>([[`${schema}.${table}`, { schema, table }]]);
  const queue = [{ schema, table, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > 8) break;
    for (const fk of await reactingChildren(client, current.schema, current.table)) {
      const name = `${fk.schema}.${fk.table}`;
      if (seen.has(name)) continue;
      seen.set(name, { schema: fk.schema, table: fk.table });
      if (fk.action === 'c') queue.push({ schema: fk.schema, table: fk.table, depth: current.depth + 1 });
    }
  }
  return [...seen.values()];
}

/**
 * Captures every row a statement changes in a table (and the tables its foreign keys
 * change in cascade), whatever their size: a row trigger, created inside the transaction
 * and dropped before COMMIT, copies OLD and NEW rows into a temporary table. Needs to own
 * the tables (or the TRIGGER privilege): throws otherwise, and the caller falls back.
 */
export async function startTriggerCapture(client: Client, schema: string, table: string) {
  const tables = await reactingTables(client, schema, table);
  const keys: Array<{ schema: string; table: string; pk: string[] }> = [];
  for (const t of tables) {
    const pk = await primaryKey(client, t.schema, t.table);
    if (!pk) throw new UndoUnavailable(`${t.schema}.${t.table} has no primary key`);
    keys.push({ ...t, pk });
  }
  await client.query('SAVEPOINT bbdump_capture');
  try {
    await client.query('CREATE TEMP TABLE IF NOT EXISTS bbdump_undo_rows (rel text, old_row text, new_row text) ON COMMIT DROP');
    await client.query('DELETE FROM bbdump_undo_rows');
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.bbdump_capture() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO bbdump_undo_rows VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
          CASE WHEN TG_OP <> 'INSERT' THEN row_to_json(OLD)::text END,
          CASE WHEN TG_OP <> 'DELETE' THEN row_to_json(NEW)::text END);
        RETURN NULL;
      END $fn$`);
    for (const t of keys) {
      await client.query(pgFormat('CREATE TRIGGER bbdump_undo_capture AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION pg_temp.bbdump_capture()', t.schema, t.table));
    }
    await client.query('RELEASE SAVEPOINT bbdump_capture');
  } catch (err) {
    // Not the owner, or another blocker: the transaction goes on without this capture
    await client.query('ROLLBACK TO SAVEPOINT bbdump_capture');
    throw new UndoUnavailable(`cannot watch the rows (${(err as Error).message})`);
  }

  return {
    /** After the statement: removes the triggers and returns the rows, parents first */
    async finish(): Promise<UndoTable[]> {
      for (const t of keys) await client.query(pgFormat('DROP TRIGGER bbdump_undo_capture ON %I.%I', t.schema, t.table));
      const count = Number((await client.query('SELECT count(*) AS n FROM bbdump_undo_rows')).rows[0].n);
      if (count > MAX_UNDO_ROWS) throw new UndoUnavailable(`more than ${MAX_UNDO_ROWS} rows changed`);
      const rows = (await client.query('SELECT rel, old_row, new_row FROM bbdump_undo_rows')).rows as Array<{ rel: string; old_row: string | null; new_row: string | null }>;
      return keys.map(t => {
        const mine = rows.filter(r => r.rel === `${t.schema}.${t.table}`);
        return {
          schema: t.schema,
          table: t.table,
          primaryKey: t.pk,
          before: mine.map(r => r.old_row).filter((r): r is string => r !== null),
          after: mine.map(r => r.new_row).filter((r): r is string => r !== null),
        };
      }).filter(t => t.before.length || t.after.length);
    },
  };
}

/** Rows that differ between two snapshots: their before and after states */
export function diffSnapshots(schema: string, table: string, pk: string[], before: Map<string, string>, after: Map<string, string>): UndoTable {
  const t: UndoTable = { schema, table, primaryKey: pk, before: [], after: [] };
  for (const [key, row] of before) {
    const now = after.get(key);
    if (now === undefined) t.before.push(row);
    else if (now !== row) { t.before.push(row); t.after.push(now); }
  }
  for (const [key, row] of after) if (!before.has(key)) t.after.push(row);
  return t;
}

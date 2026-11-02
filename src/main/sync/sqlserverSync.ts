/**
 * "Update from…" for SQL Server: what the target lacks compared to the source (schemas,
 * sequences, tables, columns, indexes, checks, foreign keys, views, functions, procedures and
 * triggers), then the rows missing there, found by primary key and anonymized while they pass.
 * The catalogs are read as a backup reads them (engines/sqlserver.ts), the rows as exact text
 * (decimals, dates), so keys read on both sides compare as they are.
 */
import type { ConnectionPool, Transaction } from 'mssql';
import { quoteIdent } from '../../shared/engines/sqlGuard';
import { pgTypeOf } from '../sqlMasking';
import { sqlserverInternals as ms, type SqlServerColumn, type SqlServerIndex, type SqlServerLine } from '../engines/sqlserver';
import type { Catalog, CatalogTable } from './catalog';
import { PHASE, type SchemaChange } from './schemaDiff';
import { anonymizationCandidates, columnLength, dependencyOrder, distinctFakes, timeColumn, type AnonymizeCandidate, type AnonymizeKind } from './dataSync';
import { fakeValue } from './fakeValues';
import type { SyncChoices, SyncProgress, SyncResult, TablePlan } from './syncEngine';

type TableLine = Extract<SqlServerLine, { t: 'table' }>;
type CheckLine = Extract<SqlServerLine, { t: 'check' }>;
type FkLine = Extract<SqlServerLine, { t: 'fk' }>;
type ModuleLine = Extract<SqlServerLine, { t: 'module' }>;
type SequenceLine = Extract<SqlServerLine, { t: 'sequence' }>;
type RowsLine = Extract<SqlServerLine, { t: 'rows' }>;

const q = (name: string) => quoteIdent(name, 'tsql');
const keyOf = (schema: string, name: string) => `${schema}.${name}`;

interface MsTable { key: string; line: TableLine; rows: number; indexes: SqlServerIndex[]; checks: CheckLine[]; fks: FkLine[] }

export interface MsCatalog {
  schemas: Set<string>;
  sequences: SequenceLine[];
  tables: Map<string, MsTable>;
  modules: ModuleLine[];
}

/** Missing rows found key by key up to this many source rows; a count difference beyond */
const EXACT_LIMIT = 50000;
const LARGE_TABLE = 1_000_000;

// --- Catalog -----------------------------------------------------------------------------------------

/** The catalog of a database (no rows), and its tables' row counts (exact under a million) */
async function readCatalog(pool: ConnectionPool): Promise<MsCatalog> {
  const lines: SqlServerLine[] = [];
  await ms.writeBackup(pool, async line => { lines.push(line); }, '', { rows: false });
  const catalog: MsCatalog = { schemas: new Set(['dbo']), sequences: [], tables: new Map(), modules: [] };
  for (const line of lines) {
    if (line.t === 'schema') catalog.schemas.add(line.name);
    else if (line.t === 'sequence') catalog.sequences.push(line);
    else if (line.t === 'table') catalog.tables.set(keyOf(line.schema, line.name), { key: keyOf(line.schema, line.name), line, rows: 0, indexes: [], checks: [], fks: [] });
    else if (line.t === 'index') catalog.tables.get(keyOf(line.schema, line.table))?.indexes.push(line.index);
    else if (line.t === 'check') catalog.tables.get(keyOf(line.schema, line.table))?.checks.push(line);
    else if (line.t === 'fk') catalog.tables.get(keyOf(line.schema, line.table))?.fks.push(line);
    else if (line.t === 'module') catalog.modules.push(line);
  }
  const { recordset } = await ms.run(pool, `
    SELECT SCHEMA_NAME(t.schema_id) AS s, t.name, SUM(p.rows) AS n FROM sys.tables t
    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    WHERE t.is_ms_shipped = 0 GROUP BY t.schema_id, t.name`);
  for (const row of recordset) {
    const table = catalog.tables.get(keyOf(String(row.s), String(row.name)));
    if (!table) continue;
    const estimate = Number(row.n ?? 0);
    table.rows = estimate <= LARGE_TABLE
      ? Number((await ms.run(pool, `SELECT COUNT_BIG(*) AS n FROM ${ms.qualified(table.line.schema, table.line.name)}`)).recordset[0]?.n ?? 0)
      : estimate;
  }
  return catalog;
}

/** A column's type as the anonymization rules know it (text of n characters: character varying(n)) */
function pgColumnType(c: SqlServerColumn): string {
  const type = pgTypeOf(c.type, c.base === 'bit' ? 'bool' : undefined);
  const length = /^n?(var)?char\((\d+)\)$/i.exec(c.type)?.[2];
  return type === 'text' && length ? `character varying(${length})` : type;
}

/** The catalog in PostgreSQL's shape, for the shared anonymization and ordering rules */
export function pgShapeOf(catalog: MsCatalog): Catalog {
  const tables = new Map<string, CatalogTable>();
  for (const t of catalog.tables.values()) {
    const pk = t.line.primaryKey?.columns.map(c => c.name) ?? null;
    tables.set(t.key, {
      schema: t.line.schema,
      name: t.line.name,
      key: t.key,
      partitioned: false,
      partitionKey: null,
      estimate: t.rows,
      columns: t.line.columns.map(c => ({
        name: c.name,
        type: pgColumnType(c),
        notNull: !c.nullable,
        default: c.default?.definition ?? null,
        identity: c.identity ? 'd' : '',
        generated: !!c.computed || c.rowversion,
      })),
      primaryKey: pk?.length ? pk : null,
      constraints: [
        ...(pk?.length ? [{ name: t.line.primaryKey!.name, type: 'p' as const, definition: '', columns: pk, refColumns: [] }] : []),
        ...t.indexes.filter(i => i.unique && !i.filter).map(i => ({ name: i.name, type: 'u' as const, definition: '', columns: i.columns.map(c => c.name), refColumns: [] })),
        ...t.fks.map(f => ({ name: f.name, type: 'f' as const, definition: '', references: keyOf(f.refSchema, f.refTable), columns: f.columns, refColumns: f.refColumns })),
      ],
      indexes: [],
      triggers: [],
      comment: null,
    });
  }
  return { serverVersion: 0, schemas: [...catalog.schemas], extensions: [], enums: new Map(), tables, sequences: new Set(), views: new Map(), functions: new Map() };
}

// --- Schema ------------------------------------------------------------------------------------------

/** A column as written in CREATE TABLE / ADD (as the backup's restore writes it) */
function columnSql(c: SqlServerColumn, nullable = c.nullable): string {
  if (c.computed) return `${q(c.name)} AS ${c.computed.definition}${c.computed.persisted ? ' PERSISTED' : ''}`;
  const parts = [q(c.name), c.rowversion ? 'rowversion' : c.type];
  if (c.collation && /char|text/i.test(c.base)) parts.push(`COLLATE ${c.collation}`);
  if (c.sparse) parts.push('SPARSE');
  if (c.identity) parts.push(`IDENTITY(${c.identity.seed}, ${c.identity.increment})`);
  if (c.rowguid) parts.push('ROWGUIDCOL');
  parts.push(nullable ? 'NULL' : 'NOT NULL');
  if (c.default) parts.push(`CONSTRAINT ${q(c.default.name)} DEFAULT ${c.default.definition}`);
  return parts.join(' ');
}

const checkSql = (c: CheckLine) => `ALTER TABLE ${ms.qualified(c.schema, c.table)} WITH ${c.trusted ? 'CHECK' : 'NOCHECK'} ADD CONSTRAINT ${q(c.name)} CHECK ${c.definition}`;
const fkSql = (f: FkLine) => `ALTER TABLE ${ms.qualified(f.schema, f.table)} WITH ${f.trusted ? 'CHECK' : 'NOCHECK'} ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${ms.qualified(f.refSchema, f.refTable)} (${f.refColumns.map(q).join(', ')}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`;

const MODULE_KIND: Record<string, { kind: SchemaChange['kind']; phase: number }> = {
  V: { kind: 'view', phase: PHASE.view },
  FN: { kind: 'function', phase: PHASE.function },
  IF: { kind: 'function', phase: PHASE.function },
  TF: { kind: 'function', phase: PHASE.function },
  P: { kind: 'procedure', phase: PHASE.view },
  TR: { kind: 'trigger', phase: PHASE.trigger },
};

/** What the target lacks compared to the source, as changes to apply to the target */
export function diffSqlServer(source: MsCatalog, target: MsCatalog): SchemaChange[] {
  const out: SchemaChange[] = [];
  const add = (change: Omit<SchemaChange, 'id' | 'defaultSelected'> & { defaultSelected?: boolean }) =>
    out.push({ ...change, id: `${change.kind}:${change.object}`, defaultSelected: change.defaultSelected ?? !change.destructive });

  for (const schema of source.schemas) {
    if (!target.schemas.has(schema)) add({ kind: 'schema', object: schema, sql: [`CREATE SCHEMA ${q(schema)}`], destructive: false, phase: PHASE.schema });
  }
  for (const s of source.sequences) {
    if (target.sequences.some(t => t.schema === s.schema && t.name === s.name)) continue;
    const next = s.current === null ? s.start : (BigInt(s.current) + BigInt(s.increment)).toString();
    const start = BigInt(next) >= BigInt(s.min) && BigInt(next) <= BigInt(s.max) ? next : s.start;
    add({
      kind: 'sequence', object: keyOf(s.schema, s.name), destructive: false, phase: PHASE.enum,
      sql: [`CREATE SEQUENCE ${ms.qualified(s.schema, s.name)} AS ${s.type} START WITH ${start} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`],
    });
  }
  for (const t of source.tables.values()) {
    const local = target.tables.get(t.key);
    if (!local) {
      add({ kind: 'table', object: t.key, sql: [ms.createTableSql(t.line), ...t.indexes.map(index => ms.createIndexSql({ t: 'index', schema: t.line.schema, table: t.line.name, index })), ...t.checks.map(checkSql)], destructive: false, phase: PHASE.table });
      for (const f of t.fks) add({ kind: 'foreign_key', object: `${t.key}.${f.name}`, sql: [fkSql(f)], destructive: false, phase: PHASE.foreignKey });
      continue;
    }
    for (const c of t.line.columns) {
      if (local.line.columns.some(l => l.name === c.name)) continue;
      // A NOT NULL column with no default cannot be added to a table that has rows: added nullable
      const relaxed = !c.nullable && !c.default && !c.identity && !c.computed && !c.rowversion;
      add({
        kind: 'column', object: `${t.key}.${c.name}`, sql: [`ALTER TABLE ${ms.qualified(t.line.schema, t.line.name)} ADD ${columnSql(c, relaxed ? true : c.nullable)}`], destructive: false, phase: PHASE.table,
        ...(relaxed ? { note: 'added without NOT NULL (no default)', noteCode: 'added_nullable' as const } : {}),
      });
    }
    for (const index of t.indexes) {
      if (local.indexes.some(l => l.name === index.name)) continue;
      add({
        kind: 'index', object: `${t.key}.${index.name}`, sql: [ms.createIndexSql({ t: 'index', schema: t.line.schema, table: t.line.name, index })], destructive: false, phase: PHASE.index,
        ...(index.unique ? { note: 'existing rows must be unique', noteCode: 'must_satisfy' as const } : {}),
      });
    }
    for (const c of t.checks) {
      if (local.checks.some(l => l.name === c.name)) continue;
      add({ kind: 'constraint', object: `${t.key}.${c.name}`, sql: [checkSql(c)], destructive: false, phase: PHASE.constraint, note: 'existing rows must satisfy it', noteCode: 'must_satisfy' });
    }
    for (const f of t.fks) {
      if (local.fks.some(l => l.name === f.name)) continue;
      add({ kind: 'foreign_key', object: `${t.key}.${f.name}`, sql: [fkSql(f)], destructive: false, phase: PHASE.foreignKey, note: 'existing rows must satisfy it', noteCode: 'must_satisfy' });
    }
  }
  for (const m of source.modules) {
    if (target.modules.some(l => l.schema === m.schema && l.name === m.name)) continue;
    const { kind, phase } = MODULE_KIND[m.kind] ?? MODULE_KIND.V;
    // Its SET options as it was created with, then CREATE … alone in its batch
    add({ kind, object: keyOf(m.schema, m.name), sql: [`SET QUOTED_IDENTIFIER ${m.quotedIdentifier ? 'ON' : 'OFF'}; SET ANSI_NULLS ${m.ansiNulls ? 'ON' : 'OFF'};`, m.definition, 'SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON;'], destructive: false, phase });
  }
  for (const t of target.tables.values()) {
    if (source.tables.has(t.key)) continue;
    add({ kind: 'local_only_table', object: t.key, sql: [`DROP TABLE ${ms.qualified(t.line.schema, t.line.name)}`], destructive: true, phase: PHASE.drop, note: 'only in the local database', noteCode: 'local_only' });
  }
  return out.sort((a, b) => a.phase - b.phase || a.object.localeCompare(b.object));
}

// --- Rows --------------------------------------------------------------------------------------------

/** A row's key as text: the values as the backup reads them (exact text for decimals and dates) */
const keyText = (values: unknown[]) => JSON.stringify(values.map(v => (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v).toString() : v ?? null)));

/** The keys of a table's rows (read in `reader`: a transaction or a pool) */
async function keySet(reader: ConnectionPool | Transaction, t: MsTable, pk: string[]): Promise<Set<string>> {
  const columns = pk.map(name => t.line.columns.find(c => c.name === name)!);
  const keys = new Set<string>();
  await ms.dumpRows(reader, t.line.schema, t.line.name, columns, async line => {
    if (line.t === 'rows') for (const row of line.rows) keys.add(keyText(row));
  });
  return keys;
}

/** A consistent read of the source for the whole of `fn` (snapshot isolation, when the database allows it) */
async function inSnapshot<T>(pool: ConnectionPool, fn: (reader: ConnectionPool | Transaction) => Promise<T>): Promise<T> {
  const tx = await ms.snapshotTransaction(pool);
  if (!tx) return fn(pool);
  try {
    return await fn(tx);
  } finally {
    await ms.endSnapshot(tx);
  }
}

export interface SqlServerSyncAnalysis { schema: SchemaChange[]; tables: TablePlan[]; anonymize: AnonymizeCandidate[] }

/** What the target lacks; the keys are "<schema>.<table>" */
export async function analyzeSqlServerSync(sourceId: string, targetId: string): Promise<SqlServerSyncAnalysis> {
  const sourcePool = await ms.poolFor(await ms.saved(sourceId));
  const targetPool = await ms.poolFor(await ms.saved(targetId));
  const src = await readCatalog(sourcePool);
  const tgt = await readCatalog(targetPool);
  const shaped = pgShapeOf(src);
  const tables: TablePlan[] = [];
  await inSnapshot(sourcePool, async reader => {
    for (const t of src.tables.values()) {
      const local = tgt.tables.get(t.key);
      const pk = t.line.primaryKey?.columns.map(c => c.name) ?? null;
      const pgTable = shaped.tables.get(t.key)!;
      const plan: TablePlan = {
        key: t.key, newTable: !local, primaryKey: pk, sourceRows: t.rows, localRows: local?.rows ?? 0,
        missing: null, missingExact: false, timeColumn: timeColumn(pgTable), defaultSelected: false,
      };
      if (!pk) plan.reason = 'no_primary_key';
      else if (!local || local.rows === 0) { plan.missing = t.rows; plan.missingExact = true; }
      else if (t.rows <= EXACT_LIMIT && local.line.primaryKey?.columns.map(c => c.name).join() === pk.join()) {
        const have = await keySet(targetPool, local, pk);
        let missing = 0;
        for (const key of await keySet(reader, t, pk)) if (!have.has(key)) missing++;
        plan.missing = missing;
        plan.missingExact = true;
      } else {
        plan.missing = Math.max(0, t.rows - local.rows);
      }
      if (plan.primaryKey && plan.missing === 0 && plan.missingExact) plan.reason = 'up_to_date';
      if (plan.primaryKey && t.rows > LARGE_TABLE) plan.reason = 'too_large';
      plan.defaultSelected = !!plan.primaryKey && !!plan.missing && t.rows <= LARGE_TABLE;
      tables.push(plan);
    }
  });
  return {
    schema: diffSqlServer(src, tgt),
    tables: tables.sort((a, b) => a.key.localeCompare(b.key)),
    anonymize: [...shaped.tables.values()].flatMap(anonymizationCandidates),
  };
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) of `days` ago */
const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

/** Inserts the rows of a line; a statement refused as a whole is retried row by row (the rows that fail are skipped) */
async function insertMissing(tx: Transaction, table: string, line: RowsLine, columns: SqlServerColumn[], identity: boolean): Promise<{ written: number; skipped: number }> {
  if (!line.rows.length) return { written: 0, skipped: 0 };
  try {
    await ms.insertRows(tx, table, line, columns, identity);
    return { written: line.rows.length, skipped: 0 };
  } catch (error) {
    if (await ms.transactionState(tx) !== 1) throw error;
  }
  let written = 0;
  let skipped = 0;
  for (const row of line.rows) {
    try {
      await ms.insertRows(tx, table, { ...line, rows: [row] }, columns, identity);
      written++;
    } catch (error) {
      if (await ms.transactionState(tx) !== 1) throw error;
      skipped++;
    }
  }
  return { written, skipped };
}

export async function applySqlServerSync(
  sourceId: string,
  targetId: string,
  choices: Pick<SyncChoices, 'changes' | 'tables' | 'anonymize'>,
  onProgress: (p: SyncProgress) => void,
): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
  const result: Pick<SyncResult, 'schema' | 'tables'> = { schema: { applied: 0, failed: [] }, tables: [] };
  const types = await ms.mssql();
  const sourcePool = await ms.poolFor(await ms.saved(sourceId));
  const targetPool = await ms.poolFor(await ms.saved(targetId));
  const src = await readCatalog(sourcePool);
  const wanted = new Set(choices.changes);
  const changes = diffSqlServer(src, await readCatalog(targetPool)).filter(c => wanted.has(c.id));
  let done = 0;
  // Each change in its own transaction: one that fails leaves nothing behind, and the others go on
  for (const change of changes) {
    onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
    const tx = new types.Transaction(targetPool);
    await tx.begin();
    try {
      for (const sql of change.sql) await ms.runBatch(tx, sql);
      await tx.commit();
      result.schema.applied++;
    } catch (error) {
      await tx.rollback().catch(() => {});
      result.schema.failed.push({ id: change.id, error: ms.friendly(error) });
    }
    done++;
  }
  onProgress({ stage: 'schema', done, total: changes.length });

  const tgt = await readCatalog(targetPool);
  const shaped = pgShapeOf(src);
  const chosen = new Map(choices.tables.map(t => [t.key, t]));
  const ordered = dependencyOrder([...shaped.tables.values()].filter(t => chosen.has(t.key)));
  await inSnapshot(sourcePool, async reader => {
    for (let index = 0; index < ordered.length; index++) {
      const pgTable = ordered[index];
      const table = src.tables.get(pgTable.key)!;
      const local = tgt.tables.get(table.key);
      const outcome: SyncResult['tables'][number] = { key: table.key, copied: 0, skipped: 0 };
      result.tables.push(outcome);
      const pk = table.line.primaryKey?.columns.map(c => c.name) ?? null;
      if (!local) { outcome.error = 'the table does not exist locally (its schema change was not applied)'; continue; }
      if (!pk) { outcome.error = 'no primary key: missing rows cannot be found'; continue; }
      try {
        // The columns both sides have, not computed, not rowversion
        const writable = (c: SqlServerColumn) => !c.computed && !c.rowversion;
        const columns = table.line.columns.filter(c => writable(c) && local.line.columns.some(l => l.name === c.name && writable(l)));
        const localColumns = columns.map(c => local.line.columns.find(l => l.name === c.name)!);
        const identity = localColumns.some(c => c.identity);
        const kinds = new Map(choices.anonymize.filter(a => a.table === table.key).map(a => [a.column, a.kind as AnonymizeKind] as const));
        const rules = columns.map((c, i) => {
          const kind = kinds.get(c.name);
          const type = pgTable.columns.find(p => p.name === c.name)?.type ?? 'text';
          return kind ? { index: i, kind, options: { wide: distinctFakes(pgTable, c.name), maxLength: columnLength(type), type } } : null;
        }).filter((r): r is NonNullable<typeof r> => !!r);
        const recentDays = chosen.get(table.key)?.recentDays;
        const dateColumn = recentDays ? timeColumn(pgTable) : undefined;
        if (recentDays && !dateColumn) { outcome.error = 'no date column to keep the last days by'; continue; }
        const filter = recentDays && dateColumn ? { sql: `${q(dateColumn)} >= @p1`, values: [daysAgo(recentDays)] } : undefined;
        const keyIndex = pk.map(name => columns.findIndex(c => c.name === name));
        if (keyIndex.some(i => i < 0)) { outcome.error = 'the primary key differs locally'; continue; }
        const selfReferencing = table.fks.some(f => keyOf(f.refSchema, f.refTable) === table.key);
        const rel = ms.qualified(local.line.schema, local.line.name);
        // A table referencing itself: rows whose parent comes later get in on the next pass
        for (let pass = 0; pass < (selfReferencing ? 4 : 1); pass++) {
          const tx = new types.Transaction(targetPool);
          await tx.begin();
          let copied = 0;
          let skipped = 0;
          try {
            const have = await keySet(tx, local, pk);
            await ms.dumpRows(reader, table.line.schema, table.line.name, columns, async line => {
              if (line.t !== 'rows') return;
              const missing = line.rows.filter(row => !have.has(keyText(keyIndex.map(i => row[i]))))
                .map(row => (rules.length ? row.map((value, i) => {
                  const rule = rules.find(r => r.index === i);
                  return rule ? fakeValue(ms.decodeValue(value), rule.kind, rule.options) : value;
                }) : row));
              const written = await insertMissing(tx, rel, { ...line, rows: missing }, localColumns, identity);
              copied += written.written;
              skipped += written.skipped;
              onProgress({ stage: 'data', table: table.key, index, total: ordered.length, copied: outcome.copied + copied, skipped });
            }, filter);
            await tx.commit();
          } catch (error) {
            await tx.rollback().catch(() => {});
            throw error;
          }
          outcome.copied += copied;
          outcome.skipped = skipped;
          if (copied === 0 || skipped === 0) break;
        }
      } catch (error) {
        outcome.error = ms.friendly(error);
      }
      onProgress({ stage: 'data', table: table.key, index: index + 1, total: ordered.length, copied: outcome.copied, skipped: outcome.skipped });
    }
  });
  return result;
}

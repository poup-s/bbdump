/**
 * DuckDB copies and "Update from…", done by DuckDB itself: both files attached in one run of its
 * tool. An anonymized column goes through a table of fakes: its distinct values are read out to
 * a temporary file, given their fakes here (the same rules as the other engines, so equal values
 * stay equal across tables), then joined while the rows are copied. The real values never reach
 * the copy; the temporary files are removed in every case.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { DatabaseConfig } from '../../types/config';
import { FILE_EXTENSION } from '../../shared/engines/manifests';
import { duckdbLiteral as lit } from '../../shared/engines/duckdbCli';
import { quoteIdent } from '../../shared/engines/sqlGuard';
import { copyStatements, referencedFirst, runDuckdb } from '../engines/duckdb';
import { pgTypeOf } from '../sqlMasking';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { buildAnonymizePlan, emptiedTables, resolveAnonymization } from './anonymizedCopy';
import type { Catalog, CatalogTable } from './catalog';
import { anonymizationCandidates, columnLength, dependencyOrder, distinctFakes, timeColumn, type AnonymizeCandidate, type AnonymizeKind } from './dataSync';
import { fakeValue } from './fakeValues';
import { PHASE, type SchemaChange } from './schemaDiff';
import { saveCopy, type Progress, type SqlDuplicateParams } from './sqlCopyActions';
import type { SyncChoices, SyncProgress, SyncResult, TablePlan } from './syncEngine';

type Row = Record<string, unknown>;
const q = (name: string) => quoteIdent(name, 'duckdb');
const SOURCE = 'bbdump_source';
const LONG = 2 * 60 * 60 * 1000;
/** Missing rows counted key by key up to this many source rows; a count difference beyond */
const EXACT_LIMIT = 1_000_000;

interface DuckColumn { name: string; type: string; nullable: boolean; default: string | null }

interface DuckTable {
  schema: string;
  name: string;
  key: string;
  sql: string;
  columns: DuckColumn[];
  primaryKey: string[] | null;
  uniques: string[][];
  fks: Array<{ columns: string[]; references: string; refColumns: string[] }>;
  indexes: Array<{ name: string; sql: string }>;
  rows: number;
}

interface DuckCatalog {
  schemas: Set<string>;
  tables: Map<string, DuckTable>;
  views: Array<{ schema: string; name: string; sql: string }>;
  sequences: Row[];
}

const keyOf = (schema: string, name: string) => `${schema}.${name}`;
const rel = (t: { schema: string; name: string }, catalog?: string) => `${catalog ? `${q(catalog)}.` : ''}${q(t.schema)}.${q(t.name)}`;
const asList = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const withoutSemicolon = (sql: string) => sql.replace(/;\s*$/, '');

// --- Catalog -----------------------------------------------------------------------------------------

async function readCatalog(file: string): Promise<DuckCatalog> {
  const [schemas = [], tables = [], columns = [], constraints = [], indexes = [], views = [], sequences = []] = await runDuckdb(file, [
    'SELECT schema_name AS s FROM duckdb_schemas() WHERE database_name = current_database() AND NOT internal',
    'SELECT schema_name AS s, table_name AS n, sql FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY table_oid',
    'SELECT schema_name AS s, table_name AS n, column_name AS c, data_type AS type, is_nullable AS nullable, column_default AS dflt FROM duckdb_columns() WHERE database_name = current_database() AND NOT internal ORDER BY schema_name, table_name, column_index',
    "SELECT schema_name AS s, table_name AS n, constraint_type AS kind, constraint_column_names AS cols, referenced_table AS r, referenced_column_names AS rcols FROM duckdb_constraints() WHERE database_name = current_database() AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')",
    'SELECT schema_name AS s, table_name AS n, index_name AS name, sql FROM duckdb_indexes() WHERE database_name = current_database() AND sql IS NOT NULL',
    'SELECT schema_name AS s, view_name AS n, sql FROM duckdb_views() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY view_oid',
    'SELECT schema_name AS s, sequence_name AS n, start_value, min_value, max_value, increment_by, cycle, last_value FROM duckdb_sequences() WHERE database_name = current_database() AND NOT temporary',
  ].map(sql => `${sql};`).join('\n'), { readOnly: true, timeoutMs: 5 * 60 * 1000 });
  const catalog: DuckCatalog = { schemas: new Set(['main', ...schemas.map(s => String(s.s))]), tables: new Map(), views: [], sequences };
  for (const t of tables) {
    const schema = String(t.s);
    const name = String(t.n);
    const own = constraints.filter(c => c.s === schema && c.n === name);
    const pk = asList(own.find(c => c.kind === 'PRIMARY KEY')?.cols);
    catalog.tables.set(keyOf(schema, name), {
      schema, name, key: keyOf(schema, name), sql: String(t.sql), rows: 0,
      columns: columns.filter(c => c.s === schema && c.n === name).map(c => ({ name: String(c.c), type: String(c.type), nullable: !!c.nullable, default: c.dflt === null || c.dflt === undefined ? null : String(c.dflt) })),
      primaryKey: pk.length ? pk : null,
      uniques: own.filter(c => c.kind === 'UNIQUE').map(c => asList(c.cols)),
      fks: own.filter(c => c.kind === 'FOREIGN KEY' && c.r).map(c => ({ columns: asList(c.cols), references: keyOf(schema, String(c.r)), refColumns: asList(c.rcols ?? c.cols) })),
      indexes: indexes.filter(i => i.s === schema && i.n === name).map(i => ({ name: String(i.name), sql: String(i.sql) })),
    });
  }
  for (const v of views) catalog.views.push({ schema: String(v.s), name: String(v.n), sql: String(v.sql) });
  if (catalog.tables.size) {
    const [counts = []] = await runDuckdb(file, `${[...catalog.tables.values()].map(t => `SELECT ${lit(t.key)} AS k, count(*) AS n FROM ${rel(t)}`).join(' UNION ALL ')};`, { readOnly: true, timeoutMs: 5 * 60 * 1000 });
    for (const c of counts) {
      const table = catalog.tables.get(String(c.k));
      if (table) table.rows = Number(c.n);
    }
  }
  return catalog;
}

/** The catalog in PostgreSQL's shape, for the shared anonymization and ordering rules */
function shapeOf(catalog: DuckCatalog): Catalog {
  const tables = new Map<string, CatalogTable>();
  for (const t of catalog.tables.values()) {
    tables.set(t.key, {
      schema: t.schema, name: t.name, key: t.key, partitioned: false, partitionKey: null, estimate: t.rows,
      columns: t.columns.map(c => {
        const type = c.type.toLowerCase();
        const length = /^varchar\((\d+)\)$/.exec(type)?.[1];
        const pg = pgTypeOf(type, type === 'boolean' ? 'bool' : undefined);
        return {
          name: c.name, type: pg === 'text' && length ? `character varying(${length})` : pg, notNull: !c.nullable, default: c.default,
          identity: /nextval\(/i.test(c.default ?? '') ? 'd' : '', generated: false,
        };
      }),
      primaryKey: t.primaryKey,
      constraints: [
        ...(t.primaryKey ? [{ name: `${t.name}_pkey`, type: 'p' as const, definition: '', columns: t.primaryKey, refColumns: [] }] : []),
        ...t.uniques.map((cols, i) => ({ name: `${t.name}_unique_${i}`, type: 'u' as const, definition: '', columns: cols, refColumns: [] })),
        ...t.fks.map((f, i) => ({ name: `${t.name}_fk_${i}`, type: 'f' as const, definition: '', references: f.references, columns: f.columns, refColumns: f.refColumns })),
      ],
      indexes: [], triggers: [], comment: null,
    });
  }
  return { serverVersion: 0, schemas: [...catalog.schemas], extensions: [], enums: new Map(), tables, sequences: new Set(), views: new Map(), functions: new Map() };
}

// --- Fakes -------------------------------------------------------------------------------------------

/** One anonymized column: its kind, and the temporary table of its fakes (none when it has no values) */
interface Fake { kind: AnonymizeKind; table?: string; file?: string }

/**
 * The fakes of the anonymized columns ("<schema>.<table>.<column>" → kind): each column's
 * distinct values read from the source in one run, their fakes written next to them
 */
async function buildFakes(sourceFile: string, catalog: DuckCatalog, shaped: Catalog, kinds: Map<string, AnonymizeKind>, dir: string): Promise<Map<string, Fake>> {
  const fakes = new Map<string, Fake>();
  const reads: string[] = [];
  const pending: Array<{ key: string; input: string; output: string; kind: AnonymizeKind; options: { wide: boolean; maxLength?: number; type: string } }> = [];
  for (const t of catalog.tables.values()) {
    const pgTable = shaped.tables.get(t.key)!;
    for (const c of t.columns) {
      const key = `${t.key}.${c.name}`;
      const kind = kinds.get(key);
      if (!kind) continue;
      if (kind === 'null') { fakes.set(key, { kind }); continue; }
      const index = pending.length;
      const input = path.join(dir, `values_${index}.json`);
      const type = pgTable.columns.find(p => p.name === c.name)?.type ?? 'text';
      pending.push({ key, input, output: path.join(dir, `fakes_${index}.json`), kind, options: { wide: distinctFakes(pgTable, c.name), maxLength: columnLength(type), type } });
      reads.push(`COPY (SELECT DISTINCT CAST(${q(c.name)} AS VARCHAR) AS v FROM ${rel(t)} WHERE ${q(c.name)} IS NOT NULL) TO ${lit(input)} (FORMAT json);`);
    }
  }
  if (reads.length) await runDuckdb(sourceFile, reads.join('\n'), { readOnly: true, sandbox: false, timeoutMs: LONG });
  for (const [index, p] of pending.entries()) {
    let count = 0;
    const out = fs.createWriteStream(p.output, { mode: 0o600 });
    const finished = new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); });
    if (fs.existsSync(p.input)) {
      const lines = readline.createInterface({ input: fs.createReadStream(p.input), crlfDelay: Infinity });
      for await (const text of lines) {
        if (!text.trim()) continue;
        const value = (JSON.parse(text) as { v: string }).v;
        const fake = fakeValue(value, p.kind, p.options);
        if (!out.write(`${JSON.stringify({ v: value, f: fake === null || fake === undefined ? null : String(fake) })}\n`)) await new Promise<void>(r => out.once('drain', () => r()));
        count++;
      }
      fs.rmSync(p.input, { force: true });
    }
    out.end();
    await finished;
    fakes.set(p.key, count ? { kind: p.kind, table: `bbdump_fake_${index}`, file: p.output } : { kind: p.kind });
  }
  return fakes;
}

/** The temporary tables of the fakes a run uses */
const fakeTables = (fakes: Iterable<Fake>) => [...fakes].filter(f => f.table && f.file)
  .map(f => `CREATE TEMP TABLE ${f.table} AS SELECT * FROM read_json(${lit(f.file!)}, columns = {v: 'VARCHAR', f: 'VARCHAR'}, format = 'newline_delimited');`);

/** The SELECT of a table's rows (from the attached source), its anonymized columns joined to their fakes */
function selectRows(t: DuckTable, columns: DuckColumn[], fakes: Map<string, Fake>, where?: string): string {
  const joins: string[] = [];
  const values = columns.map((c, i) => {
    const fake = fakes.get(`${t.key}.${c.name}`);
    if (!fake) return `s0.${q(c.name)}`;
    if (fake.kind === 'null') return 'NULL';
    if (!fake.table) return `s0.${q(c.name)}`;
    joins.push(`LEFT JOIN ${fake.table} AS f${i} ON f${i}.v = CAST(s0.${q(c.name)} AS VARCHAR)`);
    return `CAST(f${i}.f AS ${c.type})`;
  });
  return `SELECT ${values.join(', ')} FROM ${rel(t, SOURCE)} AS s0${joins.length ? ` ${joins.join(' ')}` : ''}${where ? ` WHERE ${where}` : ''}`;
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-duckdb-'));

// --- Copy --------------------------------------------------------------------------------------------

/** A copy into a new file: tables, rows (anonymized as asked), sequences, indexes, views and macros */
export async function duplicateDuckdb(source: DatabaseConfig, params: SqlDuplicateParams, progress: Progress): Promise<{ success: boolean; id?: string; name?: string; warnings?: string[]; error?: string }> {
  const dir = tempDir();
  let file: string | null = null;
  try {
    const sourceFile = source.duckdb?.path;
    if (!sourceFile) throw new Error('This DuckDB database has no file');
    const target = path.resolve(String(params.file ?? ''));
    if (!params.file || !FILE_EXTENSION.duckdb.test(target)) throw new Error('Choose a .duckdb file for the copy');
    if (fs.existsSync(target)) throw new Error(`A file already exists at ${target}`);
    if (!fs.existsSync(path.dirname(target))) throw new Error(`The folder ${path.dirname(target)} does not exist`);
    if (path.resolve(sourceFile) === target) throw new Error('The copy must be another file');

    let fakes = new Map<string, Fake>();
    let empty = new Set<string>();
    let catalog: DuckCatalog | null = null;
    if (params.anonymize) {
      // Checked against the source's own plan: unknown or locked columns are refused, linked ones follow
      progress('creating', 'Reading the values to replace…', 10);
      catalog = await readCatalog(sourceFile);
      const shaped = shapeOf(catalog);
      const plan = buildAnonymizePlan(shaped, new Map([...catalog.tables.values()].map(t => [t.key, t.rows])));
      const kinds = resolveAnonymization(plan, params.anonymize.columns);
      empty = emptiedTables(plan, params.anonymize.emptyTables);
      fakes = await buildFakes(sourceFile, catalog, shaped, kinds, dir);
    }
    progress('copying', 'Copying…', 30);
    const anonymized = new Set([...fakes.keys()].map(k => k.slice(0, k.lastIndexOf('.'))));
    const copy = await copyStatements(sourceFile, SOURCE, (schema, table) => {
      const key = keyOf(schema, table);
      if (empty.has(key)) return null;
      const t = catalog?.tables.get(key);
      if (!t || !anonymized.has(key)) return undefined;
      return `INSERT INTO ${rel(t)} (${t.columns.map(c => q(c.name)).join(', ')}) ${selectRows(t, t.columns, fakes)};`;
    });
    file = target;
    await runDuckdb(':memory:', [
      `ATTACH ${lit(path.resolve(sourceFile))} AS ${SOURCE} (READ_ONLY);`,
      `ATTACH ${lit(target)} AS bbdump_copy;`,
      ...fakeTables(fakes.values()),
      'USE bbdump_copy;',
      'BEGIN;',
      ...copy,
      'COMMIT;',
      'CHECKPOINT bbdump_copy;',
      'USE memory;',
      'DETACH bbdump_copy;',
    ].join('\n'), { sandbox: false, timeoutMs: LONG });
    const name = path.basename(target).replace(FILE_EXTENSION.duckdb, '');
    const entry = saveCopy(source, source, name, target);
    file = null;
    progress('complete', 'Copy saved', 100);
    logger.info(`DuckDB copy of ${source.name} → ${target}${params.anonymize ? ' (anonymized)' : ''}`);
    return { success: true, id: entry.id, name };
  } catch (error) {
    logger.error(`Copy failed: ${getErrorMessage(error)}`);
    if (file) for (const f of [file, `${file}.wal`]) fs.rmSync(f, { force: true });
    return { success: false, error: getErrorMessage(error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Update from… ------------------------------------------------------------------------------------

/** What the target lacks compared to the source, as changes to apply to the target */
export function diffDuckdb(source: DuckCatalog, target: DuckCatalog): SchemaChange[] {
  const out: SchemaChange[] = [];
  const add = (change: Omit<SchemaChange, 'id' | 'defaultSelected'> & { defaultSelected?: boolean }) =>
    out.push({ ...change, id: `${change.kind}:${change.object}`, defaultSelected: change.defaultSelected ?? !change.destructive });
  for (const schema of source.schemas) {
    if (!target.schemas.has(schema)) add({ kind: 'schema', object: schema, sql: [`CREATE SCHEMA IF NOT EXISTS ${q(schema)}`], destructive: false, phase: PHASE.schema });
  }
  for (const s of source.sequences) {
    if (target.sequences.some(t => t.s === s.s && t.n === s.n)) continue;
    // Never below the next value the source would give
    const start = BigInt(String(s.start_value));
    const after = s.last_value === null || s.last_value === undefined ? start : BigInt(String(s.last_value)) + BigInt(String(s.increment_by));
    const next = BigInt(String(s.increment_by)) < 0n ? (after < start ? after : start) : (after > start ? after : start);
    add({
      kind: 'sequence', object: keyOf(String(s.s), String(s.n)), destructive: false, phase: PHASE.enum,
      sql: [`CREATE SEQUENCE ${q(String(s.s))}.${q(String(s.n))} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START ${next} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`],
    });
  }
  for (const t of source.tables.values()) {
    const local = target.tables.get(t.key);
    if (!local) {
      add({ kind: 'table', object: t.key, sql: [withoutSemicolon(t.sql), ...t.indexes.map(i => withoutSemicolon(i.sql))], destructive: false, phase: PHASE.table });
      continue;
    }
    for (const c of t.columns) {
      if (local.columns.some(l => l.name === c.name)) continue;
      // DuckDB adds a column without NOT NULL
      add({
        kind: 'column', object: `${t.key}.${c.name}`, sql: [`ALTER TABLE ${rel(t)} ADD COLUMN ${q(c.name)} ${c.type}${c.default !== null ? ` DEFAULT ${c.default}` : ''}`], destructive: false, phase: PHASE.table,
        ...(!c.nullable ? { note: 'added without NOT NULL', noteCode: 'added_nullable' as const } : {}),
      });
    }
    for (const i of t.indexes) {
      if (local.indexes.some(l => l.name === i.name)) continue;
      add({ kind: 'index', object: `${t.key}.${i.name}`, sql: [withoutSemicolon(i.sql)], destructive: false, phase: PHASE.index, ...(/\bUNIQUE\b/i.test(i.sql) ? { note: 'existing rows must be unique', noteCode: 'must_satisfy' as const } : {}) });
    }
  }
  for (const v of source.views) {
    if (target.views.some(l => l.schema === v.schema && l.name === v.name) || target.tables.has(keyOf(v.schema, v.name))) continue;
    add({ kind: 'view', object: keyOf(v.schema, v.name), sql: [withoutSemicolon(v.sql)], destructive: false, phase: PHASE.view });
  }
  for (const t of target.tables.values()) {
    if (source.tables.has(t.key)) continue;
    add({ kind: 'local_only_table', object: t.key, sql: [`DROP TABLE ${rel(t)}`], destructive: true, phase: PHASE.drop, note: 'only in the local database', noteCode: 'local_only' });
  }
  return out.sort((a, b) => a.phase - b.phase || a.object.localeCompare(b.object));
}

const fileOf = (db: DatabaseConfig) => {
  const file = db.duckdb?.path;
  if (!file) throw new Error('This DuckDB database has no file');
  return path.resolve(file);
};

/** Rows of the source's table whose key the target's table does not have */
const missingWhere = (t: DuckTable, pk: string[]) => `NOT EXISTS (SELECT 1 FROM ${rel(t)} AS l WHERE ${pk.map(c => `l.${q(c)} = s0.${q(c)}`).join(' AND ')})`;

export async function analyzeDuckdbSync(source: DatabaseConfig, target: DatabaseConfig): Promise<{ schema: SchemaChange[]; tables: TablePlan[]; anonymize: AnonymizeCandidate[] }> {
  const src = await readCatalog(fileOf(source));
  const tgt = await readCatalog(fileOf(target));
  const shaped = shapeOf(src);
  // Missing rows counted by DuckDB, key by key, with the source attached (read only)
  const counted = [...src.tables.values()].filter(t => {
    const local = tgt.tables.get(t.key);
    return t.primaryKey && local && local.rows > 0 && t.rows <= EXACT_LIMIT && local.primaryKey?.join() === t.primaryKey.join();
  });
  const missing = new Map<string, number>();
  if (counted.length) {
    const [rows = []] = await runDuckdb(fileOf(target), [
      `ATTACH ${lit(fileOf(source))} AS ${SOURCE} (READ_ONLY);`,
      `${counted.map(t => `SELECT ${lit(t.key)} AS k, count(*) AS n FROM ${rel(t, SOURCE)} AS s0 WHERE ${missingWhere(t, t.primaryKey!)}`).join(' UNION ALL ')};`,
    ].join('\n'), { readOnly: true, sandbox: false, timeoutMs: 10 * 60 * 1000 });
    for (const r of rows) missing.set(String(r.k), Number(r.n));
  }
  const tables: TablePlan[] = [...src.tables.values()].map(t => {
    const local = tgt.tables.get(t.key);
    const plan: TablePlan = {
      key: t.key, newTable: !local, primaryKey: t.primaryKey, sourceRows: t.rows, localRows: local?.rows ?? 0,
      missing: null, missingExact: false, timeColumn: timeColumn(shaped.tables.get(t.key)!), defaultSelected: false,
    };
    if (!t.primaryKey) plan.reason = 'no_primary_key';
    else if (!local || local.rows === 0) { plan.missing = t.rows; plan.missingExact = true; }
    else if (missing.has(t.key)) { plan.missing = missing.get(t.key)!; plan.missingExact = true; }
    else plan.missing = Math.max(0, t.rows - local.rows);
    if (plan.primaryKey && plan.missing === 0 && plan.missingExact) plan.reason = 'up_to_date';
    plan.defaultSelected = !!plan.primaryKey && !!plan.missing;
    return plan;
  });
  return { schema: diffDuckdb(src, tgt), tables: tables.sort((a, b) => a.key.localeCompare(b.key)), anonymize: [...shaped.tables.values()].flatMap(anonymizationCandidates) };
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) of `days` ago */
const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

export async function applyDuckdbSync(
  source: DatabaseConfig,
  target: DatabaseConfig,
  choices: Pick<SyncChoices, 'changes' | 'tables' | 'anonymize'>,
  onProgress: (p: SyncProgress) => void,
): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
  const result: Pick<SyncResult, 'schema' | 'tables'> = { schema: { applied: 0, failed: [] }, tables: [] };
  const sourceFile = fileOf(source);
  const targetFile = fileOf(target);
  const src = await readCatalog(sourceFile);
  const wanted = new Set(choices.changes);
  const changes = diffDuckdb(src, await readCatalog(targetFile)).filter(c => wanted.has(c.id));
  // New tables: the ones others reference first (DuckDB checks a foreign key's table when it is created)
  const order = referencedFirst(
    [...src.tables.values()].map(t => ({ s: t.schema, n: t.name })),
    [...src.tables.values()].flatMap(t => t.fks.map(f => ({ s: t.schema, n: t.name, r: f.references.slice(f.references.indexOf('.') + 1) }))),
  ).map(t => keyOf(String(t.s), String(t.n)));
  const rank = (c: SchemaChange) => (c.kind === 'table' ? order.indexOf(c.object) : 0);
  changes.sort((a, b) => a.phase - b.phase || rank(a) - rank(b));
  let done = 0;
  for (const change of changes) {
    onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
    try {
      await runDuckdb(targetFile, ['BEGIN;', ...change.sql.map(sql => `${sql};`), 'COMMIT;'].join('\n'), { timeoutMs: 10 * 60 * 1000 });
      result.schema.applied++;
    } catch (error) {
      result.schema.failed.push({ id: change.id, error: getErrorMessage(error) });
    }
    done++;
  }
  onProgress({ stage: 'schema', done, total: changes.length });

  const tgt = await readCatalog(targetFile);
  const shaped = shapeOf(src);
  const chosen = new Map(choices.tables.map(t => [t.key, t]));
  const ordered = dependencyOrder([...shaped.tables.values()].filter(t => chosen.has(t.key)));
  const dir = tempDir();
  try {
    const kinds = new Map(choices.anonymize.filter(a => chosen.has(a.table)).map(a => [`${a.table}.${a.column}`, a.kind as AnonymizeKind] as const));
    const fakes = kinds.size ? await buildFakes(sourceFile, src, shaped, kinds, dir) : new Map<string, Fake>();
    for (let index = 0; index < ordered.length; index++) {
      const pgTable = ordered[index];
      const table = src.tables.get(pgTable.key)!;
      const local = tgt.tables.get(table.key);
      const outcome: SyncResult['tables'][number] = { key: table.key, copied: 0, skipped: 0 };
      result.tables.push(outcome);
      onProgress({ stage: 'data', table: table.key, index, total: ordered.length, copied: 0, skipped: 0 });
      if (!local) { outcome.error = 'the table does not exist locally (its schema change was not applied)'; continue; }
      if (!table.primaryKey) { outcome.error = 'no primary key: missing rows cannot be found'; continue; }
      try {
        const columns = table.columns.filter(c => local.columns.some(l => l.name === c.name));
        const recentDays = chosen.get(table.key)?.recentDays;
        const dateColumn = recentDays ? timeColumn(pgTable) : undefined;
        if (recentDays && !dateColumn) { outcome.error = 'no date column to keep the last days by'; continue; }
        const where = [missingWhere(table, table.primaryKey), ...(dateColumn ? [`s0.${q(dateColumn)} >= ${lit(daysAgo(recentDays!))}`] : [])].join(' AND ');
        const own = [...fakes.entries()].filter(([key]) => key.startsWith(`${table.key}.`)).map(([, fake]) => fake);
        // The table counted before and after, in the same run: DuckDB does not say how many rows a statement wrote
        const [before = [], after = []] = await runDuckdb(targetFile, [
          `ATTACH ${lit(sourceFile)} AS ${SOURCE} (READ_ONLY);`,
          ...fakeTables(own),
          `SELECT count(*) AS n FROM ${rel(local)};`,
          'BEGIN;',
          `INSERT INTO ${rel(local)} (${columns.map(c => q(c.name)).join(', ')}) ${selectRows(table, columns, fakes, where)};`,
          'COMMIT;',
          `SELECT count(*) AS n FROM ${rel(local)};`,
        ].join('\n'), { sandbox: false, timeoutMs: LONG });
        outcome.copied = Math.max(0, Number(after[0]?.n ?? 0) - Number(before[0]?.n ?? 0));
      } catch (error) {
        outcome.error = getErrorMessage(error);
      }
      onProgress({ stage: 'data', table: table.key, index: index + 1, total: ordered.length, copied: outcome.copied, skipped: outcome.skipped });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

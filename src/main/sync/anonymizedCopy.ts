/**
 * Duplicate a database with its personal data anonymized. The schema comes from a
 * schema-only pg_dump; the rows are streamed with COPY from a SELECT that already replaces
 * the chosen columns, so the real values never reach this computer. The copy runs once the
 * tables exist and before their indexes, constraints and triggers (the restore's post-data).
 */
import format from 'pg-format';
import type { PoolClient } from 'pg';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import type { Catalog, CatalogColumn, CatalogTable } from './catalog';
import { anonymizationCandidates, anonymizedExpression, type AnonymizeKind } from './dataSync';

const TEXT_KINDS: AnonymizeKind[] = ['partial', 'email', 'phone', 'name', 'address', 'ip', 'secret'];
/** Tables whose rows are only secrets for a running app: left empty by default */
const EPHEMERAL_TABLE = /session|token|otp|password_reset|refresh|magic_link/i;

export interface PlanColumn {
  name: string;
  type: string;
  /** What this column can be replaced with; empty when it cannot be anonymized */
  kinds: AnonymizeKind[];
  /** Kind detected from its name */
  detected?: AnonymizeKind;
  /** Columns tied to this one by foreign keys: anonymized together, with the same kind */
  linked: string[];
  /** Why it cannot change: a key (or tied to one), or a type with no fake (and NOT NULL) */
  locked?: 'key' | 'type';
}

export interface PlanTable {
  key: string;
  rows: number;
  /** Tables whose foreign keys point here: emptying this table empties them too */
  referencedBy: string[];
  suggestEmpty: boolean;
  columns: PlanColumn[];
}

export interface AnonymizePlan {
  tables: PlanTable[];
}

export interface AnonymizeChoices {
  columns: Array<{ table: string; column: string; kind: AnonymizeKind }>;
  /** Tables copied without their rows */
  emptyTables: string[];
}

export type CopyProgress = { table: string; index: number; total: number; rows: number };

const columnKey = (table: string, column: string) => `${table}.${column}`;
const quoteRel = (key: string) => {
  const dot = key.indexOf('.');
  return format('%I.%I', key.slice(0, dot), key.slice(dot + 1));
};

/** Columns tied by a foreign key, grouped (a.col ↔ b.col ↔ c.col…) */
export function foreignKeyGroups(tables: CatalogTable[]): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    const ga = groups.get(a) ?? new Set([a]);
    const gb = groups.get(b) ?? new Set([b]);
    const merged = ga === gb ? ga : new Set([...ga, ...gb]);
    for (const member of merged) groups.set(member, merged);
  };
  for (const table of tables) {
    for (const fk of table.constraints.filter(c => c.type === 'f' && c.references)) {
      fk.columns.forEach((column, i) => {
        if (fk.refColumns[i]) join(columnKey(table.key, column), columnKey(fk.references!, fk.refColumns[i]));
      });
    }
  }
  return groups;
}

/** varchar(n) / char(n): n */
export function columnLength(type: string): number | undefined {
  const m = /^(character varying|varchar|character|char|bpchar)\((\d+)\)/i.exec(type);
  return m ? Number(m[2]) : undefined;
}

/** Under a unique constraint or unique index: its fakes must stay distinct */
export function isUnique(table: CatalogTable, column: string): boolean {
  if (table.constraints.some(c => (c.type === 'u' || c.type === 'p') && c.columns.includes(column))) return true;
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inList = new RegExp(`[(,]\\s*"?${escaped}"?\\s*[,)]`);
  return table.indexes.some(i => /CREATE UNIQUE INDEX/i.test(i.definition) && inList.test(i.definition));
}

function kindsFor(table: CatalogTable, column: CatalogColumn): AnonymizeKind[] {
  if (column.generated || table.primaryKey?.includes(column.name)) return [];
  const type = column.type.toLowerCase();
  const nullable: AnonymizeKind[] = column.notNull ? [] : ['null'];
  if (/^(inet|cidr)/.test(type)) return ['ip', ...nullable];
  if (/char|text|citext/.test(type)) return [...TEXT_KINDS, ...nullable];
  return nullable;
}

/** Everything the dialog shows: tables, their rows, and what each column can become */
export function buildAnonymizePlan(catalog: Catalog, rowCounts: Map<string, number>): AnonymizePlan {
  const tables = [...catalog.tables.values()];
  const groups = foreignKeyGroups(tables);
  const detected = new Map(tables.flatMap(anonymizationCandidates).map(c => [columnKey(c.table, c.column), c.kind] as const));
  // A group holding a primary key cannot change: none of its columns can
  const locked = new Set<string>();
  for (const table of tables) {
    for (const pk of table.primaryKey ?? []) {
      const key = columnKey(table.key, pk);
      for (const member of groups.get(key) ?? [key]) locked.add(member);
    }
  }
  const referencedBy = new Map<string, Set<string>>();
  for (const table of tables) {
    for (const fk of table.constraints.filter(c => c.type === 'f' && c.references && c.references !== table.key)) {
      const set = referencedBy.get(fk.references!) ?? new Set<string>();
      set.add(table.key);
      referencedBy.set(fk.references!, set);
    }
  }

  return {
    tables: tables.map(table => ({
      key: table.key,
      rows: rowCounts.get(table.key) ?? table.estimate,
      referencedBy: [...(referencedBy.get(table.key) ?? [])].sort(),
      suggestEmpty: EPHEMERAL_TABLE.test(table.name),
      columns: table.columns.map(column => {
        const key = columnKey(table.key, column.name);
        const kinds = locked.has(key) ? [] : kindsFor(table, column);
        const kind = detected.get(key);
        return {
          name: column.name,
          type: column.type,
          kinds,
          detected: kind && kinds.includes(kind) ? kind : undefined,
          linked: [...(groups.get(key) ?? [])].filter(k => k !== key).sort(),
          locked: locked.has(key) ? 'key' as const : kinds.length ? undefined : 'type' as const,
        };
      }),
    })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Tables left empty: the chosen ones, plus every table whose foreign keys point to one */
export function emptiedTables(plan: AnonymizePlan, chosen: Iterable<string>): Set<string> {
  const byKey = new Map(plan.tables.map(t => [t.key, t]));
  const out = new Set<string>();
  const queue = [...chosen];
  while (queue.length) {
    const key = queue.pop()!;
    if (out.has(key) || !byKey.has(key)) continue;
    out.add(key);
    queue.push(...byKey.get(key)!.referencedBy);
  }
  return out;
}

/**
 * The columns to replace, checked against the plan: unknown or locked columns are refused,
 * and each choice spreads to the columns tied to it by foreign keys.
 */
export function resolveAnonymization(plan: AnonymizePlan, choices: AnonymizeChoices['columns']): Map<string, AnonymizeKind> {
  const columns = new Map(plan.tables.flatMap(t => t.columns.map(c => [columnKey(t.key, c.name), c] as const)));
  const out = new Map<string, AnonymizeKind>();
  for (const choice of choices) {
    const key = columnKey(choice.table, choice.column);
    const column = columns.get(key);
    if (!column) throw new Error(`Unknown column ${key}`);
    if (!column.kinds.includes(choice.kind)) throw new Error(`${key} cannot be anonymized as ${choice.kind}`);
    out.set(key, choice.kind);
  }
  for (const [key, kind] of [...out]) {
    for (const linked of columns.get(key)!.linked) {
      if (out.has(linked)) continue;
      if (!columns.get(linked)?.kinds.includes(kind)) throw new Error(`${key} is tied to ${linked}, which cannot be anonymized as ${kind}`);
      out.set(linked, kind);
    }
  }
  return out;
}

/** Counts text-format COPY rows as they stream past (one row per line) */
function rowCounter(onRows: (rows: number) => void): Transform {
  let rows = 0;
  let reported = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) rows++;
      if (rows - reported >= 5000) {
        reported = rows;
        onRows(rows);
      }
      callback(null, chunk);
    },
    flush(callback) {
      onRows(rows);
      callback();
    },
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Streams every table of the source into the target, anonymized. `source` must be in a
 * READ ONLY snapshot; `target` has the tables of the schema-only restore, still without
 * indexes, constraints or triggers. Then sequences and materialized views follow.
 */
export async function copyAnonymized(
  source: PoolClient,
  target: PoolClient,
  sourceCatalog: Catalog,
  targetCatalog: Catalog,
  plan: AnonymizePlan,
  choices: AnonymizeChoices,
  onProgress: (p: CopyProgress) => void,
): Promise<{ rows: number; warnings: string[] }> {
  const anonymize = resolveAnonymization(plan, choices.columns);
  const empty = emptiedTables(plan, choices.emptyTables);
  const tables = [...sourceCatalog.tables.values()].filter(t => !empty.has(t.key)).sort((a, b) => a.key.localeCompare(b.key));
  const warnings: string[] = [];
  let total = 0;

  for (let index = 0; index < tables.length; index++) {
    const table = tables[index];
    const local = targetCatalog.tables.get(table.key);
    if (!local) {
      warnings.push(`${table.key}: not created by the schema restore, left out`);
      continue;
    }
    const columns = local.columns.filter(c => !c.generated && table.columns.some(s => s.name === c.name));
    if (!columns.length) continue;
    const select = columns.map(c => {
      const kind = anonymize.get(columnKey(table.key, c.name));
      if (!kind) return format('t.%I', c.name);
      const options = { wide: isUnique(table, c.name), maxLength: columnLength(c.type) };
      return `${anonymizedExpression(c.name, kind, 't', options)} AS ${format('%I', c.name)}`;
    }).join(', ');
    // ONLY: the rows of an inheriting table go with that table (a partitioned parent has none of its own)
    const from = `${table.partitioned ? '' : 'ONLY '}${quoteRel(table.key)} t`;
    const list = columns.map(c => format('%I', c.name)).join(', ');

    onProgress({ table: table.key, index, total: tables.length, rows: 0 });
    let copied = 0;
    await pipeline(
      source.query(copyTo(`COPY (SELECT ${select} FROM ${from}) TO STDOUT`)),
      rowCounter(rows => { copied = rows; onProgress({ table: table.key, index, total: tables.length, rows }); }),
      target.query(copyFrom(`COPY ${quoteRel(local.key)} (${list}) FROM STDIN`)),
    );
    total += copied;
  }

  // Sequences as the source has them (emptied tables included: their ids are never reused)
  for (const sequence of sourceCatalog.sequences) {
    // A refused read must not end the source snapshot
    await source.query('SAVEPOINT bbdump_sequence');
    try {
      const state = (await source.query(`SELECT last_value, is_called FROM ${quoteRel(sequence)}`)).rows[0];
      if (state) await target.query('SELECT setval($1::regclass, $2, $3)', [quoteRel(sequence), state.last_value, state.is_called]);
      await source.query('RELEASE SAVEPOINT bbdump_sequence');
    } catch (error) {
      await source.query('ROLLBACK TO SAVEPOINT bbdump_sequence').catch(() => {});
      warnings.push(`${sequence}: ${message(error)}`);
    }
  }

  // Materialized views come empty from a schema-only dump: rebuilt from the anonymized rows
  for (const [key, view] of sourceCatalog.views) {
    if (!view.materialized) continue;
    try {
      await target.query(`REFRESH MATERIALIZED VIEW ${quoteRel(key)}`);
    } catch (error) {
      warnings.push(`${key}: ${message(error)}`);
    }
  }
  return { rows: total, warnings };
}

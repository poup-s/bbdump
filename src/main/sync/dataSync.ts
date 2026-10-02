/**
 * Copies the rows of a source table that the target lacks (by primary key), optionally
 * anonymized. Source reads happen in the caller's READ ONLY snapshot; values are moved as
 * row_to_json text and restored with json_populate_recordset, so every type round-trips.
 */
import format from 'pg-format';
import type { PoolClient } from 'pg';
import type { CatalogTable } from './catalog';

export type AnonymizeKind = 'email' | 'phone' | 'name' | 'address' | 'ip' | 'secret';

export interface AnonymizeCandidate { table: string; column: string; kind: AnonymizeKind }

const PERSON_TABLE = /user|customer|client|member|person|people|contact|account|employee|patient|subscriber|profile|author/i;

/** Columns that look like personal data, by name */
export function anonymizationCandidates(table: CatalogTable): AnonymizeCandidate[] {
  const out: AnonymizeCandidate[] = [];
  const textual = (type: string) => /char|text|citext|inet|cidr/i.test(type);
  for (const col of table.columns) {
    if (col.generated || table.primaryKey?.includes(col.name) || !textual(col.type)) continue;
    const n = col.name.toLowerCase();
    let kind: AnonymizeKind | null = null;
    if (/(^|_)(e_?)?mail(_address)?$|email/.test(n)) kind = 'email';
    else if (/phone|mobile|(^|_)tel(ephone)?($|_)|fax/.test(n)) kind = 'phone';
    else if (/(first|last|full|middle|sur|family|given|maiden)_?name|^surname$/.test(n) || (n === 'name' && PERSON_TABLE.test(table.name))) kind = 'name';
    else if (/address|street|(^|_)addr($|_)|postal_?code|zip_?code/.test(n) && !/ip_?address|mac_?address|email/.test(n)) kind = 'address';
    else if (/ip_?address|(^|_)ip$|last_ip|remote_ip/.test(n)) kind = 'ip';
    else if (/iban|card_?number|(^|_)ssn$|passport|tax_?id|national_?id|social_?security/.test(n)) kind = 'secret';
    if (kind) out.push({ table: table.key, column: col.name, kind });
  }
  return out;
}

/**
 * SQL expression replacing a column with a fake value. Deterministic (md5 of the real
 * value), so a unique column stays unique and equal values stay equal across tables.
 */
export function anonymizedExpression(column: string, kind: AnonymizeKind, alias = 't'): string {
  const c = `${alias}.${format('%I', column)}`;
  const h = `md5(${c}::text)`;
  const value = {
    email: `'user_' || left(${h}, 12) || '@example.com'`,
    phone: `'+000' || lpad((('x' || left(${h}, 8))::bit(32)::bigint % 1000000000)::text, 9, '0')`,
    name: `'Person ' || upper(left(${h}, 6))`,
    address: `'1 Example Street ' || upper(left(${h}, 4))`,
    ip: `'10.' || (('x' || left(${h}, 2))::bit(8)::int) || '.' || (('x' || substr(${h}, 3, 2))::bit(8)::int) || '.' || (('x' || substr(${h}, 5, 2))::bit(8)::int)`,
    secret: `'XXXX' || upper(left(${h}, 8))`,
  }[kind];
  return `CASE WHEN ${c} IS NULL THEN NULL ELSE ${value} END`;
}

/** Tables ordered so that a table comes after the tables its foreign keys reference */
export function dependencyOrder(tables: CatalogTable[]): CatalogTable[] {
  const byKey = new Map(tables.map(t => [t.key, t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: CatalogTable[] = [];
  const visit = (t: CatalogTable) => {
    if (done.has(t.key) || visiting.has(t.key)) return; // a cycle: kept in place, rows are filtered then
    visiting.add(t.key);
    for (const fk of t.constraints.filter(c => c.type === 'f' && c.references && c.references !== t.key)) {
      const parent = byKey.get(fk.references!);
      if (parent) visit(parent);
    }
    visiting.delete(t.key);
    done.add(t.key);
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

export interface CopyOptions {
  /** Only rows whose timeColumn is within the last N days */
  recentDays?: number;
  timeColumn?: string;
  /** column → kind, for this table */
  anonymize: Map<string, AnonymizeKind>;
  batchSize?: number;
  onBatch?: (copied: number, skipped: number) => void;
}

const json = (rows: string[]) => `[${rows.join(',')}]`;

/**
 * Inserts into `target` the rows of `source` missing there. `sourceTable` / `targetTable`
 * describe the same table on each side (columns may differ: only common columns move).
 */
export async function copyMissingRows(
  sourceClient: PoolClient,
  targetClient: PoolClient,
  sourceTable: CatalogTable,
  targetTable: CatalogTable,
  options: CopyOptions,
): Promise<{ copied: number; skipped: number; scanned: number }> {
  const pk = sourceTable.primaryKey;
  if (!pk || !targetTable.primaryKey || pk.join() !== targetTable.primaryKey.join()) throw new Error('no matching primary key');
  const rel = format('%I.%I', sourceTable.schema, sourceTable.name);
  const targetRel = format('%I.%I', targetTable.schema, targetTable.name);
  const pkList = (alias: string) => pk.map(c => format(`${alias}.%I`, c)).join(', ');
  const pkMatch = (a: string, b: string) => pk.map(c => format(`${a}.%I = ${b}.%I`, c, c)).join(' AND ');

  const writable = targetTable.columns.filter(c => !c.generated && sourceTable.columns.some(s => s.name === c.name)).map(c => c.name);
  const selectList = writable.map(c => {
    const kind = options.anonymize.get(c);
    return kind ? `${anonymizedExpression(c, kind)} AS ${format('%I', c)}` : format('t.%I', c);
  }).join(', ');

  // Rows whose parents are missing locally are left out (filtered parent table, cycle)
  const parentChecks = targetTable.constraints.filter(c => c.type === 'f' && c.references).map(fk => {
    const [ps, pt] = fk.references!.split('.');
    const nulls = fk.columns.map(c => format('r.%I IS NULL', c)).join(' OR ');
    const match = fk.columns.map((c, i) => format('p.%I = r.%I', fk.refColumns[i], c)).join(' AND ');
    return `(${nulls} OR EXISTS (SELECT 1 FROM ${format('%I.%I', ps, pt)} p WHERE ${match}))`;
  });
  const insertSql = `INSERT INTO ${targetRel} (${writable.map(c => format('%I', c)).join(', ')}) OVERRIDING SYSTEM VALUE
    SELECT ${writable.map(c => format('r.%I', c)).join(', ')} FROM json_populate_recordset(NULL::${targetRel}, $1::json) r
    ${parentChecks.length ? `WHERE ${parentChecks.join(' AND ')}` : ''}
    ON CONFLICT DO NOTHING`;

  const filter = options.recentDays && options.timeColumn
    ? format('t.%I >= now() - make_interval(days => %s)', options.timeColumn, Math.floor(options.recentDays))
    : 'true';
  const batch = options.batchSize ?? 2000;
  let last: string | null = null;
  let copied = 0;
  let skipped = 0;
  let scanned = 0;

  for (;;) {
    const keys: string[] = (await sourceClient.query(
      `SELECT row_to_json(k)::text AS k FROM (SELECT ${pkList('t')} FROM ${rel} t
        WHERE ${filter}${last ? ` AND (${pkList('t')}) > (SELECT ${pkList('l')} FROM json_populate_record(NULL::${rel}, $1::json) l)` : ''}
        ORDER BY ${pkList('t')} LIMIT ${batch}) k`,
      last ? [last] : [],
    )).rows.map(r => r.k as string);
    if (keys.length === 0) break;
    last = keys[keys.length - 1];
    scanned += keys.length;

    const present = new Set((await targetClient.query(
      `SELECT row_to_json(k)::text AS k FROM (SELECT ${pkList('t')} FROM ${targetRel} t
        JOIN json_populate_recordset(NULL::${targetRel}, $1::json) r ON ${pkMatch('t', 'r')}) k`,
      [json(keys)],
    )).rows.map(r => r.k as string));
    const missing = keys.filter(k => !present.has(k));

    if (missing.length) {
      const rows = (await sourceClient.query(
        `SELECT row_to_json(x)::text AS j FROM (SELECT ${selectList} FROM ${rel} t
          JOIN json_populate_recordset(NULL::${rel}, $1::json) m ON ${pkMatch('t', 'm')}) x`,
        [json(missing)],
      )).rows.map(r => r.j as string);
      const result = await targetClient.query(insertSql, [json(rows)]);
      copied += result.rowCount ?? 0;
      skipped += rows.length - (result.rowCount ?? 0);
    }
    options.onBatch?.(copied, skipped);
    if (keys.length < batch) break;
  }
  return { copied, skipped, scanned };
}

/** Rows of a source table missing in the target (exact), by scanning primary keys */
export async function countMissingRows(sourceClient: PoolClient, targetClient: PoolClient, sourceTable: CatalogTable, targetTable: CatalogTable, recent?: { days: number; column: string }): Promise<number> {
  const pk = sourceTable.primaryKey!;
  const rel = format('%I.%I', sourceTable.schema, sourceTable.name);
  const targetRel = format('%I.%I', targetTable.schema, targetTable.name);
  const pkList = (alias: string) => pk.map(c => format(`${alias}.%I`, c)).join(', ');
  const filter = recent ? format('t.%I >= now() - make_interval(days => %s)', recent.column, Math.floor(recent.days)) : 'true';
  const keys = (await sourceClient.query(`SELECT row_to_json(k)::text AS k FROM (SELECT ${pkList('t')} FROM ${rel} t WHERE ${filter}) k`)).rows.map(r => r.k as string);
  let missing = 0;
  for (let i = 0; i < keys.length; i += 5000) {
    const chunk = keys.slice(i, i + 5000);
    const present = Number((await targetClient.query(
      `SELECT count(*) AS n FROM ${targetRel} t JOIN json_populate_recordset(NULL::${targetRel}, $1::json) r ON ${pk.map(c => format('t.%I = r.%I', c, c)).join(' AND ')}`,
      [json(chunk)],
    )).rows[0].n);
    missing += chunk.length - present;
  }
  return missing;
}

/** A timestamp/date column to filter "recent" rows on (created_at first) */
export function timeColumn(table: CatalogTable): string | undefined {
  const dated = table.columns.filter(c => /^(timestamp|date)/.test(c.type));
  return (dated.find(c => /^(created|inserted)(_at|_on|_date)?$/i.test(c.name))
    ?? dated.find(c => /created|inserted/i.test(c.name))
    ?? dated.find(c => /(_at|_on|date)$/i.test(c.name)))?.name;
}

/** Moves serial / identity sequences past the highest id copied, never backwards */
export async function catchUpSequences(targetClient: PoolClient, table: CatalogTable): Promise<void> {
  const rel = format('%I.%I', table.schema, table.name);
  for (const col of table.columns) {
    if (!/int/.test(col.type)) continue;
    const seq = (await targetClient.query('SELECT pg_get_serial_sequence($1, $2) AS s', [rel, col.name])).rows[0]?.s;
    if (!seq) continue;
    await targetClient.query(format(
      `SELECT setval(%L, m) FROM (SELECT max(%I) AS m FROM %s) s WHERE m IS NOT NULL AND m > (SELECT last_value FROM %s)`,
      seq, col.name, rel, seq,
    ));
  }
}

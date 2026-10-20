/**
 * Copies the rows of a source table that the target lacks (by primary key), optionally
 * anonymized. Source reads happen in the caller's READ ONLY snapshot; values are moved as
 * row_to_json text and restored with json_populate_recordset, so every type round-trips.
 */
import format from 'pg-format';
import type { PoolClient } from 'pg';
import type { CatalogTable } from './catalog';
import { CITIES, FIRST_NAMES, LAST_NAMES, STREETS } from './fakeData';

/**
 * `partial`: the value keeps its shape, part of it starred (****234@email.fr, *****tien poupi).
 * Realistic fakes from word lists: `first_name`, `last_name`, `name`, `email`, `address`, `city`.
 * Numbers and dates: `noise` (±10 %, dates ±30 days), `month` / `year` (rounded down).
 * `null`: the value is dropped (any nullable column, e.g. free notes or a JSON payload).
 */
export type AnonymizeKind =
  | 'partial' | 'email' | 'phone' | 'name' | 'first_name' | 'last_name' | 'address' | 'city' | 'ip' | 'secret'
  | 'noise' | 'month' | 'year' | 'null';

export interface AnonymizeCandidate { table: string; column: string; kind: AnonymizeKind }

const PERSON_TABLE = /user|customer|client|member|person|people|contact|account|employee|patient|subscriber|profile|author/i;

/** What a column type allows: text fakes, numeric noise, date noise and rounding */
export type ValueClass = 'text' | 'inet' | 'int' | 'decimal' | 'float' | 'date' | 'timestamp' | 'other';

export function valueClass(type: string): ValueClass {
  const t = type.toLowerCase().trim();
  if (t.endsWith('[]')) return 'other';
  if (/^(inet|cidr)/.test(t)) return 'inet';
  if (/char|text|citext/.test(t)) return 'text';
  if (/^(smallint|integer|bigint|int[248]?)$/.test(t)) return 'int';
  if (/^(numeric|decimal)/.test(t)) return 'decimal';
  if (/^(real|double precision|float[48]?)$/.test(t)) return 'float';
  if (t === 'date') return 'date';
  if (/^timestamp/.test(t)) return 'timestamp';
  return 'other';
}

/** Columns that look like personal data, by name */
export function anonymizationCandidates(table: CatalogTable): AnonymizeCandidate[] {
  const out: AnonymizeCandidate[] = [];
  for (const col of table.columns) {
    if (col.generated || table.primaryKey?.includes(col.name)) continue;
    const n = col.name.toLowerCase();
    const cls = valueClass(col.type);
    let kind: AnonymizeKind | null = null;
    if (cls === 'text' || cls === 'inet') {
      if (/(^|_)(e_?)?mail(_address)?$|email/.test(n)) kind = 'email';
      else if (/phone|mobile|(^|_)tel(ephone)?($|_)|fax/.test(n)) kind = 'phone';
      else if (/(first|given)_?name|prenom/.test(n)) kind = 'first_name';
      else if (/(last|sur|family|maiden)_?name|^surname$|^nom$/.test(n)) kind = 'last_name';
      else if (/(full|middle)_?name/.test(n) || (n === 'name' && PERSON_TABLE.test(table.name))) kind = 'name';
      else if (/(^|_)(city|town|ville|commune)($|_)/.test(n)) kind = 'city';
      else if (/address|street|(^|_)addr($|_)|postal_?code|zip_?code/.test(n) && !/ip_?address|mac_?address|email/.test(n)) kind = 'address';
      else if (/ip_?address|(^|_)ip$|last_ip|remote_ip/.test(n)) kind = 'ip';
      else if (/iban|card_?number|(^|_)ssn$|passport|tax_?id|national_?id|social_?security/.test(n)) kind = 'secret';
    } else if (isUnique(table, col.name)) {
      // Noise or rounding could make two values equal
      continue;
    } else if (cls === 'date' || cls === 'timestamp') {
      // A birth date identifies a person: only its year is kept
      if (/birth|(^|_)dob($|_)|(^|_)born|naissance/.test(n)) kind = 'year';
    } else if (cls === 'int' || cls === 'decimal' || cls === 'float') {
      if (/salary|income|wage|salaire|revenu/.test(n)) kind = 'noise';
    }
    if (kind) out.push({ table: table.key, column: col.name, kind });
  }
  return out;
}

/** A positive number from 7 hex digits of the hash, from position `offset` (0-based) */
const hashInt = (h: string, offset: number) => `('x' || substr(${h}, ${offset + 1}, 7))::bit(28)::int`;
/** An item of a word list chosen by the hash */
const pickSql = (list: readonly string[], h: string, offset: number) =>
  `(ARRAY[${list.map(v => format('%L', v)).join(', ')}])[1 + ${hashInt(h, offset)} % ${list.length}]`;

const INT_RANGE: Record<string, [string, string]> = {
  smallint: ['-32768', '32767'], int2: ['-32768', '32767'],
  integer: ['-2147483648', '2147483647'], int: ['-2147483648', '2147483647'], int4: ['-2147483648', '2147483647'],
  bigint: ['-9223372036854775808', '9223372036854775807'], int8: ['-9223372036854775808', '9223372036854775807'],
};

/**
 * SQL expression replacing a column with a fake value. Deterministic (md5 of the real
 * value), so equal values stay equal across tables. `wide` uses more of the hash, for
 * columns that must stay unique; `maxLength` cuts the fake to a varchar(n) column; `type`
 * (the column type) is needed for noise and rounding.
 */
export function anonymizedExpression(column: string, kind: AnonymizeKind, alias = 't', options: { wide?: boolean; maxLength?: number; type?: string } = {}): string {
  if (kind === 'null') return 'NULL';
  const c = `${alias}.${format('%I', column)}`;
  const h = `md5(${c}::text)`;
  const wide = !!options.wide;
  if (kind === 'partial') return `CASE WHEN ${c} IS NULL THEN NULL ELSE ${partialExpression(`${c}::text`, h, wide)} END`;
  if (kind === 'noise' || kind === 'month' || kind === 'year') return `CASE WHEN ${c} IS NULL THEN NULL ELSE ${numericOrDateExpression(c, h, kind, options.type ?? '')} END`;
  // Unique columns: a part of the hash keeps two fakes from colliding
  const suffix = wide ? ` || ' ' || upper(substr(${h}, 21, 12))` : '';
  const first = pickSql(FIRST_NAMES, h, 0);
  const last = pickSql(LAST_NAMES, h, 7);
  const value = {
    email: `lower(${first}) || '.' || lower(${last}) || '.' || substr(${h}, 15, ${wide ? 12 : 4}) || '@example.com'`,
    phone: wide
      ? `'+' || lpad((('x' || left(${h}, 12))::bit(48)::bigint % 100000000000000)::text, 14, '0')`
      : `'+000' || lpad((('x' || left(${h}, 8))::bit(32)::bigint % 1000000000)::text, 9, '0')`,
    first_name: `${first}${suffix}`,
    last_name: `${last}${suffix}`,
    name: `${first} || ' ' || ${last}${suffix}`,
    address: `(1 + ${hashInt(h, 14)} % 199)::text || ' ' || ${pickSql(STREETS, h, 21)}${suffix}`,
    city: `${pickSql(CITIES, h, 0)}${suffix}`,
    ip: `'10.' || (('x' || left(${h}, 2))::bit(8)::int) || '.' || (('x' || substr(${h}, 3, 2))::bit(8)::int) || '.' || (('x' || substr(${h}, 5, 2))::bit(8)::int)`,
    secret: `'XXXX' || upper(left(${h}, ${wide ? 16 : 8}))`,
  }[kind];
  const fitted = options.maxLength ? `left(${value}, ${Math.floor(options.maxLength)})` : value;
  return `CASE WHEN ${c} IS NULL THEN NULL ELSE ${fitted} END`;
}

/**
 * Numbers: ±10 % (integers rounded and kept in their type's range, decimals at their own
 * scale). Dates: ±30 days, or rounded down to the month / year. Same value, same result.
 */
function numericOrDateExpression(c: string, h: string, kind: 'noise' | 'month' | 'year', type: string): string {
  const cls = valueClass(type);
  if (cls === 'date' || cls === 'timestamp') {
    if (kind !== 'noise') return `date_trunc('${kind}', ${c})${cls === 'date' ? '::date' : ''}`;
    // The shift comes from the day only (YYYY-MM-DD), as the MCP server computes it
    const days = `(${hashInt(`md5(to_char(${c}, 'YYYY-MM-DD'))`, 0)} % 61 - 30)`;
    return cls === 'date' ? `${c} + ${days}` : `${c} + ${days} * interval '1 day'`;
  }
  if (kind !== 'noise') throw new Error(`${kind} only applies to dates`);
  const factor = `(0.9 + ${hashInt(h, 0)} / 268435455.0 * 0.2)`;
  if (cls === 'int') {
    const [min, max] = INT_RANGE[type.toLowerCase().trim()] ?? INT_RANGE.bigint;
    return `greatest(${min}, least(${max}, round(${c} * ${factor})))`;
  }
  if (cls === 'decimal') return `round(${c} * ${factor}, scale(${c}))`;
  if (cls === 'float') return `${c} * ${factor}`;
  throw new Error(`noise does not apply to ${type || 'this type'}`);
}

/**
 * Part of a value starred, its shape kept (same length, @ and domain, phone separators):
 * email: the end of the local part shown (****234@email.fr); phone: the last 2 digits;
 * any other text: its first third hidden (*****tien poupi). `wide` (a unique column): the
 * hidden part comes from the hash instead of stars, so two values cannot end up equal.
 */
function partialExpression(v: string, h: string, wide: boolean): string {
  const cover = (n: string) => (wide ? `left(repeat(${h}, (${n}) / 32 + 1), ${n})` : `repeat('*', ${n})`);
  const local = `split_part(${v}, '@', 1)`;
  const hidden = `greatest(length(${local}) - 3, ceil(length(${local}) / 2.0)::int)`;
  const email = `${cover(hidden)} || right(${local}, length(${local}) - ${hidden}) || substr(${v}, strpos(${v}, '@'))`;
  const phone = wide
    ? `'+' || lpad((('x' || left(${h}, 12))::bit(48)::bigint % 100000000000000)::text, 14, '0')`
    : `regexp_replace(left(${v}, length(${v}) - 2), '[0-9]', '*', 'g') || right(${v}, 2)`;
  const third = `greatest(1, ceil(length(${v}) / 3.0)::int)`;
  const text = `${cover(third)} || substr(${v}, ${third} + 1)`;
  return `CASE WHEN ${v} LIKE '_%@_%' THEN ${email} WHEN ${v} ~ '^[0-9 +().-]{6,}$' THEN ${phone} ELSE ${text} END`;
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

/**
 * Fakes must stay distinct: a unique column, or a column of a foreign key (it points to a
 * unique one, and both must get the same fake to stay linked).
 */
export function distinctFakes(table: CatalogTable, column: string): boolean {
  return isUnique(table, column) || table.constraints.some(c => c.type === 'f' && c.columns.includes(column));
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
    if (!kind) return format('t.%I', c);
    // Same fakes as the anonymized duplicate: distinct where they must be, cut to the column's size
    const target = targetTable.columns.find(col => col.name === c);
    const fit = { wide: distinctFakes(sourceTable, c), maxLength: target ? columnLength(target.type) : undefined, type: target?.type };
    return `${anonymizedExpression(c, kind, 't', fit)} AS ${format('%I', c)}`;
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

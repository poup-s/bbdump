/**
 * Personal data hidden from the AI, per saved database (set in bbdump, file ai-masking.json
 * next to config.json, read on every call). Columns chosen there are replaced before a
 * result leaves; a result whose text columns cannot be traced to a table (computed, view,
 * free SQL) is shown to the user in bbdump first, who decides what goes to the AI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type pg from 'pg';
import { executeReadOnly, getActiveConnectionInfo } from './db.js';
import { findDatabase, savedDatabaseIdsNamed } from './connections.js';
import { appApi } from './confirm.js';
import { CITIES, FIRST_NAMES, LAST_NAMES, STREETS } from './fakeData.js';
import { chatScope } from './chatScope.js';

export type MaskKind =
  | 'partial' | 'email' | 'phone' | 'name' | 'first_name' | 'last_name' | 'address' | 'city' | 'ip' | 'secret'
  | 'noise' | 'month' | 'year' | 'null';
const KINDS: MaskKind[] = ['partial', 'email', 'phone', 'name', 'first_name', 'last_name', 'address', 'city', 'ip', 'secret', 'noise', 'month', 'year', 'null'];

type Row = Record<string, unknown>;
interface MaskingEntry { enabled?: boolean; columns?: Array<{ table: string; column: string; kind: MaskKind }> }

/** Rules of one database: "schema.table.column" → kind */
export type MaskRules = Map<string, MaskKind>;

/** The rules from the file content for these saved databases; null when none has masking on */
export function rulesFromFile(content: unknown, databaseIds: string[]): MaskRules | null {
  const databases = (content as { databases?: Record<string, MaskingEntry> } | null)?.databases;
  if (!databases || typeof databases !== 'object') return null;
  let rules: MaskRules | null = null;
  for (const id of databaseIds) {
    const entry = databases[id];
    if (entry?.enabled !== true) continue;
    rules ??= new Map();
    for (const c of entry.columns ?? []) {
      if (c && typeof c.table === 'string' && typeof c.column === 'string' && KINDS.includes(c.kind)) rules.set(`${c.table}.${c.column}`, c.kind);
    }
  }
  return rules;
}

export function readMaskingFile(): unknown {
  const configPath = process.env.BBDUMP_CONFIG_PATH;
  if (!configPath) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(configPath), 'ai-masking.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Rules for the database a tool reads: the active saved one, or (another database of the
 * same server) every saved database with that name. Several matches: all their rules.
 */
export function rulesFor(database?: string): MaskRules | null {
  const active = getActiveConnectionInfo();
  const target = database || active.database;
  const ids = new Set(savedDatabaseIdsNamed(target));
  if (target === active.database && active.label) {
    const saved = findDatabase(active.label);
    if (saved) ids.add(saved.id);
  }
  return ids.size ? rulesFromFile(readMaskingFile(), [...ids]) : null;
}

const md5 = (value: unknown) => createHash('md5').update(
  value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value),
).digest('hex');

/** Part of a value starred, its shape kept: the same rules as bbdump's anonymized copies */
export function partialValue(text: string): string {
  const at = text.indexOf('@');
  if (at > 0 && at < text.length - 1) {
    const local = text.slice(0, at);
    const hidden = Math.max(local.length - 3, Math.ceil(local.length / 2));
    return '*'.repeat(hidden) + local.slice(hidden) + text.slice(at);
  }
  if (/^[0-9 +().-]{6,}$/.test(text)) return text.slice(0, -2).replace(/[0-9]/g, '*') + text.slice(-2);
  const third = Math.max(1, Math.ceil(text.length / 3));
  return '*'.repeat(third) + text.slice(third);
}

/** 7 hex digits of the hash from `offset`, as bbdump's SQL reads them */
const hashInt = (h: string, offset: number) => parseInt(h.slice(offset, offset + 7), 16);
const pick = (list: readonly string[], h: string, offset: number) => list[hashInt(h, offset) % list.length];

/** Numbers ±10 %, dates ±30 days or rounded down to the month / year (as bbdump's copies) */
function noiseOrRound(value: unknown, kind: 'noise' | 'month' | 'year', h: string): unknown {
  const date = value instanceof Date ? value : null;
  const dateText = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  // A timestamp written as text keeps its time part ("2024-05-15 10:20:00"), at midnight when rounded
  const time = typeof value === 'string' && value.length > 10 ? value.slice(10) : '';
  if (kind !== 'noise') {
    if (date) return kind === 'month' ? new Date(date.getFullYear(), date.getMonth(), 1) : new Date(date.getFullYear(), 0, 1);
    if (dateText) return `${dateText[1]}-${kind === 'month' ? dateText[2] : '01'}-01${time ? ' 00:00:00' : ''}`;
    return null;
  }
  if (date || dateText) {
    const shifted = new Date(date ?? `${dateText![0]}T00:00:00`);
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // The shift comes from the day only (YYYY-MM-DD), as bbdump's SQL computes it
    shifted.setDate(shifted.getDate() + (hashInt(createHash('md5').update(ymd(shifted)).digest('hex'), 0) % 61 - 30));
    return date ? shifted : `${ymd(shifted)}${time}`;
  }
  const factor = 0.9 + (hashInt(h, 0) / 268435455) * 0.2;
  if (typeof value === 'number') return Number.isInteger(value) ? Math.round(value * factor) : value * factor;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    const decimals = value.split('.')[1]?.length ?? 0;
    return (Number(value) * factor).toFixed(decimals);
  }
  return null;
}

/** The fake for a value: the same as bbdump's anonymized copies, NULL stays NULL */
export function fakeValue(value: unknown, kind: MaskKind): unknown {
  if (value === null || value === undefined || kind === 'null') return null;
  if (kind === 'partial') return partialValue(value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const h = md5(value);
  if (kind === 'noise' || kind === 'month' || kind === 'year') return noiseOrRound(value, kind, h);
  const first = pick(FIRST_NAMES, h, 0);
  const last = pick(LAST_NAMES, h, 7);
  switch (kind) {
    case 'email': return `${first.toLowerCase()}.${last.toLowerCase()}.${h.slice(14, 18)}@example.com`;
    case 'phone': return `+000${String(parseInt(h.slice(0, 8), 16) % 1000000000).padStart(9, '0')}`;
    case 'first_name': return first;
    case 'last_name': return last;
    case 'name': return `${first} ${last}`;
    case 'address': return `${1 + (hashInt(h, 14) % 199)} ${pick(STREETS, h, 21)}`;
    case 'city': return pick(CITIES, h, 0);
    case 'ip': return `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`;
    default: return `XXXX${h.slice(0, 8).toUpperCase()}`;
  }
}

/** Replaces the given columns in every row */
export function maskRows(rows: Row[], columns: Map<string, MaskKind>): Row[] {
  if (!columns.size) return rows;
  return rows.map(row => {
    const out: Row = { ...row };
    for (const [name, kind] of columns) if (name in out) out[name] = fakeValue(out[name], kind);
    return out;
  });
}

// Text-like types: values that can carry personal data once their origin is unknown
const TEXT_TYPES = new Set([17, 18, 19, 25, 114, 142, 199, 650, 705, 869, 1009, 1014, 1015, 1042, 1043, 2249, 3802, 3807]);
const isTextual = (dataTypeID: number) => TEXT_TYPES.has(dataTypeID) || dataTypeID >= 16384;

export interface FieldOrigin {
  name: string;
  /** rule: a chosen column · unknown: text not traceable to a table column · clear: anything else */
  origin: 'rule' | 'unknown' | 'clear';
  kind?: MaskKind;
  source?: string;
}

/** Where each result column comes from, using the table/column ids PostgreSQL sends */
export async function classifyFields(client: pg.PoolClient, fields: pg.FieldDef[], rules: MaskRules): Promise<FieldOrigin[]> {
  const tableIds = [...new Set(fields.map(f => f.tableID).filter(Boolean))];
  const columns = new Map<string, { relkind: string; system: boolean; key: string }>();
  if (tableIds.length) {
    const { rows } = await executeReadOnly(client, `
      SELECT c.oid::bigint AS oid, a.attnum, c.relkind, n.nspname, c.relname, a.attname,
             n.nspname IN ('pg_catalog', 'information_schema') OR n.nspname LIKE 'pg_toast%' AS system
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
      WHERE c.oid = ANY($1::oid[])`, [tableIds]);
    for (const r of rows) columns.set(`${r.oid}:${r.attnum}`, { relkind: r.relkind, system: r.system, key: `${r.nspname}.${r.relname}.${r.attname}` });
  }
  return fields.map(f => {
    const column = f.tableID ? columns.get(`${f.tableID}:${f.columnID}`) : undefined;
    if (column?.system) return { name: f.name, origin: 'clear' as const };
    if (column && (column.relkind === 'r' || column.relkind === 'p')) {
      const kind = rules.get(column.key);
      return kind ? { name: f.name, origin: 'rule' as const, kind, source: column.key } : { name: f.name, origin: 'clear' as const, source: column.key };
    }
    // Computed, or a column of a view: its origin is not known
    return { name: f.name, origin: isTextual(f.dataTypeID) ? 'unknown' as const : 'clear' as const, source: column?.key };
  });
}

export interface Shown {
  rows: Row[];
  /** Set when the user blocked the result */
  blocked?: string;
  /** Columns replaced, for the AI */
  masked?: string[];
}

const NOTE = 'Some values were masked by the user in bbdump (partly starred such as ****234@email.fr, realistic fakes such as Camille Martin or camille.martin.3f2a@example.com, XXXX…, NULL, numbers with ±10 % noise, dates moved by up to 30 days or rounded to the month or year). Work with them as they are: never try to find the real values.';
export const maskingNote = (shown: Shown) => (shown.masked?.length ? { masked_columns: shown.masked, masking: NOTE } : {});

/** The '…' literals of a SQL text, quotes doubled inside them read as one */
export function sqlLiterals(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/'((?:[^']|'')*)'/g)) out.add(m[1].replace(/''/g, "'"));
  return out;
}

/**
 * A computed column whose every value is written in the query itself ('events' AS t…) holds
 * nothing from the database: it can go to the AI without asking.
 */
export function onlyQueryLiterals(rows: Row[], name: string, sql: string | undefined): boolean {
  if (!sql) return false;
  const literals = sqlLiterals(sql);
  const values = rows.map(r => r[name]).filter(v => v !== null && v !== undefined);
  return values.length > 0 && values.every(v => typeof v === 'string' && literals.has(v));
}

/**
 * Whether a query plan can reach a chosen column: it reads a table holding one (views are
 * opened in the plan), or it calls a function of the database's own, which could read one
 * out of sight. `plan` is the output of EXPLAIN (VERBOSE, FORMAT JSON).
 */
export function planMayReadRules(plan: unknown, rules: MaskRules, ownFunctions: Iterable<string>): boolean {
  const relations = new Set<string>();
  const called = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Record<string, unknown>;
    if (typeof n['Relation Name'] === 'string') relations.add(`${n['Schema'] ?? ''}.${n['Relation Name']}`);
    if (typeof n['Function Name'] === 'string') called.add(n['Function Name']);
    for (const value of Object.values(n)) walk(value);
  };
  walk(plan);
  const keys = [...rules.keys()];
  if ([...relations].some(rel => keys.some(k => k.startsWith(`${rel}.`)))) return true;
  // Expressions of the plan (outputs, filters), quoted names unquoted
  const text = JSON.stringify(plan ?? null).replace(/\\"/g, '');
  for (const fn of ownFunctions) {
    const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (called.has(fn) || new RegExp(`(^|[^\\w$])${escaped}\\s*\\(`).test(text)) return true;
  }
  return false;
}

/**
 * True when the query cannot read a chosen column (see planMayReadRules); false when it may,
 * or when that cannot be told (the plan could not be read).
 */
async function readsNoRule(client: pg.PoolClient, sql: string, params: unknown[] | undefined, rules: MaskRules): Promise<boolean> {
  try {
    const explained = await executeReadOnly(client, `EXPLAIN (VERBOSE, FORMAT JSON) ${sql}`, params ?? []);
    const functions = await executeReadOnly(client, `
      SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'`);
    const plan = explained.rows[0]?.['QUERY PLAN'];
    if (!plan) return false;
    return !planMayReadRules(plan, rules, functions.rows.map(r => String(r.proname)));
  } catch {
    return false;
  }
}

/** What the user is shown in bbdump: a few values per column, cut short */
function samples(rows: Row[], name: string): string[] {
  return rows.map(r => r[name]).filter(v => v !== null && v !== undefined).slice(0, 3)
    .map(v => (v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60));
}

/** The same values as the AI gets them once anonymized */
function anonymizedSamples(rows: Row[], name: string, kind: MaskKind): string[] {
  return rows.map(r => r[name]).filter(v => v !== null && v !== undefined).slice(0, 3).map(v => {
    const fake = fakeValue(v, kind);
    return (fake instanceof Date ? fake.toISOString() : typeof fake === 'object' && fake !== null ? JSON.stringify(fake) : String(fake)).slice(0, 60);
  });
}

/**
 * Rows ready for the AI. No masking on this database: unchanged. Chosen columns are
 * replaced; when text columns of unknown origin remain, the user decides in bbdump
 * (`ask`), else they are masked too.
 */
export async function protectRows(
  client: pg.PoolClient,
  result: { fields: pg.FieldDef[]; rows: Row[] },
  context: { tool: string; database?: string; sql?: string; params?: unknown[]; ask?: boolean },
): Promise<Shown> {
  const rules = rulesFor(context.database);
  if (!rules) return { rows: result.rows };
  const origins = await classifyFields(client, result.fields, rules);
  const toMask = new Map<string, MaskKind>();
  for (const o of origins) if (o.origin === 'rule') toMask.set(o.name, o.kind!);
  // Values the AI wrote in its own query are not data from the database
  for (const o of origins) {
    if (o.origin === 'unknown' && onlyQueryLiterals(result.rows, o.name, context.sql)) o.origin = 'clear';
  }
  // Computed from tables without a chosen column: nothing to hide
  if (context.sql && origins.some(o => o.origin === 'unknown') && await readsNoRule(client, context.sql, context.params, rules)) {
    for (const o of origins) if (o.origin === 'unknown') o.origin = 'clear';
  }
  const unknown = origins.filter(o => o.origin === 'unknown');
  for (const o of unknown) toMask.set(o.name, 'partial');

  if (unknown.length && context.ask !== false && result.rows.length) {
    const active = getActiveConnectionInfo();
    try {
      const answer = await appApi<{ approved?: boolean; mask?: unknown }>('POST', '/disclose', {
        tool: context.tool,
        // Asked in the chat this server works for, when there is one
        ...(chatScope.chatId ? { chatId: chatScope.chatId } : {}),
        database: active.label || context.database || active.database,
        sql: (context.sql ?? '').slice(0, 2000),
        rows: result.rows.length,
        columns: origins.map(o => ({
          name: o.name, origin: o.origin, source: o.source, samples: samples(result.rows, o.name),
          anonymized: anonymizedSamples(result.rows, o.name, o.origin === 'rule' ? o.kind! : 'partial'),
        })),
      }, 65000);
      if (answer?.approved !== true) {
        return { rows: [], blocked: 'The user blocked this result in bbdump: it may contain personal data. Do not retry the same query; ask the user, or read the table with read_rows (its personal columns come masked).' };
      }
      if (Array.isArray(answer.mask)) {
        const chosen = new Set(answer.mask.filter((m): m is string => typeof m === 'string'));
        toMask.clear();
        for (const o of origins) {
          if (chosen.has(o.name)) toMask.set(o.name, o.origin === 'rule' ? o.kind! : 'partial');
        }
      }
    } catch {
      // bbdump not answering: the safe default (chosen and unknown columns masked)
    }
  }
  return { rows: maskRows(result.rows, toMask), masked: [...toMask.keys()] };
}

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

export type MaskKind = 'partial' | 'email' | 'phone' | 'name' | 'address' | 'ip' | 'secret' | 'null';
const KINDS: MaskKind[] = ['partial', 'email', 'phone', 'name', 'address', 'ip', 'secret', 'null'];

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

function readFile(): unknown {
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
  return ids.size ? rulesFromFile(readFile(), [...ids]) : null;
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

/** The fake for a value: the same as bbdump's anonymized copies, NULL stays NULL */
export function fakeValue(value: unknown, kind: MaskKind): unknown {
  if (value === null || value === undefined || kind === 'null') return null;
  if (kind === 'partial') return partialValue(value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value));
  const h = md5(value);
  switch (kind) {
    case 'email': return `user_${h.slice(0, 12)}@example.com`;
    case 'phone': return `+000${String(parseInt(h.slice(0, 8), 16) % 1000000000).padStart(9, '0')}`;
    case 'name': return `Person ${h.slice(0, 6).toUpperCase()}`;
    case 'address': return `1 Example Street ${h.slice(0, 4).toUpperCase()}`;
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

const NOTE = 'Some values were masked by the user in bbdump (partly starred such as ****234@email.fr, or fakes such as XXXX…, user_…@example.com, NULL). Work with them as they are: never try to find the real values.';
export const maskingNote = (shown: Shown) => (shown.masked?.length ? { masked_columns: shown.masked, masking: NOTE } : {});

/** What the user is shown in bbdump: a few values per column, cut short */
function samples(rows: Row[], name: string): string[] {
  return rows.map(r => r[name]).filter(v => v !== null && v !== undefined).slice(0, 3)
    .map(v => (v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 60));
}

/**
 * Rows ready for the AI. No masking on this database: unchanged. Chosen columns are
 * replaced; when text columns of unknown origin remain, the user decides in bbdump
 * (`ask`), else they are masked too.
 */
export async function protectRows(
  client: pg.PoolClient,
  result: { fields: pg.FieldDef[]; rows: Row[] },
  context: { tool: string; database?: string; sql?: string; ask?: boolean },
): Promise<Shown> {
  const rules = rulesFor(context.database);
  if (!rules) return { rows: result.rows };
  const origins = await classifyFields(client, result.fields, rules);
  const toMask = new Map<string, MaskKind>();
  for (const o of origins) if (o.origin === 'rule') toMask.set(o.name, o.kind!);
  const unknown = origins.filter(o => o.origin === 'unknown');
  for (const o of unknown) toMask.set(o.name, 'partial');

  if (unknown.length && context.ask !== false && result.rows.length) {
    const active = getActiveConnectionInfo();
    try {
      const answer = await appApi<{ approved?: boolean; mask?: unknown }>('POST', '/disclose', {
        tool: context.tool,
        database: active.label || context.database || active.database,
        sql: (context.sql ?? '').slice(0, 2000),
        rows: result.rows.length,
        columns: origins.map(o => ({ name: o.name, origin: o.origin, source: o.source, samples: samples(result.rows, o.name) })),
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

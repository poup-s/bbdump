/**
 * A dashboard's program and the AI's answers (pure: tested without a window).
 * The AI gets the current program with each request and answers with a patch (the changed
 * statements); bbdump merges it by statement name. Query results are shaped for the
 * components: numbers as numbers, dates as readable text.
 */
import { mergeStatements } from '@openuidev/lang-core';
import { splitOpenUi } from '../chat/messageParts';

/** What a dashboard's Query("sql", …) returns */
export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

/** bigint and numeric: node-postgres gives them as text */
const NUMERIC_OIDS = new Set([20, 1700]);

const pad = (n: number) => String(n).padStart(2, '0');
/** Dates as ISO text (local time): the components format them in the user's language */
function dateText(d: Date): string {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() || d.getMinutes() || d.getSeconds() ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : day;
}

function cellValue(value: unknown, numeric: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dateText(value);
  if (numeric && typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** The answer of 'execute-sql' as the components read it */
export function toQueryResult(raw: { fields?: string[]; types?: number[]; rows?: Array<Record<string, unknown>>; truncated?: boolean } | null | undefined): QueryResult {
  const columns = Array.isArray(raw?.fields) ? raw!.fields.map(String) : [];
  const numeric = columns.map((_, i) => NUMERIC_OIDS.has(Number(raw?.types?.[i])));
  const rows = (Array.isArray(raw?.rows) ? raw!.rows : []).map(row => {
    const out: Record<string, unknown> = {};
    columns.forEach((c, i) => { out[c] = cellValue(row?.[c], numeric[i]); });
    return out;
  });
  return { columns, rows, truncated: !!raw?.truncated };
}

/** The message the AI gets: the program as it is now, the block aimed at, then what the user asks */
export function dashboardRequest(program: string, request: string, focus?: string | null): string {
  const text = request.trim();
  if (!program.trim()) return `The dashboard is empty: create it.\n\nRequest: ${text}`;
  const aim = focus ? `\n\nThe request is about the block "${focus}" (and the statements it uses): change only that, keep its name.` : '';
  return `Current dashboard program:\n\`\`\`openui-lang\n${program.trim()}\n\`\`\`${aim}\n\nRequest: ${text}`;
}

// --- Filters ---------------------------------------------------------------------------------

/** Period presets of a PeriodFilter; 'custom' uses the dates chosen */
export const PERIODS = ['7d', '30d', '90d', '12m', 'ytd', 'all', 'custom'] as const;
export type Period = typeof PERIODS[number];

/** {{from}} / {{to}} of a period (ISO timestamps; "-infinity" / "infinity" for all time) */
export function periodRange(period: string, now: Date, custom?: { from?: string; to?: string }): { from: string; to: string } {
  const to = new Date(now);
  const from = new Date(now);
  switch (period) {
    case '7d': from.setDate(from.getDate() - 7); break;
    case '90d': from.setDate(from.getDate() - 90); break;
    case '12m': from.setFullYear(from.getFullYear() - 1); break;
    case 'ytd': from.setMonth(0, 1); from.setHours(0, 0, 0, 0); break;
    case 'all': return { from: '-infinity', to: 'infinity' };
    case 'custom': return {
      from: custom?.from ? new Date(`${custom.from}T00:00:00`).toISOString() : '-infinity',
      // The end day is included
      to: custom?.to ? new Date(new Date(`${custom.to}T00:00:00`).getTime() + 86400000).toISOString() : 'infinity',
    };
    default: from.setDate(from.getDate() - 30);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * {{from}}, {{to}} and {{name}} placeholders as bind parameters ($1…): values never go into the
 * SQL text. Dates are typed timestamptz, other filters text (null: the filter is "all").
 */
export function bindFilters(sql: string, values: Record<string, string | null | undefined>): { text: string; params: Array<string | null> } {
  const params: Array<string | null> = [];
  const index = new Map<string, number>();
  const text = sql.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!index.has(name)) {
      params.push(values[name] ?? (name === 'from' ? '-infinity' : name === 'to' ? 'infinity' : null));
      index.set(name, params.length);
    }
    return `$${index.get(name)}::${name === 'from' || name === 'to' ? 'timestamptz' : 'text'}`;
  });
  return { text, params };
}

/**
 * The engine a program's queries are written for: Query("sql", …) PostgreSQL, Query("mysql", …)
 * MySQL / MariaDB, Query("sqlite", …), Query("mongo", …); null when it has none yet. A dashboard
 * only goes on a database of the same family (its SQL dialect, or MongoDB).
 */
export function programEngine(program: string): 'postgresql' | 'mysql' | 'sqlite' | 'mongodb' | null {
  if (/\bQuery\(\s*"mongo"/.test(program)) return 'mongodb';
  if (/\bQuery\(\s*"mysql"/.test(program)) return 'mysql';
  if (/\bQuery\(\s*"sqlite"/.test(program)) return 'sqlite';
  if (/\bQuery\(\s*"sql"/.test(program)) return 'postgresql';
  return null;
}

/** The family a database's dashboards belong to: MySQL and MariaDB share their dialect */
export function dashboardFamily(engine: string): string {
  return engine === 'mariadb' ? 'mysql' : engine;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** "2026-10-28 09:30:00" in UTC: how MySQL DATETIME and SQLite text dates compare */
function sqlDateText(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Bounds of "all time" for MySQL and SQLite (text dates sort the same way) */
const SQL_DATE_MIN = '1000-01-01 00:00:00';
const SQL_DATE_MAX = '9999-12-31 23:59:59';

/**
 * Filter placeholders of a MySQL / MariaDB or SQLite query as ? parameters (one per placeholder,
 * in order): values never go into the SQL text. {{from}} / {{to}} become UTC date texts
 * ("all time": the year 1000 to 9999), other filters text, or null when the filter is "all".
 */
export function bindSqlParams(sql: string, values: Record<string, string | null | undefined>): { text: string; params: Array<string | null> } {
  const params: Array<string | null> = [];
  const text = sql.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const raw = values[name];
    if (name === 'from' || name === 'to') {
      params.push(!raw || raw === '-infinity' ? SQL_DATE_MIN : raw === 'infinity' ? SQL_DATE_MAX : sqlDateText(raw));
    } else {
      params.push(raw ?? null);
    }
    return '?';
  });
  return { text, params };
}

// --- MongoDB: Query("mongo", {query: "{\"collection\": …, \"pipeline\": […]}"}) -----------------

/** What "all time" stands for in a MongoDB filter (Extended JSON dates, both ends included) */
const MONGO_DATE_MIN = { $date: { $numberLong: '-62135596800000' } };
const MONGO_DATE_MAX = { $date: { $numberLong: '253402300799999' } };

/** The collection and the pipeline of a MongoDB block's query text */
export function mongoDashboardQuery(text: string): { collection: string; pipeline: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The query is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = parsed as { collection?: unknown; pipeline?: unknown } | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.collection !== 'string' || !value.collection) {
    throw new Error('The query must be {"collection": "orders", "pipeline": [...]}');
  }
  if (!Array.isArray(value.pipeline)) throw new Error('"pipeline" must be an array of stages');
  return { collection: value.collection, pipeline: JSON.stringify(value.pipeline) };
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Filter placeholders of a MongoDB query, replaced by values (never by text the user typed as
 * code): a whole string "{{from}}" / "{{to}}" becomes a date, "{{name}}" the text (null when the
 * filter is "all"); a placeholder inside a longer string (a $regex) gets the text escaped, empty
 * when the filter is "all".
 */
export function bindMongoFilters(text: string, values: Record<string, string | null | undefined>): string {
  const valueOf = (name: string): unknown => {
    const raw = values[name];
    if (name === 'from' || name === 'to') {
      if (!raw || raw === '-infinity') return MONGO_DATE_MIN;
      if (raw === 'infinity') return MONGO_DATE_MAX;
      return { $date: raw };
    }
    return raw ?? null;
  };
  // A whole JSON string: the value itself
  const whole = text.replace(/"\{\{\s*(\w+)\s*\}\}"/g, (_m, name: string) => JSON.stringify(valueOf(name)));
  // Inside a string: the text, escaped for JSON and for a regular expression
  return whole.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const raw = values[name];
    const textValue = typeof raw === 'string' && name !== 'from' && name !== 'to' ? raw.replace(REGEX_SPECIAL, '\\$&') : '';
    return JSON.stringify(textValue).slice(1, -1);
  });
}

/** A relaxed Extended JSON value as a cell: dates as text, ObjectIds as hex, numbers as numbers */
function documentCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [key, inner] = entries[0];
    if (key === '$date') {
      const time = typeof inner === 'string' ? Date.parse(inner) : Number((inner as { $numberLong?: string })?.$numberLong);
      if (!Number.isFinite(time)) return null;
      // Midnight UTC: a day ($dateTrunc, a birth date), shown as such whatever the time zone
      return time % 86400000 === 0 ? new Date(time).toISOString().slice(0, 10) : dateText(new Date(time));
    }
    if (key === '$oid') return String(inner);
    if (key === '$numberDecimal' || key === '$numberLong' || key === '$numberDouble' || key === '$numberInt') {
      const n = Number(inner);
      return Number.isFinite(n) ? n : String(inner);
    }
  }
  return JSON.stringify(value);
}

/**
 * Documents of an aggregation as the components read them: one column per top-level field (in
 * order of appearance); a $group key made of several fields ({_id: {city, year}}) gives one
 * column per field.
 */
export function toMongoQueryResult(raw: { documents?: Array<Record<string, unknown>>; truncated?: boolean } | null | undefined): QueryResult {
  const columns: string[] = [];
  const rows = (Array.isArray(raw?.documents) ? raw!.documents : []).map(document => {
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(document ?? {})) {
      const compound = key === '_id' && value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).some(k => k.startsWith('$'));
      if (compound) {
        for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) if (!(inner in document)) flat[inner] = innerValue;
      } else {
        flat[key] = value;
      }
    }
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flat)) {
      if (!columns.includes(key)) columns.push(key);
      row[key] = documentCell(value);
    }
    return row;
  });
  // Every row has every column (null when a document lacks the field)
  for (const row of rows) for (const column of columns) if (!(column in row)) row[column] = null;
  return { columns, rows, truncated: !!raw?.truncated };
}

/**
 * The programs (or patches) of an answer, in order: every complete OpenUI block. An answer may
 * write the program, then correct it in a second block; both apply.
 */
export function patchesFromAnswer(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const part of splitOpenUi(text)) {
      if (part.kind === 'ui' && part.complete && part.source.trim()) found.push(part.source.trim());
    }
  }
  return found;
}

/** The patch merged into the program by statement name (a first program is taken as is) */
export function applyPatch(program: string, patch: string): string {
  return program.trim() ? mergeStatements(program.trim(), patch.trim()).trim() : patch.trim();
}

/** Previous programs, the newest last, at most `max` */
export function withVersion(versions: Array<{ program: string; at: string }>, previous: string, at: string, max = 10): Array<{ program: string; at: string }> {
  if (!previous.trim()) return versions.slice(-max);
  return [...versions, { program: previous, at }].slice(-max);
}

// --- Suggestions ------------------------------------------------------------------------------

const SUGGESTIONS = /```suggestions[^\n]*\n([\s\S]*?)(```|$)/g;

/** The next steps (or the choices of a question) an answer offers, as buttons: ```suggestions, one per line */
export function suggestionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SUGGESTIONS)) {
    for (const line of m[1].split('\n')) {
      const item = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
      if (item && item.length <= 200 && !out.includes(item)) out.push(item);
    }
  }
  return out.slice(0, 4);
}

/** The answer's text without its suggestions block */
export const withoutSuggestions = (text: string) => text.replace(SUGGESTIONS, '').trim();

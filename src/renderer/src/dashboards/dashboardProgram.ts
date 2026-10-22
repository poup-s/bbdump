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

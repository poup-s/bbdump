/**
 * Fake values computed here, for the engines whose rows bbdump copies itself (MySQL, MariaDB,
 * SQLite). Same rules as PostgreSQL's anonymizedExpression (dataSync.ts): deterministic (md5 of
 * the real value), so equal values stay equal across tables and foreign keys stay linked;
 * `wide` uses more of the hash, for columns that must stay unique. Pure.
 */
import { createHash } from 'crypto';
import { CITIES, FIRST_NAMES, LAST_NAMES, STREETS } from './fakeData';
import { valueClass, type AnonymizeKind } from './dataSync';

const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');
/** A positive number from 7 hex digits of the hash, from position `offset` (0-based) */
const hashInt = (h: string, offset: number) => parseInt(h.slice(offset, offset + 7), 16);
const pick = (list: readonly string[], h: string, offset: number) => list[hashInt(h, offset) % list.length];

const INT_RANGE: Record<string, [number, number]> = {
  smallint: [-32768, 32767], integer: [-2147483648, 2147483647], bigint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

/** The value as text, as PostgreSQL's ::text writes it for the kinds that hash it */
function asText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Starred, its shape kept: email local part end, phone last 2 digits, other text its last two thirds */
function partial(v: string, h: string, wide: boolean): string {
  const cover = (n: number) => (wide ? h.repeat(Math.floor(n / 32) + 1).slice(0, n) : '*'.repeat(n));
  if (/^.+@.+$/s.test(v)) {
    const at = v.indexOf('@');
    const local = v.slice(0, at);
    const hidden = Math.max(local.length - 3, Math.ceil(local.length / 2));
    return cover(hidden) + local.slice(hidden) + v.slice(at);
  }
  if (/^[0-9 +().-]{6,}$/.test(v)) {
    if (wide) return '+' + (BigInt('0x' + h.slice(0, 12)) % 100000000000000n).toString().padStart(14, '0');
    return v.slice(0, -2).replace(/[0-9]/g, '*') + v.slice(-2);
  }
  const third = Math.max(1, Math.ceil(v.length / 3));
  return cover(third) + v.slice(third);
}

/** "YYYY-MM-DD…" of a date value (a driver's string, or a Date) */
function dateParts(value: unknown): { day: string; rest: string } | null {
  const text = value instanceof Date ? value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : String(value);
  const m = /^(\d{4}-\d{2}-\d{2})(.*)$/s.exec(text);
  return m ? { day: m[1], rest: m[2] } : null;
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Numbers ±10 % (integers rounded, decimals at their own scale); dates ±30 days or rounded down */
function numericOrDate(value: unknown, h: string, kind: 'noise' | 'month' | 'year', type: string): unknown {
  const cls = valueClass(type);
  if (cls === 'date' || cls === 'timestamp') {
    const parts = dateParts(value);
    if (!parts) return value;
    const time = cls === 'timestamp' ? (parts.rest ? ' 00:00:00' : '') : '';
    if (kind === 'year') return `${parts.day.slice(0, 4)}-01-01${time}`;
    if (kind === 'month') return `${parts.day.slice(0, 7)}-01${time}`;
    // The shift comes from the day only, as PostgreSQL and the MCP server compute it
    const days = (hashInt(md5(parts.day), 0) % 61) - 30;
    return shiftDay(parts.day, days) + parts.rest;
  }
  if (kind !== 'noise') return value;
  const factor = 0.9 + (hashInt(h, 0) / 268435455) * 0.2;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (cls === 'int') {
    const [min, max] = INT_RANGE[type.toLowerCase().trim()] ?? INT_RANGE.bigint;
    return Math.max(min, Math.min(max, Math.round(n * factor)));
  }
  if (cls === 'decimal') {
    const scale = (String(value).split('.')[1] ?? '').length;
    return (n * factor).toFixed(scale);
  }
  return n * factor;
}

/**
 * A fake for `value` (null stays null). `type` is the column type as the anonymization rules
 * know it (pgTypeOf), needed for noise and rounding; `maxLength` cuts a fake to varchar(n).
 */
export function fakeValue(value: unknown, kind: AnonymizeKind, options: { wide?: boolean; maxLength?: number; type?: string } = {}): unknown {
  if (kind === 'null' || value === null || value === undefined) return null;
  const text = asText(value);
  const h = md5(text);
  const wide = !!options.wide;
  if (kind === 'noise' || kind === 'month' || kind === 'year') return numericOrDate(value, h, kind, options.type ?? '');
  let fake: string;
  if (kind === 'partial') fake = partial(text, h, wide);
  else {
    const suffix = wide ? ` ${h.slice(20, 32).toUpperCase()}` : '';
    const first = pick(FIRST_NAMES, h, 0);
    const last = pick(LAST_NAMES, h, 7);
    fake = {
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${h.slice(14, 14 + (wide ? 12 : 4))}@example.com`,
      phone: wide
        ? '+' + (BigInt('0x' + h.slice(0, 12)) % 100000000000000n).toString().padStart(14, '0')
        : '+000' + (parseInt(h.slice(0, 8), 16) % 1000000000).toString().padStart(9, '0'),
      first_name: `${first}${suffix}`,
      last_name: `${last}${suffix}`,
      name: `${first} ${last}${suffix}`,
      address: `${1 + (hashInt(h, 14) % 199)} ${pick(STREETS, h, 21)}${suffix}`,
      city: `${pick(CITIES, h, 0)}${suffix}`,
      ip: `10.${parseInt(h.slice(0, 2), 16)}.${parseInt(h.slice(2, 4), 16)}.${parseInt(h.slice(4, 6), 16)}`,
      secret: `XXXX${h.slice(0, wide ? 16 : 8).toUpperCase()}`,
    }[kind];
  }
  return options.maxLength ? fake.slice(0, Math.floor(options.maxLength)) : fake;
}

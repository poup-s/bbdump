/**
 * Rules for a new row draft (add / duplicate): which columns the database fills itself,
 * which ones can be typed, and how to produce a fresh key shaped like the existing ones.
 */
import type { TableColumnDetail } from '../../types';

/** Generated column, or identity GENERATED ALWAYS: an INSERT may not set it. */
export const isAlwaysGenerated = (col: TableColumnDetail) =>
  col.is_generated === 'ALWAYS' || (col.is_identity === 'YES' && col.identity_generation === 'ALWAYS');

/** The database provides a value when the column is left out (default, identity, generated). */
export const isDbFilled = (col: TableColumnDetail) =>
  !!col.column_default || col.is_identity === 'YES' || col.is_generated === 'ALWAYS';

/**
 * Values that must be fresh for every row (sequence, identity, generated uuid, "now"): a
 * duplicate leaves them to the database. A plain default ('member', false…) is copied.
 */
export const isAutoValue = (col: TableColumnDetail) =>
  col.is_identity === 'YES' || col.is_generated === 'ALWAYS'
  || /nextval\(|gen_random_uuid|uuid_generate|now\(\)|current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp/i
    .test(col.column_default || '');

/** Columns shown in the draft: not computed, and keys only when the database does not make them. */
export const draftColumns = (columns: TableColumnDetail[]) =>
  columns.filter((col) => !isAlwaysGenerated(col) && !(col.is_primary && isDbFilled(col)));

/** Must be typed: NOT NULL without anything the database could fill in. */
export const isDraftRequired = (col: TableColumnDetail) => col.is_nullable === 'NO' && !isDbFilled(col);

/** Creation / update timestamps get "now" rather than a copy of the source row. */
const TIMESTAMP_NAMES = new Set(['created_at', 'updated_at', 'createdat', 'updatedat', 'timestamp', 'inserted_at', 'modified_at']);
export const isRowTimestamp = (col: TableColumnDetail) =>
  TIMESTAMP_NAMES.has(col.column_name.toLowerCase()) && /timestamp|date/.test(col.data_type || '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID = /^c[a-z0-9]{24}$/;
const CUID2 = /^[a-z][a-z0-9]{23}$/;

const randomBase36 = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
};

export type KeyShape = 'uuid' | 'cuid' | 'cuid2';

/** Shape of a key column, from its type or an existing value (Prisma ids are made by the app). */
export function keyShape(col: TableColumnDetail, sample: unknown): KeyShape | null {
  if (col.udt_name === 'uuid') return 'uuid';
  if (typeof sample !== 'string') return /char|text/.test(col.data_type || '') ? 'cuid' : null;
  if (UUID.test(sample)) return 'uuid';
  if (CUID.test(sample)) return 'cuid';
  if (CUID2.test(sample)) return 'cuid2';
  return null;
}

/** A fresh key in that shape (cuid-like: "c" + time + randomness, 25 characters). */
export function newKey(shape: KeyShape): string {
  if (shape === 'uuid') return crypto.randomUUID();
  if (shape === 'cuid2') return randomBase36(1).replace(/[0-9]/, 'a') + randomBase36(23);
  const time = Date.now().toString(36).slice(-8).padStart(8, '0');
  return `c${time}${randomBase36(16)}`;
}

/**
 * Values sent to INSERT: computed columns are never sent, and an empty value is left out
 * when the database can fill the column (sending NULL would override its default).
 */
export function insertPayload(columns: TableColumnDetail[], draft: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  for (const col of columns) {
    if (!(col.column_name in draft) || isAlwaysGenerated(col)) continue;
    const value = draft[col.column_name];
    if ((value === null || value === undefined || value === '') && isDbFilled(col)) continue;
    payload[col.column_name] = value === undefined ? null : value;
  }
  return payload;
}

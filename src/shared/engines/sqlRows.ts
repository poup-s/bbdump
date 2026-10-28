/**
 * Rows of MySQL, MariaDB and SQLite tables as the AI journal keeps them (undo points): JSON text
 * where binary data and big integers keep their exact value. Written by the MCP server, read
 * back by the app when a change is undone. Pure: shared by both (copied by
 * scripts/copy-mcp-shared.mjs) and the tests.
 */

type Row = Record<string, unknown>;

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

function toBase64(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
}

function fromBase64(text: string): Uint8Array {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}

/** One value as JSON: bytes and bigints wrapped, dates as ISO text, objects (JSON columns) as they are */
function encodeValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (isBytes(value)) return { $base64: toBase64(value) };
    if (value instanceof Date) return value.toISOString();
    return value;
}

function decodeValue(value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$bigint') return BigInt(String((value as { $bigint: string }).$bigint));
        if (keys.length === 1 && keys[0] === '$base64') return fromBase64(String((value as { $base64: string }).$base64));
    }
    return value;
}

/** A row as journal text (columns in their table order) */
export function encodeRow(row: Row): string {
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) out[key] = encodeValue(value);
    return JSON.stringify(out);
}

/** A journal row back as values a driver can bind */
export function decodeRow(text: string): Row {
    const parsed = JSON.parse(text) as Row;
    const out: Row = {};
    for (const [key, value] of Object.entries(parsed)) out[key] = decodeValue(value);
    return out;
}

/** The primary key of a journal row, as a stable text (to pair the before and after states) */
export function rowKey(text: string, primaryKey: string[]): string {
    const row = JSON.parse(text) as Row;
    return JSON.stringify(primaryKey.map(column => row[column] ?? null));
}

/** Whether a row read now is the one the journal kept (same values, whatever their JSON order) */
export function sameRow(current: Row, keptText: string): boolean {
    const kept = JSON.parse(keptText) as Row;
    const now = JSON.parse(encodeRow(current)) as Row;
    const columns = new Set([...Object.keys(kept), ...Object.keys(now)]);
    for (const column of columns) {
        if (JSON.stringify(normalize(kept[column])) !== JSON.stringify(normalize(now[column]))) return false;
    }
    return true;
}

/** Numbers read as text by one driver and as numbers by another compare equal (decimal "10.50" vs 10.5) */
function normalize(value: unknown): unknown {
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value ?? null;
}

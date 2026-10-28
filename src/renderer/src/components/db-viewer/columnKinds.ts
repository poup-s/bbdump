/**
 * What a column holds, from its type as the engine names it: PostgreSQL (timestamp with time
 * zone, double precision…), MySQL / MariaDB (datetime, int(11), decimal(10,2), tinyint(1)) or
 * SQLite (the declared type: INTEGER, REAL, DATETIME…). Decides the editor and the display.
 */
import type { TableColumnDetail } from '../../types';

export type ColumnKind = 'bool' | 'json' | 'datetime' | 'date' | 'time' | 'number' | 'longtext' | 'text';

const NUMBER = /^(integer|bigint|smallint|mediumint|tinyint|int|numeric|decimal|real|double|float|serial|bigserial|smallserial|bit)\b/;
const LONG_TEXT = /^(text|tinytext|mediumtext|longtext|clob)\b/;

export function columnKind(col: Pick<TableColumnDetail, 'data_type' | 'udt_name'>): ColumnKind {
    const type = (col.data_type || '').toLowerCase().trim();
    const udt = (col.udt_name || '').toLowerCase();
    if (type === 'boolean' || type === 'bool' || udt === 'bool') return 'bool';
    if (type === 'json' || type === 'jsonb') return 'json';
    if (type.includes('timestamp') || type.startsWith('datetime')) return 'datetime';
    if (type === 'date') return 'date';
    if (/^time\b/.test(type)) return 'time';
    if (NUMBER.test(type)) return 'number';
    if (LONG_TEXT.test(type)) return 'longtext';
    return 'text';
}

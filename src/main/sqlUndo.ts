/**
 * Undo of the MySQL, MariaDB and SQLite changes made by AI clients (journal written by the MCP
 * server, rows as sqlRows.ts encodes them, keyed by primary key). Undoing first checks that the
 * rows are still as the change left them (else it refuses and shows which), then, in one
 * transaction with foreign keys checked at the end (or not at all on MySQL, where restoring a
 * consistent previous state is the point): deletes the rows the change inserted, puts back the
 * ones it deleted and reverts the ones it updated. Generated columns are never written.
 */
import type { PoolConnection } from 'mysql2/promise';
import type { DatabaseSync } from 'node:sqlite';
import { withSavedMysql } from './engines/mysql';
import { withSavedSqlite } from './engines/sqlite';
import { decodeRow, encodeRow, rowKey, sameRow } from '../shared/engines/sqlRows';
import { quoteIdent } from '../shared/engines/sqlGuard';
import type { UndoConflict, UndoTable } from './aiJournal';

type Row = Record<string, unknown>;

interface Session {
    rows(sql: string, values?: unknown[]): Promise<Row[]>;
    run(sql: string, values?: unknown[]): Promise<number>;
    /** Columns an INSERT or UPDATE may set (generated ones left out) */
    writable(table: string): Promise<string[]>;
}

const bindMysql = (value: unknown) => {
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return value ?? null;
};
const bindSqlite = (value: unknown) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
    return (value ?? null) as null | number | bigint | string | Uint8Array;
};

function mysqlSession(conn: PoolConnection): Session {
    return {
        rows: async (sql, values = []) => {
            const [rows] = await conn.query({ sql, values: values.map(bindMysql) });
            return Array.isArray(rows) ? rows as Row[] : [];
        },
        run: async (sql, values = []) => {
            const [result] = await conn.query({ sql, values: values.map(bindMysql) });
            return (result as { affectedRows?: number }).affectedRows ?? 0;
        },
        writable: async table => {
            const [rows] = await conn.query({
                sql: 'SELECT COLUMN_NAME AS c, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
                values: [table],
            });
            // VIRTUAL / STORED / PERSISTENT generated columns cannot be written
            return (rows as Row[]).filter(r => !/\b(virtual|stored|persistent)\b/i.test(String(r.e ?? ''))).map(r => String(r.c));
        },
    };
}

function sqliteSession(db: DatabaseSync): Session {
    return {
        rows: async (sql, values = []) => db.prepare(sql).all(...values.map(bindSqlite)).map(row => ({ ...row })),
        run: async (sql, values = []) => Number(db.prepare(sql).run(...values.map(bindSqlite)).changes),
        writable: async table => (db.prepare('SELECT name, hidden FROM pragma_table_xinfo(?)').all(table) as unknown as Array<{ name: string; hidden: number }>)
            .filter(c => c.hidden === 0).map(c => c.name),
    };
}

/** Runs `fn` with a session on the saved database, in one transaction when `write` */
async function withSession<T>(engine: string, databaseId: string, write: boolean, fn: (session: Session) => Promise<T>): Promise<T> {
    if (engine === 'sqlite') {
        return withSavedSqlite(databaseId, async db => {
            if (!write) return fn(sqliteSession(db));
            db.exec('BEGIN IMMEDIATE');
            // Checked at COMMIT: parents and children come back in any order
            db.exec('PRAGMA defer_foreign_keys = ON');
            try {
                const out = await fn(sqliteSession(db));
                db.exec('COMMIT');
                return out;
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch { /* already ended */ }
                throw error;
            }
        });
    }
    return withSavedMysql(databaseId, async conn => {
        if (!write) return fn(mysqlSession(conn));
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        await conn.beginTransaction();
        try {
            const out = await fn(mysqlSession(conn));
            await conn.commit();
            return out;
        } catch (error) {
            await conn.rollback().catch(() => {});
            throw error;
        } finally {
            await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
        }
    });
}

const dialectOf = (engine: string) => (engine === 'sqlite' ? 'sqlite' : 'mysql');

function byKeys(q: (name: string) => string, primaryKey: string[], keys: unknown[][]): { sql: string; values: unknown[] } {
    if (!keys.length) return { sql: '1 = 0', values: [] };
    return {
        sql: keys.map(() => `(${primaryKey.map(c => `${q(c)} = ?`).join(' AND ')})`).join(' OR '),
        values: keys.flat(),
    };
}

const keyValues = (text: string, primaryKey: string[]) => {
    const row = decodeRow(text);
    return primaryKey.map(c => row[c] ?? null);
};

/** Rows of the table now, for the keys the change touched, by key */
async function currentRows(session: Session, q: (name: string) => string, t: UndoTable): Promise<Map<string, Row>> {
    const texts = [...t.before, ...t.after];
    const keys = [...new Map(texts.map(text => [rowKey(text, t.primaryKey), keyValues(text, t.primaryKey)])).values()];
    const found = new Map<string, Row>();
    for (let i = 0; i < keys.length; i += 500) {
        const match = byKeys(q, t.primaryKey, keys.slice(i, i + 500));
        for (const row of await session.rows(`SELECT * FROM ${q(t.table)} WHERE ${match.sql}`, match.values)) {
            found.set(rowKey(encodeRow(row), t.primaryKey), row);
        }
    }
    return found;
}

/** A row for the journal window: values short and readable */
function shown(row: Row): Row {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
        v instanceof Uint8Array ? `[${v.length} bytes]` : typeof v === 'bigint' ? v.toString() : typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v]));
}

/** Rows that are no longer as the change left them */
async function findConflicts(session: Session, q: (name: string) => string, tables: UndoTable[]): Promise<UndoConflict[]> {
    const conflicts: UndoConflict[] = [];
    for (const t of tables) {
        const now = await currentRows(session, q, t);
        const afterKeys = new Set(t.after.map(text => rowKey(text, t.primaryKey)));
        for (const text of t.after) {
            const current = now.get(rowKey(text, t.primaryKey));
            if (!current) conflicts.push({ table: `${t.schema}.${t.table}`, kind: 'missing', row: shown(decodeRow(text)) });
            else if (!sameRow(current, text)) conflicts.push({ table: `${t.schema}.${t.table}`, kind: 'changed', row: shown(current) });
        }
        for (const text of t.before) {
            const key = rowKey(text, t.primaryKey);
            const current = now.get(key);
            if (!afterKeys.has(key) && current) conflicts.push({ table: `${t.schema}.${t.table}`, kind: 'reappeared', row: shown(current) });
        }
        if (conflicts.length >= 20) break;
    }
    return conflicts.slice(0, 20);
}

const counts = (t: UndoTable) => {
    const afterKeys = new Set(t.after.map(text => rowKey(text, t.primaryKey)));
    const beforeKeys = new Set(t.before.map(text => rowKey(text, t.primaryKey)));
    return {
        toDelete: t.after.filter(text => !beforeKeys.has(rowKey(text, t.primaryKey))).length,
        toRestore: t.before.filter(text => !afterKeys.has(rowKey(text, t.primaryKey))).length,
        toRevert: t.before.filter(text => afterKeys.has(rowKey(text, t.primaryKey))).length,
    };
};

/** What undoing does, per table, and the rows changed since */
export async function previewSqlUndo(engine: string, databaseId: string, tables: UndoTable[]) {
    const q = (name: string) => quoteIdent(name, dialectOf(engine));
    return withSession(engine, databaseId, false, async session => ({
        tables: tables.map(t => ({
            table: `${t.schema}.${t.table}`,
            primaryKey: t.primaryKey,
            ...counts(t),
            before: t.before.slice(0, 20).map(text => shown(decodeRow(text))),
            after: t.after.slice(0, 20).map(text => shown(decodeRow(text))),
        })),
        conflicts: await findConflicts(session, q, tables),
    }));
}

/** Undoes the change, or returns the conflicts that stop it */
export async function undoSqlChange(engine: string, databaseId: string, tables: UndoTable[]): Promise<{ conflicts?: UndoConflict[]; restored?: Record<string, { deleted: number; restored: number; reverted: number }> }> {
    const q = (name: string) => quoteIdent(name, dialectOf(engine));
    try {
        return await withSession(engine, databaseId, true, async session => {
            const conflicts = await findConflicts(session, q, tables);
            if (conflicts.length) throw Object.assign(new Error('conflicts'), { conflicts });
            const restored: Record<string, { deleted: number; restored: number; reverted: number }> = {};
            const stat = (t: UndoTable) => (restored[`${t.schema}.${t.table}`] ??= { deleted: 0, restored: 0, reverted: 0 });
            // Rows the change inserted: children first
            for (const t of [...tables].reverse()) {
                const beforeKeys = new Set(t.before.map(text => rowKey(text, t.primaryKey)));
                for (const text of t.after.filter(row => !beforeKeys.has(rowKey(row, t.primaryKey)))) {
                    const match = byKeys(q, t.primaryKey, [keyValues(text, t.primaryKey)]);
                    stat(t).deleted += await session.run(`DELETE FROM ${q(t.table)} WHERE ${match.sql}`, match.values);
                }
            }
            // Rows the change deleted: parents first; rows it updated: their previous values
            for (const t of tables) {
                const writable = new Set(await session.writable(t.table));
                const afterKeys = new Set(t.after.map(text => rowKey(text, t.primaryKey)));
                for (const text of t.before) {
                    const row = decodeRow(text);
                    const columns = Object.keys(row).filter(c => writable.has(c));
                    if (!afterKeys.has(rowKey(text, t.primaryKey))) {
                        await session.run(`INSERT INTO ${q(t.table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(c => row[c]));
                        stat(t).restored += 1;
                    } else {
                        const set = columns.filter(c => !t.primaryKey.includes(c));
                        if (!set.length) continue;
                        const match = byKeys(q, t.primaryKey, [keyValues(text, t.primaryKey)]);
                        stat(t).reverted += await session.run(`UPDATE ${q(t.table)} SET ${set.map(c => `${q(c)} = ?`).join(', ')} WHERE ${match.sql}`, [...set.map(c => row[c]), ...match.values]);
                    }
                }
            }
            return { restored };
        });
    } catch (error) {
        const conflicts = (error as { conflicts?: UndoConflict[] }).conflicts;
        if (conflicts) return { conflicts };
        throw error;
    }
}

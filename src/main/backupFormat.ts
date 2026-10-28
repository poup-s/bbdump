/**
 * Which engine wrote a backup file, from its first bytes (inside the gzip stream for a gzipped one). Every engine writes
 * `<id>_<timestamp>.backup`, so a PostgreSQL dump never reaches mongorestore (and the
 * other way round), even for a file whose database was removed.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

export type ArchiveEngine = 'postgresql' | 'mongodb' | 'mysql' | 'mariadb' | 'sqlite';

/** The first line bbdump writes before a MySQL / MariaDB dump (inside the gzip stream) */
export const sqlDumpHeader = (engine: 'mysql' | 'mariadb') => `-- bbdump: ${engine} dump`;

/** Bytes read to recognize a file (a gzip stream is inflated that far) */
export const ARCHIVE_HEAD_BYTES = 4096;

/**
 * pg_dump custom format; a SQLite database file; gzip: a MySQL / MariaDB dump written by bbdump
 * (its first line), otherwise mongodump --archive --gzip; mongodump --archive (its magic).
 */
export function archiveEngineOf(head: Uint8Array): ArchiveEngine | undefined {
    const text = (from: Uint8Array, length: number) => String.fromCharCode(...from.slice(0, length));
    if (head.length >= 5 && text(head, 5) === 'PGDMP') return 'postgresql';
    if (head.length >= 16 && text(head, 16) === 'SQLite format 3\0') return 'sqlite';
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        let inflated: Uint8Array = new Uint8Array();
        try {
            // A prefix of the stream: what it holds so far
            inflated = zlib.gunzipSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch { /* too short to say: older backups are mongodump archives */ }
        const first = text(inflated, 40);
        if (first.startsWith(sqlDumpHeader('mysql'))) return 'mysql';
        if (first.startsWith(sqlDumpHeader('mariadb'))) return 'mariadb';
        return 'mongodb';
    }
    if (head.length >= 4 && head[0] === 0x6d && head[1] === 0xe2 && head[2] === 0x99 && head[3] === 0x81) return 'mongodb';
    return undefined;
}

/** A gzip stream (mongodump --gzip); false when unreadable */
export function isGzipFile(file: string): boolean {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(2);
        return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b;
    } catch {
        return false;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** Undefined when unreadable or not recognized (an encrypted file is read once decrypted) */
export function readArchiveEngine(file: string): ArchiveEngine | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(ARCHIVE_HEAD_BYTES);
        const read = fs.readSync(fd, head, 0, ARCHIVE_HEAD_BYTES, 0);
        return archiveEngineOf(head.subarray(0, read));
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

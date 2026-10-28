/**
 * Which engine wrote a backup file, from its first bytes. Every engine writes
 * `<id>_<timestamp>.backup`, so a PostgreSQL dump never reaches mongorestore (and the
 * other way round), even for a file whose database was removed.
 */
import * as fs from 'fs';

/** pg_dump custom format; mongodump --archive --gzip (gzip); mongodump --archive (its magic, little-endian) */
export function archiveEngineOf(head: Uint8Array): 'postgresql' | 'mongodb' | undefined {
    if (head.length >= 5 && String.fromCharCode(...head.slice(0, 5)) === 'PGDMP') return 'postgresql';
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'mongodb';
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
export function readArchiveEngine(file: string): 'postgresql' | 'mongodb' | undefined {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(5);
        const read = fs.readSync(fd, head, 0, 5, 0);
        return archiveEngineOf(head.subarray(0, read));
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

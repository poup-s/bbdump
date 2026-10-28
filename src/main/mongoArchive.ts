/**
 * Reads a mongodump archive (`--archive`, gzip or not) from start to end without restoring it:
 * mongorestore --dryRun accepts a truncated archive, so bbdump checks it itself.
 *
 * Layout: magic number, prelude (archive header, one metadata document per collection, then a
 * terminator), then blocks: a namespace header {db, collection, EOF}, its documents, a terminator.
 * Every collection of the prelude ends with an EOF header. gzip's own CRC covers corruption;
 * this walk catches an archive that stops early or is not an archive.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { isGzipFile } from './backupFormat';

export interface ArchiveSummary {
    /** "db.collection" → documents */
    collections: Record<string, number>;
    documents: number;
}

const MAGIC = 0x8199e26d;
const TERMINATOR = -1;
/** BSON documents are at most 16 MiB; generous margin */
const MAX_DOCUMENT = 64 * 1024 * 1024;

type Deserialize = (bytes: Uint8Array) => Record<string, unknown>;

export class MongoArchiveWalker {
    private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    private state: 'magic' | 'prelude' | 'header' | 'body' | 'eof' = 'magic';
    private sawArchiveHeader = false;
    private current = '';
    private readonly declared = new Set<string>();
    private readonly ended = new Set<string>();
    readonly collections: Record<string, number> = {};
    documents = 0;

    constructor(private readonly deserialize: Deserialize) {}

    push(chunk: Buffer): void {
        this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        let offset = 0;
        for (;;) {
            if (this.state === 'magic') {
                if (this.pending.length - offset < 4) break;
                if (this.pending.readUInt32LE(offset) !== MAGIC) throw new Error('This file is not a mongodump archive');
                offset += 4;
                this.state = 'prelude';
                continue;
            }
            if (this.pending.length - offset < 4) break;
            const size = this.pending.readInt32LE(offset);
            if (size === TERMINATOR) {
                offset += 4;
                this.terminator();
                continue;
            }
            if (size < 5 || size > MAX_DOCUMENT) throw new Error('The archive is damaged (invalid document size)');
            if (this.pending.length - offset < size) break;
            const document = this.pending.subarray(offset, offset + size);
            if (document[size - 1] !== 0) throw new Error('The archive is damaged (unterminated document)');
            offset += size;
            this.document(document);
        }
        this.pending = this.pending.subarray(offset);
    }

    private terminator(): void {
        if (this.state === 'prelude') {
            if (!this.sawArchiveHeader) throw new Error('The archive has no header');
            this.state = 'header';
        } else if (this.state === 'body' || this.state === 'eof') {
            this.state = 'header';
        } else {
            throw new Error('The archive is damaged (unexpected terminator)');
        }
    }

    private document(document: Buffer): void {
        if (this.state === 'body') {
            this.collections[this.current] = (this.collections[this.current] ?? 0) + 1;
            this.documents++;
            return;
        }
        if (this.state === 'eof') throw new Error('The archive is damaged (data after the end of a collection)');
        const fields = this.deserialize(document);
        if (this.state === 'prelude') {
            if (!this.sawArchiveHeader) {
                if (typeof fields.version !== 'string') throw new Error('The archive has no header');
                this.sawArchiveHeader = true;
            } else if (typeof fields.db === 'string' && typeof fields.collection === 'string') {
                const ns = `${fields.db}.${fields.collection}`;
                this.declared.add(ns);
                this.collections[ns] ??= 0;
            }
            return;
        }
        // A namespace header
        if (typeof fields.db !== 'string' || typeof fields.collection !== 'string') {
            throw new Error('The archive is damaged (block without a collection)');
        }
        this.current = `${fields.db}.${fields.collection}`;
        this.collections[this.current] ??= 0;
        if (fields.EOF === true) {
            this.ended.add(this.current);
            this.state = 'eof';
        } else {
            this.state = 'body';
        }
    }

    /** Throws when the archive stopped before its end */
    finish(): ArchiveSummary {
        const unfinished = [...this.declared].filter(ns => !this.ended.has(ns));
        if (this.state !== 'header' || this.pending.length > 0 || unfinished.length) {
            throw new Error(`The archive is incomplete${unfinished.length ? ` (${unfinished.slice(0, 3).join(', ')} not finished)` : ''}`);
        }
        return { collections: this.collections, documents: this.documents };
    }
}

/** Walks the whole file; throws an Error saying what is wrong */
export async function readMongoArchive(file: string): Promise<ArchiveSummary> {
    const { BSON } = await import('mongodb');
    const walker = new MongoArchiveWalker(bytes => BSON.deserialize(bytes) as Record<string, unknown>);
    const source = fs.createReadStream(file);
    const stream = isGzipFile(file) ? source.pipe(zlib.createGunzip()) : source;
    try {
        for await (const chunk of stream) walker.push(chunk as Buffer);
    } catch (error) {
        source.destroy();
        const code = (error as { code?: string }).code;
        if (code === 'Z_BUF_ERROR') throw new Error('The archive is incomplete (compressed data ends early)');
        if (code === 'Z_DATA_ERROR') throw new Error('The archive is damaged (compressed data check failed)');
        throw error;
    }
    return walker.finish();
}

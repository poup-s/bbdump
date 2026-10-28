/**
 * MongoDB driver: connection test, size, explorer (read, aggregate, edit one document at a
 * time), backups and restore. The official driver is
 * loaded on first use only; backups use mongodump / mongorestore (MongoDB Database Tools).
 * Passwords never reach a log nor a command line: only hosts are logged, and the tools read
 * the connection from a temporary file only this user can read.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Collection, Document, MongoClient } from 'mongodb';
import { getConfig } from '../ipc/configIpc';
import { toRuntimeDatabase } from '../dbSecrets';
import { logger } from '../logger';
import { backupManager } from '../backup';
import { isGzipFile } from '../backupFormat';
import { readMongoArchive } from '../mongoArchive';
import { getErrorMessage } from '../utils';
import { withTunnel } from '../sshTunnel';
import { mongoToolVersion, requireMongoTool } from '../tools/mongoTools';
import { MONGODB } from '../../shared/engines/manifests';
import { AGGREGATE_LIMIT, AGGREGATE_MAX_LIMIT, MAX_PAGE_SIZE, SAMPLE_SIZE, describeSample, indexInfo, pipelineProblem, serverJavaScriptIn, type DocumentEdit } from '../../shared/engines/documents';
import { authSourceHint, formatMongoUri, mongoConnection, mongoOption, parseMongoUri, withMongoOption, type MongoTarget } from '../../shared/engines/mongoUri';
import type { BackupResult, DatabaseConfig } from '../../types/config';
import type { EngineDriver } from './driver';

export { authSourceHint, mongoConnection, type MongoTarget };

/**
 * The connection for mongodump / mongorestore: the database to work on as the URL's path,
 * the login unchanged (moving the path would move where the user is looked up).
 */
export function mongoToolUri(target: MongoTarget): string {
    const { uri, database } = mongoConnection(target);
    const parsed = parseMongoUri(uri);
    if (!parsed) throw new Error('This MongoDB connection string cannot be read');
    if (parsed.database === database) return uri;
    let next = parsed;
    if (parsed.username && !parsed.srv && mongoOption(parsed, 'authSource') === undefined) {
        next = withMongoOption(next, 'authSource', parsed.database || 'admin');
    }
    return formatMongoUri({ ...next, database });
}


/** First line of a driver error: server selection errors carry a whole topology dump */
function shortError(error: unknown, target: MongoTarget): Error {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300);
    const hint = /authentication failed/i.test(message) ? authSourceHint(target) : undefined;
    return new Error(hint ? `${message} ${hint}` : message);
}

async function withClient<T>(target: MongoTarget, fn: (client: MongoClient, database: string) => Promise<T>): Promise<T> {
    const { uri, database } = mongoConnection(target);
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { appName: 'bbdump', serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
    try {
        await client.connect();
        return await fn(client, database);
    } catch (error) {
        throw shortError(error, target);
    } finally {
        await client.close().catch(() => { /* already closed */ });
    }
}

/** Data and indexes on disk, null when unknown */
async function databaseSize(client: MongoClient, database: string): Promise<number | null> {
    const stats = await client.db(database).command({ dbStats: 1, scale: 1 });
    const total = Number(stats.totalSize ?? (Number(stats.storageSize ?? 0) + Number(stats.indexSize ?? 0)));
    return Number.isFinite(total) && total > 0 ? total : null;
}

/** A database as used at runtime (password decrypted) */
function targetOf(db: DatabaseConfig): MongoTarget {
    return {
        connectionString: db.connectionString,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.name,
        sslMode: db.sslMode,
        sslRootCert: db.sslRootCert,
        mongo: db.mongo,
        viaTunnel: db.viaTunnel,
    };
}

/**
 * Runs `fn` with a client on a saved database (password decrypted), through its SSH tunnel
 * when it has one (opened if needed, kept open meanwhile)
 */
function withSaved<T>(dbId: string, fn: (client: MongoClient, database: string) => Promise<T>): Promise<T> {
    const db = getConfig()?.databases?.find(d => d.id === dbId);
    if (!db) throw new Error(`Database with id "${dbId}" not found in configuration`);
    return withTunnel(toRuntimeDatabase(db), reached => withClient(targetOf(reached), fn));
}

/** Runs `fn` with a client connected to a saved MongoDB database (the AI journal's undo uses it) */
export function withSavedMongo<T>(dbId: string, fn: (client: MongoClient, database: string) => Promise<T>): Promise<T> {
    return withSaved(dbId, fn);
}

/** The connection, password included, in a file only this user can read: never on a command line */
function toolConfig(uri: string): { file: string; remove: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-mongo-'));
    const file = path.join(dir, 'tool.yaml');
    // A JSON string is a valid YAML double-quoted scalar
    fs.writeFileSync(file, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
    return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const LOG_LIMIT = 256 * 1024;
const lastLines = (text: string, count = 8) => text.trim().split(/\r?\n/).slice(-count).join('\n');

/** Runs a Database Tools command; its output goes to the database's log */
function runTool(command: string, args: string[], logName: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(command, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            logger.warn(`${path.basename(command)} took longer than ${timeoutMs} ms, stopped`, logName);
            child.kill('SIGTERM');
        }, timeoutMs);
        child.stdout.on('data', data => { stdout = (stdout + data).slice(-LOG_LIMIT); });
        child.stderr.on('data', data => {
            stderr = (stderr + data).slice(-LOG_LIMIT);
            const message = String(data).trim();
            if (message) logger.info(message, logName);
        });
        child.on('error', error => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

/**
 * Reads the whole archive back (mongorestore --dryRun accepts a truncated one, so bbdump walks
 * it itself: gzip check, then every collection to its end)
 */
async function verifyArchive(file: string, db: DatabaseConfig): Promise<{ valid: boolean; error?: string }> {
    try {
        const summary = await readMongoArchive(file);
        logger.info(`Backup verified (archive fully readable: ${summary.documents} document(s) in ${Object.keys(summary.collections).length} collection(s))`, db.name);
        return { valid: true };
    } catch (error) {
        return { valid: false, error: getErrorMessage(error) };
    }
}

/**
 * The connection for mongorestore: no database in the path (mongorestore would only restore
 * that database's collections, i.e. nothing once renamed), the login kept explicit.
 */
export function mongoRestoreUri(target: MongoTarget): string {
    const parsed = parseMongoUri(mongoConnection(target).uri);
    if (!parsed) throw new Error('This MongoDB connection string cannot be read');
    let next = parsed;
    if (parsed.username && !parsed.srv && mongoOption(parsed, 'authSource') === undefined) {
        next = withMongoOption(next, 'authSource', parsed.database || 'admin');
    }
    return formatMongoUri({ ...next, database: undefined });
}

const RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;
const COUNT_TIMEOUT_MS = 5_000;
const AGGREGATE_TIMEOUT_MS = 30_000;

/** A collection name from the explorer (never an operator or an empty name) */
function collectionName(name: unknown): string {
    if (typeof name !== 'string' || !name || name.includes('\0') || name.startsWith('$')) throw new Error('Invalid collection name');
    return name;
}

/** The user's JSON filter as a query; server-side JavaScript is refused */
async function parseFilter(text: string | undefined): Promise<Record<string, unknown>> {
    if (!text || !text.trim()) return {};
    let plain: unknown;
    try {
        plain = JSON.parse(text);
    } catch (error) {
        throw new Error(`The filter is not valid JSON: ${getErrorMessage(error)}`);
    }
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) throw new Error('The filter must be a JSON object, e.g. {"city": "Paris"}');
    const javascript = serverJavaScriptIn(plain);
    if (javascript) throw new Error(`${javascript} runs JavaScript on the server: not allowed here`);
    // Extended JSON: {"$oid": …} becomes an ObjectId, {"$date": …} a date
    const { BSON } = await import('mongodb');
    return BSON.EJSON.parse(text, { relaxed: false }) as Record<string, unknown>;
}

/** The user's JSON text as one document (Extended JSON kept: {"$oid": …}, {"$date": …}) */
async function parseDocument(text: string): Promise<Document> {
    let plain: unknown;
    try {
        plain = JSON.parse(text);
    } catch (error) {
        throw new Error(`The document is not valid JSON: ${getErrorMessage(error)}`);
    }
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) throw new Error('The document must be a JSON object, e.g. {"name": "Camille"}');
    const operator = Object.keys(plain).find(key => key.startsWith('$'));
    if (operator) throw new Error(`"${operator}" cannot be a field name of a document`);
    const { BSON } = await import('mongodb');
    return BSON.EJSON.parse(text, { relaxed: false }) as Document;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The edited document with the BSON types of what it kept from the stored one: the editor
 * shows relaxed JSON (5.0 reads 5, a long reads as a number), which must not turn a double
 * into an integer on save. A changed number keeps the double / long type of the old one.
 */
export async function keepTypes(next: unknown, current: unknown): Promise<unknown> {
    if (current === undefined) return next;
    const { BSON } = await import('mongodb');
    const relaxed = (value: unknown) => BSON.EJSON.stringify(value as Document, { relaxed: true });
    if (relaxed(next) === relaxed(current)) return current;
    if (Array.isArray(next) && Array.isArray(current)) return Promise.all(next.map((item, i) => keepTypes(item, current[i])));
    if (isPlainObject(next) && isPlainObject(current)) {
        const entries = await Promise.all(Object.entries(next).map(async ([key, value]) => [key, await keepTypes(value, current[key])] as const));
        return Object.fromEntries(entries);
    }
    const bsonType = (value: unknown) => (value as { _bsontype?: string } | null)?._bsontype;
    const number = typeof next === 'number' ? next : bsonType(next) === 'Int32' ? Number((next as { value: number }).value) : undefined;
    if (number !== undefined && bsonType(current) === 'Double') return new BSON.Double(number);
    if (number !== undefined && Number.isInteger(number) && bsonType(current) === 'Long') return BSON.Long.fromNumber(number);
    return next;
}

/**
 * The stored document an edit is about, refused when it changed since the explorer read it.
 * The returned filter matches that exact document only (checked again by the server).
 */
async function storedDocument(collection: Collection, edit: DocumentEdit): Promise<{ current: Document; filter: Document }> {
    const { BSON } = await import('mongodb');
    if (!edit.original || typeof edit.original !== 'object' || !('_id' in edit.original)) throw new Error('This document has no _id: it cannot be changed here');
    const id = BSON.EJSON.deserialize({ id: edit.original._id }, { relaxed: false }).id;
    // promoteValues off: doubles, int32 and longs come with their BSON type (kept on save)
    const current = await collection.findOne({ _id: id }, { maxTimeMS: QUERY_TIMEOUT_MS, promoteValues: false });
    if (!current) throw new Error('This document no longer exists: reload the page');
    if (BSON.EJSON.stringify(current, { relaxed: true }) !== JSON.stringify(edit.original)) {
        throw new Error('This document changed since it was read: reload the page, then try again');
    }
    // The same document, field for field, at the time of the write
    return { current, filter: { _id: id, $expr: { $eq: ['$$ROOT', { $literal: current }] } } };
}

const CHANGED_MEANWHILE = 'This document changed meanwhile: nothing was written, reload the page';

export const mongodbDriver: EngineDriver = {
    manifest: MONGODB,

    connection: {
        test: async input => {
            logger.info(`MongoDB connection test: ${mongoConnection(input).hosts}`);
            return withClient(input, async (client, database) => {
                const db = client.db(database);
                const info = await db.command({ buildInfo: 1 });
                const collections = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
                // system.views (and other system.*) are not shown in the explorer: not counted either
                return { version: String(info.version ?? ''), tables: collections.filter(c => !c.name.startsWith('system.')).length };
            });
        },
    },

    stats: {
        size: async dbId => withSaved(dbId, databaseSize),
    },

    documents: {
        listCollections: async dbId => withSaved(dbId, async (client, database) => {
            const db = client.db(database);
            const listed = (await db.listCollections({}, { authorizedCollections: true }).toArray())
                .filter(entry => !entry.name.startsWith('system.'));
            const counts = await Promise.all(listed.map(entry => (entry.type === 'view'
                ? Promise.resolve(null)
                : db.collection(entry.name).estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }).catch(() => null))));
            return listed
                .map((entry, i) => ({ name: entry.name, type: entry.type ?? 'collection', documents: counts[i] }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }),

        find: async (dbId, query) => {
            const name = collectionName(query.collection);
            const filter = await parseFilter(query.filter);
            const limit = Math.min(Math.max(Math.trunc(Number(query.limit) || 50), 1), MAX_PAGE_SIZE);
            const skip = Math.max(Math.trunc(Number(query.skip) || 0), 0);
            const field = query.sort?.field;
            const sort = typeof field === 'string' && field && !field.startsWith('$')
                ? { [field]: query.sort?.direction === -1 ? -1 as const : 1 as const }
                : undefined;
            return withSaved(dbId, async (client, database) => {
                const { BSON } = await import('mongodb');
                const collection = client.db(database).collection(name);
                // One more than the page tells whether there is a next one
                const found = await collection.find(filter, { sort, skip, limit: limit + 1, maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
                const unfiltered = Object.keys(filter).length === 0;
                const total = await (unfiltered
                    ? collection.estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS })
                    : collection.countDocuments(filter, { maxTimeMS: COUNT_TIMEOUT_MS })).catch(() => null);
                return {
                    documents: BSON.EJSON.serialize(found.slice(0, limit), { relaxed: true }) as Record<string, unknown>[],
                    total,
                    totalIsEstimate: unfiltered,
                    skip,
                    limit,
                    hasMore: found.length > limit,
                };
            });
        },

        describe: async (dbId, collectionToDescribe) => {
            const name = collectionName(collectionToDescribe);
            return withSaved(dbId, async (client, database) => {
                const { BSON } = await import('mongodb');
                const collection = client.db(database).collection(name);
                const total = await collection.estimatedDocumentCount({ maxTimeMS: COUNT_TIMEOUT_MS }).catch(() => null);
                // A random sample: the fields of a large collection without reading all of it
                const sample = await collection.aggregate([{ $sample: { size: SAMPLE_SIZE } }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
                const indexes = await collection.indexes().catch(() => []);
                return {
                    sampled: sample.length,
                    total,
                    fields: describeSample(BSON.EJSON.serialize(sample, { relaxed: true }) as Record<string, unknown>[]),
                    indexes: indexes.map(index => indexInfo(index as Record<string, unknown>)),
                };
            });
        },

        aggregate: async (dbId, query) => {
            const name = collectionName(query.collection);
            let plain: unknown;
            try {
                plain = JSON.parse(query.pipeline || '[]');
            } catch (error) {
                throw new Error(`The pipeline is not valid JSON: ${getErrorMessage(error)}`);
            }
            const problem = pipelineProblem(plain);
            if (problem) throw new Error(problem);
            const limit = Math.min(Math.max(Math.trunc(Number(query.limit) || AGGREGATE_LIMIT), 1), AGGREGATE_MAX_LIMIT);
            return withSaved(dbId, async (client, database) => {
                const { BSON } = await import('mongodb');
                const stages = BSON.EJSON.parse(query.pipeline, { relaxed: false }) as Document[];
                const started = Date.now();
                // One more than shown tells whether there were more
                const found = await client.db(database).collection(name)
                    .aggregate([...stages, { $limit: limit + 1 }], { maxTimeMS: AGGREGATE_TIMEOUT_MS })
                    .toArray();
                return {
                    documents: BSON.EJSON.serialize(found.slice(0, limit), { relaxed: true }) as Record<string, unknown>[],
                    truncated: found.length > limit,
                    limit,
                    durationMs: Date.now() - started,
                };
            });
        },
    },

    documentWrites: {
        insert: async (dbId, collectionToChange, text) => {
            const name = collectionName(collectionToChange);
            const document = await parseDocument(text);
            return withSaved(dbId, async (client, database) => {
                const { BSON } = await import('mongodb');
                const inserted = await client.db(database).collection(name).insertOne(document);
                logger.info(`Document added to ${name}`, database);
                return { id: (BSON.EJSON.serialize({ id: inserted.insertedId }, { relaxed: true }) as { id: unknown }).id };
            });
        },

        replace: async (dbId, edit) => {
            const name = collectionName(edit.collection);
            const next = await parseDocument(edit.next ?? '');
            return withSaved(dbId, async (client, database) => {
                const { BSON } = await import('mongodb');
                const collection = client.db(database).collection(name);
                const { current, filter } = await storedDocument(collection, edit);
                if ('_id' in next && BSON.EJSON.stringify({ id: next._id }, { relaxed: true }) !== JSON.stringify({ id: edit.original._id })) {
                    throw new Error('The _id of a document cannot be changed: add a new document instead');
                }
                const { _id: _ignored, ...fields } = (await keepTypes(next, current)) as Document;
                const result = await collection.replaceOne(filter, { _id: current._id, ...fields });
                if (result.matchedCount === 0) throw new Error(CHANGED_MEANWHILE);
                logger.info(`Document changed in ${name}`, database);
                const saved = await collection.findOne({ _id: current._id });
                return { document: BSON.EJSON.serialize(saved ?? {}, { relaxed: true }) as Record<string, unknown> };
            });
        },

        remove: async (dbId, edit) => {
            const name = collectionName(edit.collection);
            await withSaved(dbId, async (client, database) => {
                const collection = client.db(database).collection(name);
                const { filter } = await storedDocument(collection, edit);
                const result = await collection.deleteOne(filter);
                if (result.deletedCount === 0) throw new Error(CHANGED_MEANWHILE);
                logger.info(`Document deleted from ${name}`, database);
            });
        },
    },

    backup: {
        /** One gzip archive per backup (`<id>_<timestamp>.backup`), like a PostgreSQL dump */
        dump: async db => {
            const timestamp = new Date().toISOString();
            const fail = (error: string): BackupResult => {
                logger.error(error, db.name);
                return { success: false, database: db.name, timestamp, error };
            };
            const target = targetOf(db);
            let mongodump: string;
            let uri: string;
            try {
                mongodump = await requireMongoTool('mongodump');
                uri = mongoToolUri(target);
            } catch (error) {
                return fail(getErrorMessage(error));
            }

            const prepared = await backupManager.prepareBackupFile(db, timestamp, () => withClient(target, databaseSize).catch(() => null));
            if ('failure' in prepared) return prepared.failure;

            logger.info(`Using mongodump ${await mongoToolVersion(mongodump) ?? ''} on ${mongoConnection(target).hosts}`, db.name);
            const config = toolConfig(uri);
            try {
                return await backupManager.runDumpProcess(db, {
                    command: mongodump,
                    label: 'mongodump',
                    args: [`--config=${config.file}`, `--archive=${prepared.file}`, '--gzip'],
                    env: process.env,
                    file: prepared.file,
                    timestamp,
                    verify: file => verifyArchive(file, db),
                });
            } finally {
                config.remove();
            }
        },
    },

    restore: {
        /**
         * Restores into the target database whatever database the archive came from. Replacing
         * drops each collection the backup holds before loading it (other collections stay);
         * there is no transaction across collections, hence "back up first" in the dialog.
         */
        restore: async (backupFile, target, options = {}) => {
            const timestamp = new Date().toISOString();
            const fail = (error: string, output?: string): BackupResult => {
                logger.error(error, target.name);
                return { success: false, database: target.name, timestamp, error, output };
            };
            let mongorestore: string;
            try {
                mongorestore = await requireMongoTool('mongorestore');
            } catch (error) {
                return fail(getErrorMessage(error));
            }

            const opened = await backupManager.openBackupForRestore(backupFile, target.name, 'mongodb', timestamp);
            if ('failure' in opened) return opened.failure;
            let config: { file: string; remove: () => void } | undefined;
            try {
                // A damaged archive is refused before --drop touches anything
                let expected: number;
                try {
                    expected = (await readMongoArchive(opened.file)).documents;
                } catch (error) {
                    return fail(`${getErrorMessage(error)}: nothing was changed`);
                }
                config = toolConfig(mongoRestoreUri({ ...target, database: target.name }));
                const replace = options.replace !== false;
                const args = [
                    `--config=${config.file}`,
                    `--archive=${opened.file}`,
                    ...(isGzipFile(opened.file) ? ['--gzip'] : []),
                    // Into the target, whatever the source database was called
                    '--nsFrom=$db$.$coll$',
                    `--nsTo=${target.name}.$coll$`,
                    ...(replace ? ['--drop'] : []),
                ];
                logger.info(`[restore] mongorestore into ${target.name}${replace ? ', collections replaced' : ''}`, target.name);
                const result = await runTool(mongorestore, args, target.name, RESTORE_TIMEOUT_MS);
                const output = result.stdout + result.stderr;
                if (result.code !== 0) return fail(`mongorestore failed with code ${result.code}\n${lastLines(result.stderr)}`, output);

                const restored = Number(output.match(/(\d+) document\(s\) restored successfully/)?.[1] ?? 0);
                const failed = Number(output.match(/(\d+) document\(s\) failed to restore/)?.[1] ?? 0);
                // A restore that loads fewer documents than the archive holds is not a success
                if (restored + failed < expected) {
                    return fail(`Only ${restored} of the ${expected} document(s) of the backup were restored (see the logs)`, output);
                }
                const message = `Restore successful from ${backupFile} to ${target.name} (${restored} document(s))`;
                logger.info(message, target.name);
                return failed > 0
                    ? { success: true, database: target.name, timestamp, message, output, warnings: [`${failed} document(s) failed to restore (see the logs)`] }
                    : { success: true, database: target.name, timestamp, message, output };
            } catch (error) {
                return fail(`Restore failed: ${getErrorMessage(error)}`);
            } finally {
                config?.remove();
                opened.cleanup();
            }
        },
    },
};

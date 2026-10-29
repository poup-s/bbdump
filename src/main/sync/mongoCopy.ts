/**
 * Copy and "Update from…" for MongoDB, done by bbdump itself with the driver (no
 * mongodump): collections with their options (validators, capped, time series, collation),
 * the documents in batches, indexes, then views. Anonymized fields are replaced as the
 * documents pass, with the same fakes as everywhere else (fakeValues.ts), their BSON type kept
 * when it can be (a date stays a date, a long a long).
 *
 * Commands are kept as Extended JSON text in the changes (`sql`): what the preview shows is
 * exactly what runs.
 */
import type { Db, Document } from 'mongodb';
import type { AnonymizeKind, AnonymizeCandidate } from './dataSync';
import type { SchemaChange } from './schemaDiff';
import type { SyncChoices, SyncProgress, SyncResult, TablePlan } from './syncEngine';
import { fakeValue } from './fakeValues';
import { replaceAtPath, SAMPLE_SIZE, describeSample } from '../../shared/engines/documents';
import { detectFieldKind, fieldKinds } from '../mongoMasking';

const BATCH = 1000;
const EXACT_LIMIT = 50_000;
const LARGE_COLLECTION = 1_000_000;

type Bson = typeof import('mongodb');
let bsonModule: Bson | null = null;
async function bson(): Promise<Bson> {
    if (!bsonModule) bsonModule = await import('mongodb');
    return bsonModule;
}

export interface MongoCollectionInfo {
    name: string;
    type: 'collection' | 'view' | 'timeseries';
    /** listCollections' options: validator, capped, timeseries, viewOn and pipeline… */
    options: Document;
    count: number;
    /** Index specifications, the _id one left out */
    indexes: Document[];
    /** Paths with a unique index of their own (their fakes must stay unique) */
    uniquePaths: Set<string>;
}

export interface MongoCatalog {
    database: string;
    collections: Map<string, MongoCollectionInfo>;
}

/** Index options a server gives back that a createIndexes must not get again */
const INDEX_INTERNAL = new Set(['v', 'ns', 'background']);

export async function readMongoCatalog(db: Db): Promise<MongoCatalog> {
    const listed = await db.listCollections({}, { authorizedCollections: true }).toArray();
    const collections = new Map<string, MongoCollectionInfo>();
    for (const c of listed) {
        // system.* (system.views, the buckets of a time series…) belong to the server
        if (c.name.startsWith('system.')) continue;
        const type = (c.type === 'view' ? 'view' : c.type === 'timeseries' ? 'timeseries' : 'collection') as MongoCollectionInfo['type'];
        const info: MongoCollectionInfo = { name: c.name, type, options: (c as { options?: Document }).options ?? {}, count: 0, indexes: [], uniquePaths: new Set() };
        if (type !== 'view') {
            const collection = db.collection(c.name);
            info.count = await collection.estimatedDocumentCount({ maxTimeMS: 10_000 }).catch(() => 0);
            const indexes = await collection.indexes().catch(() => [] as Document[]);
            info.indexes = indexes.filter(i => i.name !== '_id_').map(i => Object.fromEntries(Object.entries(i).filter(([k]) => !INDEX_INTERNAL.has(k))));
            for (const i of indexes) if (i.unique && Object.keys(i.key ?? {}).length === 1) info.uniquePaths.add(Object.keys(i.key)[0]);
        }
        collections.set(c.name, info);
    }
    return { database: db.databaseName, collections };
}

/** The create command of a collection or a view, as the source has it */
export function createCommand(info: MongoCollectionInfo): Document {
    const options = { ...info.options };
    // Given back by listCollections, refused by create
    delete options.uuid;
    if (info.type === 'view') return { create: info.name, viewOn: options.viewOn, pipeline: options.pipeline ?? [], ...(options.collation ? { collation: options.collation } : {}) };
    // A time series' bucket settings are derived by the server from its granularity
    if (options.timeseries) {
        const { timeField, metaField, granularity } = options.timeseries;
        options.timeseries = { timeField, ...(metaField ? { metaField } : {}), ...(granularity ? { granularity } : {}) };
    }
    return { create: info.name, ...options };
}

export function createIndexesCommand(collection: string, indexes: Document[]): Document {
    return { createIndexes: collection, indexes };
}

// --- Fakes -------------------------------------------------------------------------------------

/** The type the anonymization rules read a BSON value as (fakeValues' noise and rounding) */
function sqlTypeOf(value: unknown, b: Bson): string {
    if (value instanceof Date) return 'timestamp with time zone';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'double precision';
    if (value instanceof b.Long || typeof value === 'bigint') return 'bigint';
    if (value instanceof b.Decimal128) return 'numeric';
    if (value instanceof b.Int32) return 'integer';
    if (value instanceof b.Double) return 'double precision';
    return 'text';
}

/** "YYYY-MM-DD HH:MM:SS" (UTC, how fakeValue writes a date) back to a Date */
const toDate = (text: string) => new Date(`${text.trim().replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(text) ? '' : 'Z'}`);

/**
 * The fake of a BSON value. Numbers and dates keep their type (noise, rounding); text kinds
 * give text; an ObjectId, a binary or a sub-document hidden (secret) becomes text too.
 */
export function mongoFake(value: unknown, kind: AnonymizeKind, b: Bson, wide = false): unknown {
    if (kind === 'null' || value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(item => mongoFake(item, kind, b, wide));
    const type = sqlTypeOf(value, b);
    if (kind === 'noise' || kind === 'month' || kind === 'year') {
        if (value instanceof Date) {
            const out = fakeValue(value, kind, { type });
            return typeof out === 'string' ? toDate(out) : value;
        }
        if (value instanceof b.Long) return b.Long.fromNumber(Number(fakeValue(value.toNumber(), kind, { type })));
        if (typeof value === 'bigint') return BigInt(Math.round(Number(fakeValue(Number(value), kind, { type }))));
        if (value instanceof b.Decimal128) return b.Decimal128.fromString(String(fakeValue(value.toString(), kind, { type })));
        if (value instanceof b.Int32) return new b.Int32(Number(fakeValue(value.valueOf(), kind, { type })));
        if (value instanceof b.Double) return new b.Double(Number(fakeValue(value.valueOf(), kind, { type })));
        if (typeof value === 'number') return fakeValue(value, kind, { type });
        return value;
    }
    // Text kinds: the hash is made from the value's text, the same in every copy
    const text = value instanceof b.ObjectId ? value.toHexString()
        : value instanceof Date ? value.toISOString()
            : typeof value === 'object' && !(value instanceof b.Binary) ? JSON.stringify(b.BSON.EJSON.serialize(value as Document, { relaxed: true }))
                : value;
    return fakeValue(text, kind, { wide });
}

/** A function anonymizing a collection's documents, or null when none of its fields is chosen */
export async function mongoAnonymizer(kinds: Map<string, AnonymizeKind>, uniquePaths: Set<string>): Promise<((doc: Document) => Document) | null> {
    const rules = [...kinds].filter(([path]) => path !== '_id');
    if (!rules.length) return null;
    const b = await bson();
    return doc => rules.reduce(
        (out, [path, kind]) => replaceAtPath(out, path, v => mongoFake(v, kind, b, uniquePaths.has(path.replace(/\[\]/g, '')))),
        doc as Record<string, unknown>,
    ) as Document;
}

// --- Copy --------------------------------------------------------------------------------------

/** A document's _id as a key (an ObjectId, a string, a number or a sub-document) */
async function idKey(): Promise<(id: unknown) => string> {
    const b = await bson();
    return id => JSON.stringify(b.BSON.EJSON.serialize({ id }, { relaxed: false }));
}

export interface MongoCopyOptions {
    /** collection → path → kind */
    anonymize?: Map<string, Map<string, AnonymizeKind>>;
    /** Collections created without their documents */
    emptyCollections?: Set<string>;
    onProgress?: (p: { collection: string; index: number; total: number; documents: number }) => void;
}

/** Documents of a collection, in batches, by _id */
async function* readDocuments(db: Db, collection: string, filter: Document = {}): AsyncGenerator<Document[]> {
    // Numbers read as their own type (int32, double, long): written back exactly
    const cursor = db.collection(collection).find(filter, { sort: { _id: 1 }, batchSize: BATCH, promoteValues: false });
    let batch: Document[] = [];
    for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= BATCH) {
            yield batch;
            batch = [];
        }
    }
    if (batch.length) yield batch;
}

/** Inserts documents, the ones already there (same _id) skipped; returns how many went in */
async function insertDocuments(db: Db, collection: string, docs: Document[]): Promise<number> {
    if (!docs.length) return 0;
    try {
        const result = await db.collection(collection).insertMany(docs, { ordered: false, bypassDocumentValidation: true });
        return result.insertedCount;
    } catch (error) {
        // Duplicate keys only (11000): the others went in
        const failure = error as { code?: number; insertedCount?: number; result?: { insertedCount?: number }; writeErrors?: Array<{ code?: number }> | { code?: number } };
        const errors = Array.isArray(failure.writeErrors) ? failure.writeErrors : failure.writeErrors ? [failure.writeErrors] : [];
        if (errors.length && errors.every(e => e.code === 11000)) return failure.insertedCount ?? failure.result?.insertedCount ?? docs.length - errors.length;
        throw error;
    }
}

/**
 * The whole source copied into an empty target: collections (options kept), documents,
 * indexes after the documents, views last. Index failures (a fake that broke a unique index)
 * come back as warnings.
 */
export async function copyMongoDatabase(source: Db, target: Db, options: MongoCopyOptions = {}): Promise<{ documents: number; warnings: string[] }> {
    const catalog = await readMongoCatalog(source);
    const warnings: string[] = [];
    const stored = [...catalog.collections.values()].filter(c => c.type !== 'view');
    const views = [...catalog.collections.values()].filter(c => c.type === 'view');
    let documents = 0;
    for (let index = 0; index < stored.length; index++) {
        const info = stored[index];
        await target.command(createCommand(info));
        options.onProgress?.({ collection: info.name, index, total: stored.length, documents });
        if (!options.emptyCollections?.has(info.name)) {
            const anonymize = await mongoAnonymizer(options.anonymize?.get(info.name) ?? new Map(), info.uniquePaths);
            for await (const batch of readDocuments(source, info.name)) {
                documents += await insertDocuments(target, info.name, anonymize ? batch.map(anonymize) : batch);
                options.onProgress?.({ collection: info.name, index, total: stored.length, documents });
            }
        }
        if (info.indexes.length) {
            try {
                await target.command(createIndexesCommand(info.name, info.indexes));
            } catch (error) {
                warnings.push(`${info.name}: indexes not created (${error instanceof Error ? error.message : String(error)})`);
            }
        }
    }
    // Views may read each other: a few rounds until all exist
    let pending = views;
    for (let round = 0; round < 4 && pending.length; round++) {
        const failed: MongoCollectionInfo[] = [];
        for (const view of pending) {
            try {
                await target.command(createCommand(view));
            } catch {
                failed.push(view);
            }
        }
        pending = failed;
    }
    for (const view of pending) warnings.push(`${view.name}: view not created`);
    return { documents, warnings };
}

// --- Update from… ------------------------------------------------------------------------------

/** A command as readable Extended JSON (1, not {"$numberInt":"1"}); dates and ObjectIds keep their tag */
const ejson = async (command: Document) => JSON.stringify((await bson()).BSON.EJSON.serialize(command, { relaxed: true }));

/** What the target lacks: collections, indexes (by name), views; collections only it has (not chosen) */
export async function diffMongoSchemas(src: MongoCatalog, tgt: MongoCatalog): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];
    let n = 0;
    const add = (change: Omit<SchemaChange, 'id' | 'defaultSelected'>) => changes.push({ id: `m${n++}`, defaultSelected: !change.destructive, ...change });
    for (const info of src.collections.values()) {
        const local = tgt.collections.get(info.name);
        if (info.type === 'view') {
            if (!local) add({ kind: 'view', object: info.name, sql: [await ejson(createCommand(info))], destructive: false, phase: 8 });
            continue;
        }
        if (!local) {
            const sql = [await ejson(createCommand(info))];
            if (info.indexes.length) sql.push(await ejson(createIndexesCommand(info.name, info.indexes)));
            add({ kind: 'table', object: info.name, sql, destructive: false, phase: 3 });
            continue;
        }
        for (const index of info.indexes) {
            if (local.indexes.some(i => i.name === index.name)) continue;
            add({
                kind: 'index', object: `${info.name}.${index.name}`, sql: [await ejson(createIndexesCommand(info.name, [index]))], destructive: false, phase: 6,
                ...(index.unique ? { note: 'existing documents must be unique', noteCode: 'must_satisfy' as const } : {}),
            });
        }
    }
    for (const local of tgt.collections.values()) {
        if (src.collections.has(local.name)) continue;
        add({ kind: 'local_only_table', object: local.name, sql: [await ejson({ drop: local.name })], destructive: true, phase: 10, note: 'only in the local database', noteCode: 'local_only' });
    }
    return changes.sort((a, b) => a.phase - b.phase);
}

/** A date field of the sample to keep "the last days" by (created_at…), else the ObjectIds' time */
export function mongoTimeField(fields: Array<{ path: string; types: Array<{ type: string }> }>, idIsObjectId: boolean): string | undefined {
    const dated = fields.filter(f => !f.path.includes('[]') && f.types[0]?.type === 'date').map(f => f.path);
    const pick = dated.find(p => /^(created|inserted)(_?at|_?on|_?date)?$/i.test(p))
        ?? dated.find(p => /created|inserted/i.test(p))
        ?? dated.find(p => /(_at|At|_on|date|Date)$/.test(p));
    return pick ?? (idIsObjectId ? '_id' : undefined);
}

async function sampleFields(db: Db, collection: string) {
    const b = await bson();
    const sample = await db.collection(collection).aggregate([{ $sample: { size: SAMPLE_SIZE } }], { maxTimeMS: 15_000 }).toArray();
    return {
        fields: describeSample(b.BSON.EJSON.serialize(sample, { relaxed: true }) as Record<string, unknown>[]),
        idIsObjectId: sample.length > 0 && sample.every(d => d._id instanceof b.ObjectId),
    };
}

async function idSet(db: Db, collection: string): Promise<Set<string>> {
    const key = await idKey();
    const have = new Set<string>();
    for await (const doc of db.collection(collection).find({}, { projection: { _id: 1 }, batchSize: 5000, promoteValues: false })) have.add(key(doc._id));
    return have;
}

export async function analyzeMongoSync(source: Db, target: Db): Promise<{ schema: SchemaChange[]; tables: TablePlan[]; anonymize: AnonymizeCandidate[] }> {
    const src = await readMongoCatalog(source);
    const tgt = await readMongoCatalog(target);
    const tables: TablePlan[] = [];
    const anonymize: AnonymizeCandidate[] = [];
    const key = await idKey();
    for (const info of src.collections.values()) {
        if (info.type === 'view') continue;
        const local = tgt.collections.get(info.name);
        const { fields, idIsObjectId } = await sampleFields(source, info.name);
        const sourceRows = await source.collection(info.name).countDocuments({}, { maxTimeMS: 30_000 }).catch(() => info.count);
        const localRows = local ? await target.collection(info.name).countDocuments({}, { maxTimeMS: 30_000 }).catch(() => local.count) : 0;
        const plan: TablePlan = {
            key: info.name, newTable: !local, primaryKey: ['_id'], sourceRows, localRows,
            missing: null, missingExact: false, timeColumn: mongoTimeField(fields, idIsObjectId), defaultSelected: false,
        };
        if (!local || localRows === 0) { plan.missing = sourceRows; plan.missingExact = true; }
        else if (sourceRows <= EXACT_LIMIT) {
            const have = await idSet(target, info.name);
            let missing = 0;
            for await (const doc of source.collection(info.name).find({}, { projection: { _id: 1 }, batchSize: 5000, promoteValues: false })) if (!have.has(key(doc._id))) missing++;
            plan.missing = missing;
            plan.missingExact = true;
        } else {
            plan.missing = Math.max(0, sourceRows - localRows);
        }
        if (plan.missing === 0 && plan.missingExact) plan.reason = 'up_to_date';
        if (sourceRows > LARGE_COLLECTION) plan.reason = 'too_large';
        plan.defaultSelected = !!plan.missing && sourceRows <= LARGE_COLLECTION;
        tables.push(plan);
        for (const field of fields) {
            if (field.path === '_id') continue;
            const type = field.types[0]?.type ?? 'null';
            const unique = info.uniquePaths.has(field.path.replace(/\[\]/g, ''));
            const kind = detectFieldKind(info.name, field.path, type, unique);
            if (kind && fieldKinds(type, unique).includes(kind)) anonymize.push({ table: info.name, column: field.path, kind });
        }
    }
    return { schema: await diffMongoSchemas(src, tgt), tables: tables.sort((a, b) => a.key.localeCompare(b.key)), anonymize };
}

export async function applyMongoSync(
    source: Db,
    target: Db,
    choices: Pick<SyncChoices, 'changes' | 'tables' | 'anonymize'>,
    onProgress: (p: SyncProgress) => void,
): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
    const b = await bson();
    const result: Pick<SyncResult, 'schema' | 'tables'> = { schema: { applied: 0, failed: [] }, tables: [] };
    const src = await readMongoCatalog(source);
    const wanted = new Set(choices.changes);
    // From the source as it is now (the analysis may be minutes old)
    const changes = (await diffMongoSchemas(src, await readMongoCatalog(target))).filter(c => wanted.has(c.id));
    let done = 0;
    for (const change of changes) {
        onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
        try {
            for (const command of change.sql) await target.command(b.BSON.EJSON.parse(command, { relaxed: false }) as Document);
            result.schema.applied++;
        } catch (error) {
            result.schema.failed.push({ id: change.id, error: error instanceof Error ? error.message : String(error) });
        }
        done++;
    }
    onProgress({ stage: 'schema', done, total: changes.length });

    const tgt = await readMongoCatalog(target);
    const key = await idKey();
    const chosen = choices.tables.filter(t => src.collections.has(t.key) && src.collections.get(t.key)!.type !== 'view');
    for (let index = 0; index < chosen.length; index++) {
        const { key: name, recentDays } = chosen[index];
        const info = src.collections.get(name)!;
        const outcome: SyncResult['tables'][number] = { key: name, copied: 0, skipped: 0 };
        result.tables.push(outcome);
        if (!tgt.collections.has(name)) { outcome.error = 'the collection does not exist locally (its change was not applied)'; continue; }
        try {
            const kinds = new Map(choices.anonymize.filter(a => a.table === name).map(a => [a.column, a.kind as AnonymizeKind] as const));
            const anonymize = await mongoAnonymizer(kinds, info.uniquePaths);
            let filter: Document = {};
            if (recentDays) {
                const since = new Date(Date.now() - recentDays * 86400_000);
                const { fields, idIsObjectId } = await sampleFields(source, name);
                const field = mongoTimeField(fields, idIsObjectId);
                if (field === '_id') filter = { _id: { $gte: b.ObjectId.createFromTime(Math.floor(since.getTime() / 1000)) } };
                else if (field) filter = { [field]: { $gte: since } };
            }
            const have = await idSet(target, name);
            for await (const batch of readDocuments(source, name, filter)) {
                const missing = batch.filter(d => !have.has(key(d._id)));
                const written = await insertDocuments(target, name, anonymize ? missing.map(anonymize) : missing);
                outcome.copied += written;
                outcome.skipped += missing.length - written;
                onProgress({ stage: 'data', table: name, index, total: chosen.length, copied: outcome.copied, skipped: outcome.skipped });
            }
        } catch (error) {
            outcome.error = error instanceof Error ? error.message : String(error);
        }
        onProgress({ stage: 'data', table: name, index: index + 1, total: chosen.length, copied: outcome.copied, skipped: outcome.skipped });
    }
    return result;
}

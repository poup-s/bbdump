/**
 * Document databases (MongoDB) in the explorer: what the main process sends the renderer, and
 * pure helpers both use. Documents travel as relaxed Extended JSON (ObjectId → {"$oid": …},
 * dates → {"$date": …}, other numbers plain), which survives IPC and keeps every BSON type.
 */

export interface CollectionInfo {
    name: string;
    /** collection, view, timeseries */
    type: string;
    /** Estimated; null for a view or when unknown */
    documents: number | null;
}

export interface DocumentQuery {
    collection: string;
    /** A JSON filter as typed by the user, e.g. {"city": "Paris"}; empty: every document */
    filter?: string;
    sort?: { field: string; direction: 1 | -1 };
    skip?: number;
    limit?: number;
}

export interface DocumentPage {
    documents: Record<string, unknown>[];
    /** Estimated without a filter, counted with one (null when the count took too long) */
    total: number | null;
    totalIsEstimate: boolean;
    skip: number;
    limit: number;
    hasMore: boolean;
}

export interface AggregateQuery {
    collection: string;
    /** A JSON array of stages as typed by the user, e.g. [{"$group": {"_id": "$city"}}] */
    pipeline: string;
    /** Results kept, AGGREGATE_LIMIT by default, at most AGGREGATE_MAX_LIMIT */
    limit?: number;
}

export interface AggregateResult {
    documents: Record<string, unknown>[];
    /** More results than AGGREGATE_LIMIT: only the first ones are shown */
    truncated: boolean;
    limit: number;
    /** Milliseconds, as seen by bbdump */
    durationMs: number;
}

export const AGGREGATE_LIMIT = 500;
/** Dashboards read up to 1000 rows, like a PostgreSQL query */
export const AGGREGATE_MAX_LIMIT = 1000;

/** One document of the explorer, as it was read (relaxed Extended JSON) */
export interface DocumentEdit {
    collection: string;
    /** The document as read: the change is refused when it changed since */
    original: Record<string, unknown>;
    /** The new document as JSON text typed by the user (replace only) */
    next?: string;
}

export interface FieldInfo {
    /** Dotted path; `[]` marks the elements of an array (tags[], items[].sku) */
    path: string;
    /** Share of the sampled documents that have it, 0 to 1 */
    presence: number;
    /** Most frequent first, shares of the documents that have the field */
    types: Array<{ type: string; share: number }>;
}

export interface IndexInfo {
    name: string;
    keys: Record<string, unknown>;
    unique: boolean;
    sparse: boolean;
    partial: boolean;
    ttlSeconds?: number;
}

export interface CollectionDescription {
    sampled: number;
    total: number | null;
    fields: FieldInfo[];
    indexes: IndexInfo[];
}

export const MAX_PAGE_SIZE = 200;
export const SAMPLE_SIZE = 500;
/** Nested fields deeper than this are summed up as their parent object */
const MAX_DEPTH = 4;
const MAX_FIELDS = 300;

/** Operators that run JavaScript on the server: never accepted in a filter */
const SERVER_JS = new Set(['$where', '$function', '$accumulator']);

/** The first server-side JavaScript operator found in a filter, undefined when there is none */
export function serverJavaScriptIn(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = serverJavaScriptIn(item);
            if (found) return found;
        }
        return undefined;
    }
    if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
            if (SERVER_JS.has(key)) return key;
            const found = serverJavaScriptIn(inner);
            if (found) return found;
        }
    }
    return undefined;
}

/** Stages that write: an aggregation run to read never has them */
const WRITE_STAGES = new Set(['$out', '$merge']);

/** Why an aggregation pipeline is refused (writes, server JavaScript), undefined when it can run */
export function pipelineProblem(pipeline: unknown): string | undefined {
    if (!Array.isArray(pipeline)) return 'The pipeline must be an array of stages, e.g. [{"$match": {"city": "Paris"}}]';
    for (const stage of pipeline) {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage) || Object.keys(stage).length !== 1) {
            return 'Each stage must be an object with one operator, e.g. {"$group": {…}}';
        }
        const name = Object.keys(stage)[0];
        if (WRITE_STAGES.has(name)) return `${name} writes to the database: not allowed here`;
    }
    const javascript = serverJavaScriptIn(pipeline);
    return javascript ? `${javascript} runs JavaScript on the server: not allowed here` : undefined;
}

/** An index as listed by the driver, in a shorter form */
export function indexInfo(index: Record<string, unknown>): IndexInfo {
    return {
        name: String(index.name ?? ''),
        keys: (index.key ?? {}) as Record<string, unknown>,
        unique: index.unique === true,
        sparse: index.sparse === true,
        partial: !!index.partialFilterExpression,
        ttlSeconds: typeof index.expireAfterSeconds === 'number' ? index.expireAfterSeconds : undefined,
    };
}

/** BSON type of a relaxed Extended JSON value */
export function documentType(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
        case 'string': return 'string';
        case 'boolean': return 'bool';
        case 'number': return Number.isInteger(value) ? 'int' : 'double';
        case 'object': {
            const keys = Object.keys(value as object);
            if (keys.length === 1) {
                switch (keys[0]) {
                    case '$oid': return 'objectId';
                    case '$date': return 'date';
                    case '$numberDecimal': return 'decimal';
                    case '$numberLong': return 'long';
                    case '$numberDouble': return 'double';
                    case '$numberInt': return 'int';
                    case '$binary': return 'binary';
                    case '$uuid': return 'uuid';
                    case '$timestamp': return 'timestamp';
                    case '$regularExpression': return 'regex';
                    case '$minKey': return 'minKey';
                    case '$maxKey': return 'maxKey';
                }
            }
            return 'object';
        }
        default: return 'unknown';
    }
}

/**
 * The fields of sampled documents: dotted paths, how often each is present and with which
 * types. Paths are ordered as first seen (`_id` first), arrays describe their elements.
 */
export function describeSample(documents: Record<string, unknown>[]): FieldInfo[] {
    const stats = new Map<string, { documents: number; types: Map<string, number> }>();
    for (const document of documents) {
        // A path counts once per document, whatever the number of array elements
        const seen = new Map<string, Set<string>>();
        const visit = (value: unknown, path: string, depth: number) => {
            if (!seen.has(path) && !stats.has(path) && stats.size + seen.size >= MAX_FIELDS) return;
            const type = documentType(value);
            const types = seen.get(path) ?? new Set<string>();
            types.add(type);
            seen.set(path, types);
            if (depth >= MAX_DEPTH) return;
            if (type === 'object') {
                for (const [key, inner] of Object.entries(value as Record<string, unknown>)) visit(inner, `${path}.${key}`, depth + 1);
            } else if (type === 'array') {
                for (const item of value as unknown[]) visit(item, `${path}[]`, depth + 1);
            }
        };
        for (const [key, value] of Object.entries(document)) visit(value, key, 1);
        for (const [path, types] of seen) {
            const entry = stats.get(path) ?? { documents: 0, types: new Map<string, number>() };
            entry.documents++;
            for (const type of types) entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
            stats.set(path, entry);
        }
    }
    const total = documents.length || 1;
    return [...stats.entries()].map(([path, entry]) => ({
        path,
        presence: entry.documents / total,
        types: [...entry.types.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, share: count / entry.documents })),
    }));
}

const MAX_CELL = 120;

/** One value, short and readable, for a table cell */
export function formatDocumentValue(value: unknown): string {
    const type = documentType(value);
    const inner = (key: string) => (value as Record<string, unknown>)[key];
    switch (type) {
        case 'null': return value === undefined ? '' : 'null';
        case 'string': return String(value).length > MAX_CELL ? `${String(value).slice(0, MAX_CELL)}…` : String(value);
        case 'int':
        case 'double':
        case 'bool': return String(value);
        case 'objectId': return `ObjectId(${String(inner('$oid'))})`;
        case 'date': {
            const raw = inner('$date');
            const text = typeof raw === 'string'
                ? raw
                : raw && typeof raw === 'object' && '$numberLong' in raw
                    ? new Date(Number((raw as { $numberLong: string }).$numberLong)).toISOString()
                    : String(raw);
            return text.replace('T', ' ').replace(/(\.000)?Z$/, ' UTC');
        }
        case 'decimal': return String(inner('$numberDecimal'));
        case 'long': return String(inner('$numberLong'));
        case 'uuid': return `UUID(${String(inner('$uuid'))})`;
        case 'binary': return 'Binary(…)';
        case 'array': return `[${(value as unknown[]).length}] ${truncateJson(value)}`;
        default: return truncateJson(value);
    }
}

function truncateJson(value: unknown): string {
    const text = JSON.stringify(value);
    return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

/** The top-level fields of a page of documents, `_id` first then as first seen */
export function documentColumns(documents: Record<string, unknown>[]): string[] {
    const columns: string[] = [];
    for (const document of documents) {
        for (const key of Object.keys(document)) if (!columns.includes(key)) columns.push(key);
    }
    return columns.includes('_id') ? ['_id', ...columns.filter(c => c !== '_id')] : columns;
}

/**
 * Undo points of MongoDB changes keep each document as canonical Extended JSON text
 * (BSON.EJSON.stringify, relaxed: false): every type comes back exactly. A document is
 * known by its _id.
 */
export function documentKey(text: string): string {
    return JSON.stringify((JSON.parse(text) as { _id?: unknown })._id ?? null);
}

/** Documents that differ between two states, keyed by _id: what an undo point keeps */
export function diffDocumentStates(before: string[], after: string[]): { before: string[]; after: string[] } {
    const was = new Map(before.map(text => [documentKey(text), text]));
    const now = new Map(after.map(text => [documentKey(text), text]));
    const out = { before: [] as string[], after: [] as string[] };
    for (const [key, text] of was) {
        const current = now.get(key);
        if (current === undefined) out.before.push(text);
        else if (current !== text) {
            out.before.push(text);
            out.after.push(current);
        }
    }
    for (const [key, text] of now) if (!was.has(key)) out.after.push(text);
    return out;
}

/** What undoing does: documents the change inserted go, those it deleted come back, those it updated revert */
export function documentUndoCounts(before: string[], after: string[]): { toDelete: number; toRestore: number; toRevert: number } {
    const beforeKeys = new Set(before.map(documentKey));
    const afterKeys = new Set(after.map(documentKey));
    return {
        toDelete: after.filter(text => !beforeKeys.has(documentKey(text))).length,
        toRestore: before.filter(text => !afterKeys.has(documentKey(text))).length,
        toRevert: before.filter(text => afterKeys.has(documentKey(text))).length,
    };
}

/** An update for updateMany: operators ($set, $inc…) or a pipeline; never a replacement nor a write stage */
export function updateProblem(update: unknown): string | undefined {
    if (Array.isArray(update)) {
        if (update.length === 0) return 'The update pipeline is empty';
        const problem = pipelineProblem(update);
        if (problem) return problem;
        const allowed = new Set(['$addFields', '$set', '$project', '$unset', '$replaceRoot', '$replaceWith']);
        const stage = update.map(s => Object.keys(s as object)[0]).find(name => !allowed.has(name));
        return stage ? `${stage} cannot be used in an update pipeline` : undefined;
    }
    if (!update || typeof update !== 'object') return 'The update must be an object of operators, e.g. {"$set": {"status": "paid"}}';
    const keys = Object.keys(update);
    if (keys.length === 0) return 'The update is empty';
    const plain = keys.find(key => !key.startsWith('$'));
    if (plain) return `"${plain}" is not an update operator: use {"$set": {"${plain}": …}} (whole-document replacement is not offered)`;
    const javascript = serverJavaScriptIn(update);
    return javascript ? `${javascript} runs JavaScript on the server: not allowed here` : undefined;
}

/** A sampled path (customer.email, items[].sku, tags[]) as steps: a field name, then how many array levels */
function pathSteps(path: string): Array<{ name: string; arrays: number }> {
    return path.split('.').map(part => {
        const match = /^(.*?)((?:\[\])*)$/.exec(part)!;
        return { name: match[1], arrays: match[2].length / 2 };
    });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * A copy of a relaxed Extended JSON document with `replace` applied to every value at a
 * sampled path (each element for a `[]` step). Missing fields stay missing.
 */
export function replaceAtPath(document: Record<string, unknown>, path: string, replace: (value: unknown) => unknown): Record<string, unknown> {
    const steps = pathSteps(path);
    const descend = (value: unknown, arrays: number, rest: typeof steps): unknown => {
        if (arrays > 0) return Array.isArray(value) ? value.map(item => descend(item, arrays - 1, rest)) : value;
        if (rest.length === 0) return replace(value);
        if (!isPlainObject(value) || !(rest[0].name in value)) return value;
        return { ...value, [rest[0].name]: descend(value[rest[0].name], rest[0].arrays, rest.slice(1)) };
    };
    return descend(document, 0, steps) as Record<string, unknown>;
}

/** Field references of an aggregation or a projection ("$customer.email"), $$ROOT / $$CURRENT included */
export function fieldReferences(value: unknown, out = new Set<string>()): Set<string> {
    if (typeof value === 'string') {
        if (/^\$\$(ROOT|CURRENT)\b/.test(value)) out.add(value);
        else if (/^\$[^$]/.test(value)) out.add(value.slice(1));
    } else if (Array.isArray(value)) {
        for (const item of value) fieldReferences(item, out);
    } else if (value && typeof value === 'object') {
        for (const inner of Object.values(value)) fieldReferences(inner, out);
    }
    return out;
}

/** Whether a field reference can carry the values of a sampled path (the field, inside it, or a parent of it) */
export function referenceReaches(reference: string, path: string): boolean {
    if (reference.startsWith('$$')) return true;
    const field = path.replace(/\[\]/g, '');
    return reference === field || reference.startsWith(`${field}.`) || field.startsWith(`${reference}.`);
}

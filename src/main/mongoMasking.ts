/**
 * What the "Anonymize for AI" dialog shows for a MongoDB database: its collections
 * and the fields found in a sample of their documents, with what each field can become and
 * the ones that look personal (same rules as PostgreSQL columns, on the field's own name).
 * The choice is saved like a PostgreSQL one: table "<database>.<collection>", column = path.
 */
import { withSavedMongo } from './engines/mongodb';
import { anonymizationCandidates, type AnonymizeKind } from './sync/dataSync';
import type { CatalogTable } from './sync/catalog';
import type { AnonymizePlan, PlanColumn } from './sync/anonymizedCopy';
import { SAMPLE_SIZE, describeSample, type FieldInfo } from '../shared/engines/documents';

const TEXT_KINDS: AnonymizeKind[] = ['partial', 'first_name', 'last_name', 'name', 'email', 'phone', 'address', 'city', 'ip', 'secret'];
/** The PostgreSQL type a BSON type is read as, for the detection by name */
const SQL_TYPE: Record<string, string> = { string: 'text', int: 'integer', long: 'bigint', double: 'double precision', decimal: 'numeric', date: 'timestamp with time zone' };

/** customerEmail → customer_email: the detection rules are written for snake_case names */
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** What a field can become, from its most frequent type; unique: no noise (two values could become equal) */
export function fieldKinds(type: string, unique: boolean): AnonymizeKind[] {
    switch (type) {
        case 'string': return [...TEXT_KINDS, 'null'];
        case 'int': case 'long': case 'double': case 'decimal': return unique ? ['null'] : ['noise', 'null'];
        case 'date': return unique ? ['null'] : ['noise', 'month', 'year', 'null'];
        case 'bool': case 'null': return [];
        // Objects, arrays, ObjectIds, binary…: hidden whole
        default: return ['secret', 'null'];
    }
}

/** The kind a field looks like from its name (customer.email → email), when it can take it */
export function detectFieldKind(collection: string, path: string, type: string, unique: boolean): AnonymizeKind | undefined {
    const parts = path.replace(/\[\]/g, '').split('.');
    const name = snake(parts[parts.length - 1] ?? '');
    const sqlType = SQL_TYPE[type];
    if (!name || !sqlType) return undefined;
    // A nested field is read in its parent's light (customer.name is a person's name)
    const table = { name: parts.length > 1 ? parts[parts.length - 2] : collection, key: collection, columns: [{ name, type: sqlType, notNull: false, default: null, identity: '', generated: false }], primaryKey: [], constraints: unique ? [{ name: 'u', type: 'u', definition: '', columns: [name] }] : [], indexes: [] } as unknown as CatalogTable;
    return anonymizationCandidates(table)[0]?.kind;
}

/** The dialog's rows for one collection's sampled fields */
export function fieldColumns(collection: string, fields: FieldInfo[], uniquePaths: Set<string>): PlanColumn[] {
    return fields.map(field => {
        const type = field.types[0]?.type ?? 'null';
        if (field.path === '_id') return { name: field.path, type, kinds: [], linked: [], locked: 'key' as const };
        const unique = uniquePaths.has(field.path.replace(/\[\]/g, ''));
        const kinds = fieldKinds(type, unique);
        const detected = detectFieldKind(collection, field.path, type, unique);
        return {
            name: field.path,
            type: field.types.map(t => t.type).join(' | '),
            kinds,
            detected: detected && kinds.includes(detected) ? detected : undefined,
            linked: [],
            locked: kinds.length ? undefined : 'type' as const,
        };
    });
}

export async function buildMongoMaskingPlan(databaseId: string): Promise<AnonymizePlan> {
    return withSavedMongo(databaseId, async (client, database) => {
        const { BSON } = await import('mongodb');
        const db = client.db(database);
        const listed = (await db.listCollections({ type: 'collection' }, { authorizedCollections: true }).toArray())
            .filter(c => !c.name.startsWith('system.'));
        const tables = [];
        for (const { name } of listed) {
            const collection = db.collection(name);
            const sample = await collection.aggregate([{ $sample: { size: SAMPLE_SIZE } }], { maxTimeMS: 15_000 }).toArray();
            const indexes = await collection.indexes().catch(() => []);
            const uniquePaths = new Set(indexes.filter(i => i.unique && Object.keys(i.key ?? {}).length === 1).map(i => Object.keys(i.key)[0]));
            tables.push({
                key: `${database}.${name}`,
                rows: await collection.estimatedDocumentCount({ maxTimeMS: 5_000 }).catch(() => sample.length),
                referencedBy: [],
                suggestEmpty: false,
                columns: fieldColumns(name, describeSample(BSON.EJSON.serialize(sample, { relaxed: true }) as Record<string, unknown>[]), uniquePaths),
            });
        }
        return { tables: tables.sort((a, b) => a.key.localeCompare(b.key)) };
    });
}

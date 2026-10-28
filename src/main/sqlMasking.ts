/**
 * What the "Anonymize for AI" dialog shows for a MySQL, MariaDB or SQLite database: its tables
 * and columns, read through the driver's catalog and put in the shape of PostgreSQL's catalog,
 * so the same rules apply (detection by name, keys locked, columns tied by foreign keys). The
 * choice is saved like a PostgreSQL one: table "<database>.<table>" (SQLite: "main.<table>").
 */
import { facetForDb } from './engines/registry';
import { buildAnonymizePlan, type AnonymizePlan } from './sync/anonymizedCopy';
import type { Catalog, CatalogTable } from './sync/catalog';

/** The PostgreSQL type a MySQL / SQLite type is read as (what the anonymization rules know) */
export function pgTypeOf(type: string, udt?: string): string {
    const t = String(type).toLowerCase();
    if (udt === 'bool' || /^bool/.test(t)) return 'boolean';
    if (/^(tinyint|smallint|mediumint|int|integer)\b/.test(t)) return 'integer';
    if (/^bigint\b/.test(t)) return 'bigint';
    if (/^(decimal|numeric)\b/.test(t)) return 'numeric';
    if (/^(float|double|real)\b/.test(t)) return 'double precision';
    if (/^date$/.test(t)) return 'date';
    if (/^(datetime|timestamp)/.test(t)) return 'timestamp without time zone';
    if (/^time\b/.test(t)) return 'time';
    if (/^json/.test(t)) return 'json';
    if (/(blob|binary|bit)/.test(t)) return 'bytea';
    // char, varchar, text, enum, set, SQLite's untyped columns…
    return 'text';
}

export async function buildSqlMaskingPlan(databaseId: string): Promise<AnonymizePlan> {
    const catalog = await facetForDb(databaseId, 'mask.fields', 'catalog');
    const schema = (await catalog.listNamespaces(databaseId)).schemas[0]?.name ?? 'main';
    const entities = (await catalog.listEntities(databaseId, schema)).tables;
    const tables = new Map<string, CatalogTable>();
    const counts = new Map<string, number>();
    for (const entity of entities) {
        const key = `${schema}.${entity.name}`;
        const described = await catalog.describeEntity(databaseId, { schema, table: entity.name });
        const columns = described.columns as Array<{
            column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null;
            is_identity?: string; is_generated?: string; is_primary: boolean; is_unique?: boolean;
            foreign_key: { schema: string; table: string; column: string } | null;
        }>;
        const primaryKey = columns.filter(c => c.is_primary).map(c => c.column_name);
        tables.set(key, {
            schema,
            name: entity.name,
            key,
            partitioned: false,
            partitionKey: null,
            estimate: entity.row_count ?? 0,
            columns: columns.map(c => ({
                name: c.column_name,
                type: pgTypeOf(c.data_type, c.udt_name),
                notNull: c.is_nullable === 'NO',
                default: c.column_default,
                identity: c.is_identity === 'YES' ? 'd' : '',
                generated: c.is_generated === 'ALWAYS',
            })),
            primaryKey: primaryKey.length ? primaryKey : null,
            constraints: [
                ...columns.filter(c => c.is_unique).map(c => ({ name: `${entity.name}_${c.column_name}_key`, type: 'u' as const, definition: '', columns: [c.column_name], refColumns: [] })),
                ...columns.filter(c => c.foreign_key).map(c => ({
                    name: `${entity.name}_${c.column_name}_fkey`, type: 'f' as const, definition: '',
                    references: `${c.foreign_key!.schema}.${c.foreign_key!.table}`, columns: [c.column_name], refColumns: [c.foreign_key!.column],
                })),
            ],
            indexes: [],
            triggers: [],
            comment: null,
        });
        if (entity.row_count !== null) counts.set(key, entity.row_count);
    }
    const shaped: Catalog = { serverVersion: 0, schemas: [schema], extensions: [], enums: new Map(), tables, sequences: new Set(), views: new Map(), functions: new Map() };
    return buildAnonymizePlan(shaped, counts);
}

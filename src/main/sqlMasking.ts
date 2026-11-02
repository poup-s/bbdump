/**
 * What the "Anonymize for AI" dialog shows for a MySQL, MariaDB or SQLite database: its tables
 * and columns, read through the driver's catalog and put in the shape of PostgreSQL's catalog,
 * so the same rules apply (detection by name, keys locked, columns tied by foreign keys). The
 * choice is saved like a PostgreSQL one: table "<database>.<table>" (SQLite: "main.<table>").
 */
import { facetForDb } from './engines/registry';
import type { CatalogFacet } from './engines/driver';
import { getConfig } from './ipc/configIpc';
import { engineOf } from '../shared/engines/features';
import { buildAnonymizePlan, type AnonymizePlan } from './sync/anonymizedCopy';
import type { Catalog, CatalogTable } from './sync/catalog';

/** The PostgreSQL type a MySQL / SQLite type is read as (what the anonymization rules know) */
export function pgTypeOf(type: string, udt?: string): string {
    const t = String(type).toLowerCase();
    if (udt === 'bool' || /^bool/.test(t)) return 'boolean';
    // SQL Server and DuckDB types MySQL does not have: no fake that would not fit them
    if (/\[\]$|^(struct|map|union)\b/.test(t)) return 'json';
    if (/^(uniqueidentifier|uuid)$/.test(t)) return 'uuid';
    if (/^(xml|sql_variant|hierarchyid|geography|geometry|interval)\b/.test(t)) return t.match(/^[a-z_]+/)![0];
    if (/^(utinyint|usmallint|uinteger)$/.test(t)) return 'bigint';
    if (/^(hugeint|uhugeint|ubigint|varint)$/.test(t)) return 'numeric';
    if (/^(money|smallmoney)$/.test(t)) return 'numeric';
    if (/^(datetimeoffset|smalldatetime|timestamp_(s|ms|ns)|timestamptz)/.test(t)) return 'timestamp without time zone';
    if (/^(image|varbinary|bytea)/.test(t)) return 'bytea';
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

/**
 * `feature`: what the plan is for (the AI's masking, or an anonymized copy). SQL Server and
 * DuckDB have several schemas: all are read, tables keyed "<schema>.<table>"; MySQL and SQLite
 * have one (the database, "main").
 */
export async function buildSqlMaskingPlan(databaseId: string, feature: 'mask.fields' | 'sync.anonymize' = 'mask.fields'): Promise<AnonymizePlan> {
    const { catalog, counts } = await sqlShapedCatalog(databaseId, feature);
    return buildAnonymizePlan(catalog, counts);
}

/**
 * The tables of a MySQL, MariaDB, SQLite, SQL Server or DuckDB database in PostgreSQL's catalog
 * shape (text columns with a length as character varying(n)), and their row counts
 */
export async function sqlShapedCatalog(databaseId: string, feature: 'mask.fields' | 'sync.anonymize'): Promise<{ catalog: Catalog; counts: Map<string, number> }> {
    const catalog = await facetForDb(databaseId, feature, 'catalog');
    const namespaces = (await catalog.listNamespaces(databaseId)).schemas.map(s => s.name);
    const engine = engineOf(getConfig()?.databases?.find(d => d.id === databaseId));
    const schemas = engine === 'sqlserver' || engine === 'duckdb' ? namespaces : namespaces.slice(0, 1);
    const tables = new Map<string, CatalogTable>();
    const counts = new Map<string, number>();
    for (const schema of schemas.length ? schemas : ['main']) {
        await addSchema(catalog, databaseId, schema, tables, counts);
    }
    return { catalog: { serverVersion: 0, schemas, extensions: [], enums: new Map(), tables, sequences: new Set(), views: new Map(), functions: new Map() }, counts };
}

/** A text column of at most n characters: fakes are cut to it */
const withLength = (type: string, length: number | null | undefined) => (type === 'text' && length && length > 0 ? `character varying(${length})` : type);

async function addSchema(catalog: CatalogFacet, databaseId: string, schema: string, tables: Map<string, CatalogTable>, counts: Map<string, number>): Promise<void> {
    const entities = (await catalog.listEntities(databaseId, schema)).tables;
    for (const entity of entities) {
        const key = `${schema}.${entity.name}`;
        const described = await catalog.describeEntity(databaseId, { schema, table: entity.name });
        const columns = described.columns as Array<{
            column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null;
            is_identity?: string; is_generated?: string; is_primary: boolean; is_unique?: boolean; character_maximum_length?: number | null;
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
                type: withLength(pgTypeOf(c.data_type, c.udt_name), c.character_maximum_length),
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
}

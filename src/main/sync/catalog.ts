/**
 * What a database contains, read from pg_catalog: schemas, extensions, enums, tables
 * (columns, keys, constraints, indexes), views, functions and triggers. System schemas
 * and objects that belong to extensions are left out (CREATE EXTENSION brings them).
 */
import type { PoolClient } from 'pg';

export interface CatalogColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: '' | 'a' | 'd';
  generated: boolean;
}

export interface CatalogConstraint {
  name: string;
  type: 'p' | 'u' | 'f' | 'c' | 'x';
  definition: string;
  /** FOREIGN KEY: referenced table (schema.table) */
  references?: string;
  columns: string[];
  refColumns: string[];
}

export interface CatalogTable {
  schema: string;
  name: string;
  key: string;
  partitioned: boolean;
  partitionKey: string | null;
  estimate: number;
  columns: CatalogColumn[];
  primaryKey: string[] | null;
  constraints: CatalogConstraint[];
  /** Indexes that do not back a constraint */
  indexes: Array<{ name: string; definition: string }>;
  triggers: Array<{ name: string; definition: string }>;
  comment: string | null;
}

export interface Catalog {
  serverVersion: number;
  schemas: string[];
  extensions: string[];
  enums: Map<string, string[]>;
  tables: Map<string, CatalogTable>;
  sequences: Set<string>;
  views: Map<string, { materialized: boolean; definition: string }>;
  functions: Map<string, string>;
}

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'`;
const NOT_FROM_EXTENSION = (oid: string) => `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = ${oid} AND dep.deptype = 'e')`;

export const qualified = (schema: string, name: string) => `${schema}.${name}`;

export async function readCatalog(client: PoolClient): Promise<Catalog> {
  const version = Number((await client.query(`SHOW server_version_num`)).rows[0].server_version_num);

  const schemas = (await client.query(`
    SELECT n.nspname AS name FROM pg_namespace n
    WHERE ${USER_SCHEMA} AND ${NOT_FROM_EXTENSION('n.oid')} ORDER BY 1`)).rows.map(r => r.name as string);

  const extensions = (await client.query(`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`)).rows.map(r => r.extname as string);

  const enums = new Map<string, string[]>();
  for (const r of (await client.query(`
    SELECT n.nspname AS schema, t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE ${USER_SCHEMA} AND ${NOT_FROM_EXTENSION('t.oid')}
    GROUP BY 1, 2`)).rows) {
    enums.set(qualified(r.schema, r.name), r.labels);
  }

  const tables = new Map<string, CatalogTable>();
  const tableRows = (await client.query(`
    SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind = 'p' AS partitioned,
           CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
           c.reltuples::bigint AS estimate, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${USER_SCHEMA} AND ${NOT_FROM_EXTENSION('c.oid')}`)).rows;
  const byOid = new Map<number, CatalogTable>();
  for (const r of tableRows) {
    const table: CatalogTable = {
      schema: r.schema, name: r.name, key: qualified(r.schema, r.name), partitioned: r.partitioned,
      partitionKey: r.partition_key, estimate: Math.max(0, Number(r.estimate)), columns: [], primaryKey: null,
      constraints: [], indexes: [], triggers: [], comment: r.comment,
    };
    tables.set(table.key, table);
    byOid.set(Number(r.oid), table);
  }
  const oids = [...byOid.keys()];

  for (const r of (await client.query(`
    SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated <> '' AS generated
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum`, [oids])).rows) {
    byOid.get(Number(r.oid))?.columns.push({ name: r.name, type: r.type, notNull: r.not_null, default: r.def, identity: r.identity, generated: r.generated });
  }

  for (const r of (await client.query(`
    SELECT con.conrelid AS oid, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition,
           CASE WHEN con.contype = 'f' THEN fn.nspname || '.' || fc.relname END AS references,
           ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
           ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ref_columns
    FROM pg_constraint con
    LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY con.conname`, [oids])).rows) {
    const table = byOid.get(Number(r.oid));
    if (!table) continue;
    table.constraints.push({ name: r.name, type: r.type, definition: r.definition, references: r.references ?? undefined, columns: r.columns, refColumns: r.ref_columns });
    if (r.type === 'p') table.primaryKey = r.columns;
  }

  for (const r of (await client.query(`
    SELECT ix.indrelid AS oid, i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition
    FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE ix.indrelid = ANY($1::oid[])
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid AND con.contype IN ('p', 'u', 'x'))
    ORDER BY i.relname`, [oids])).rows) {
    byOid.get(Number(r.oid))?.indexes.push({ name: r.name, definition: r.definition });
  }

  for (const r of (await client.query(`
    SELECT tgrelid AS oid, tgname AS name, pg_get_triggerdef(oid, true) AS definition
    FROM pg_trigger WHERE tgrelid = ANY($1::oid[]) AND NOT tgisinternal ORDER BY tgname`, [oids])).rows) {
    byOid.get(Number(r.oid))?.triggers.push({ name: r.name, definition: r.definition });
  }

  const sequences = new Set((await client.query(`
    SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND ${USER_SCHEMA}`)).rows.map(r => r.name as string));

  const views = new Map<string, { materialized: boolean; definition: string }>();
  for (const r of (await client.query(`
    SELECT n.nspname AS schema, c.relname AS name, c.relkind = 'm' AS materialized, pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm') AND ${USER_SCHEMA} AND ${NOT_FROM_EXTENSION('c.oid')}`)).rows) {
    views.set(qualified(r.schema, r.name), { materialized: r.materialized, definition: r.definition });
  }

  const functions = new Map<string, string>();
  for (const r of (await client.query(`
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
           pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA} AND ${NOT_FROM_EXTENSION('p.oid')}`)).rows) {
    functions.set(r.signature, r.definition);
  }

  return { serverVersion: version, schemas, extensions, enums, tables, sequences, views, functions };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withClient, executeReadOnly, resolveSchema } from '../db.js';
import { jsonResult } from '../types.js';
import { READ, databaseParam, schemaParam, tableParam } from './common.js';

/** Column names of a constraint, in order (conkey / confkey) */
const keyColumns = (keys: string, rel: string) => `ARRAY(SELECT att.attname FROM unnest(${keys}) WITH ORDINALITY k(n, i)
  JOIN pg_attribute att ON att.attrelid = ${rel} AND att.attnum = k.n ORDER BY k.i)::text[]`;

export function registerSchemaTools(server: McpServer) {
  server.registerTool(
    'list_schemas',
    {
      title: 'List schemas',
      description: 'List the schemas of the database (system schemas excluded) with their owner and number of tables.',
      inputSchema: { database: databaseParam },
      annotations: READ,
    },
    async ({ database }) => withClient(database, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS schema_owner,
               (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p') AND NOT c.relispartition) AS tables,
               obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
        ORDER BY n.nspname
      `);
      return jsonResult({ schemas: result.rows, count: result.rows.length, current_search_path: (await executeReadOnly(client, 'SHOW search_path')).rows[0].search_path });
    })
  );

  server.registerTool(
    'list_indexes',
    {
      title: 'List indexes',
      description: 'Indexes of a table with definition, size, usage (scans since the statistics reset) and validity.',
      inputSchema: { table: tableParam, database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ table, database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const result = await executeReadOnly(client, `
        SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition,
               ix.indisunique AS unique, ix.indisprimary AS primary, ix.indisvalid AS valid,
               pg_size_pretty(pg_relation_size(ix.indexrelid)) AS size, pg_relation_size(ix.indexrelid) AS size_bytes,
               COALESCE(s.idx_scan, 0) AS scans, COALESCE(s.idx_tup_read, 0) AS tuples_read, COALESCE(s.idx_tup_fetch, 0) AS tuples_fetched
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
        WHERE t.relname = $1 AND n.nspname = $2
        ORDER BY i.relname
      `, [table, nsp]);
      return jsonResult({ table: `${nsp}.${table}`, indexes: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_foreign_keys',
    {
      title: 'List foreign keys',
      description: 'Foreign keys of a table (multi-column and cross-schema), with ON DELETE / ON UPDATE rules. direction "both" also lists the keys of other tables that reference it.',
      inputSchema: {
        table: tableParam,
        database: databaseParam,
        schema: schemaParam,
        direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing').describe('outgoing: this table references others; incoming: others reference it'),
      },
      annotations: READ,
    },
    async ({ table, database, schema, direction }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const rule = (col: string) => `CASE ${col} WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' WHEN 'r' THEN 'restrict' ELSE 'no action' END`;
      const result = await executeReadOnly(client, `
        SELECT con.conname AS constraint_name,
               sn.nspname AS schema, sc.relname AS table, ${keyColumns('con.conkey', 'con.conrelid')} AS columns,
               fn.nspname AS foreign_schema, fc.relname AS foreign_table, ${keyColumns('con.confkey', 'con.confrelid')} AS foreign_columns,
               ${rule('con.confdeltype')} AS on_delete, ${rule('con.confupdtype')} AS on_update,
               CASE WHEN sc.relname = $1 AND sn.nspname = $2 THEN 'outgoing' ELSE 'incoming' END AS direction
        FROM pg_constraint con
        JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
        JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.contype = 'f'
          AND ((sc.relname = $1 AND sn.nspname = $2 AND $3::text <> 'incoming')
            OR (fc.relname = $1 AND fn.nspname = $2 AND $3::text <> 'outgoing'))
        ORDER BY direction DESC, con.conname
      `, [table, nsp, direction]);
      return jsonResult({ table: `${nsp}.${table}`, foreign_keys: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'list_enums',
    {
      title: 'List enum types',
      description: 'Custom ENUM types with their values, optionally for one schema.',
      inputSchema: { database: databaseParam, schema: z.string().optional().describe('Only this schema (default: all)') },
      annotations: READ,
    },
    async ({ database, schema }) => withClient(database, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT t.typname AS enum_name, n.nspname AS schema,
               array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE $1::text IS NULL OR n.nspname = $1::text
        GROUP BY t.typname, n.nspname
        ORDER BY n.nspname, t.typname
      `, [schema ?? null]);
      return jsonResult({ enums: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'get_database_size',
    {
      title: 'Database size',
      description: 'Total size of the database and its largest tables (table, indexes, TOAST), biggest first.',
      inputSchema: {
        database: databaseParam,
        limit: z.number().int().min(1).max(500).default(30).describe('Number of tables to list (default 30)'),
      },
      annotations: READ,
    },
    async ({ database, limit }) => withClient(database, async (client) => {
      const total = await executeReadOnly(client, `
        SELECT current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS total_size,
               pg_database_size(current_database()) AS total_bytes
      `);
      const tables = await executeReadOnly(client, `
        SELECT n.nspname AS schema, c.relname AS table,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
               pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
               pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size,
               pg_total_relation_size(c.oid) AS total_bytes,
               c.reltuples::bigint AS row_estimate
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT $1
      `, [limit]);
      return jsonResult({ ...total.rows[0], total_bytes: Number(total.rows[0].total_bytes), largest_tables: tables.rows });
    })
  );
}

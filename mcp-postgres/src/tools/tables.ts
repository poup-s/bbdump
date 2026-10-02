import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pgFormat from 'pg-format';
import { withClient, executeReadOnly, resolveSchema } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { READ, databaseParam, schemaParam, tableParam } from './common.js';

/** Exact COUNT(*) only below this size; bigger tables keep the planner's estimate */
const EXACT_COUNT_MAX_BYTES = 8 * 1024 * 1024;

const RELKIND: Record<string, string> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view', f: 'foreign table' };

export function registerTableTools(server: McpServer) {
  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List the tables of a schema with row counts (exact for small tables, planner estimate otherwise), size and comment. Views can be included.',
      inputSchema: {
        database: databaseParam,
        schema: schemaParam,
        include_views: z.boolean().default(false).describe('Also list views, materialized views and foreign tables'),
      },
      annotations: READ,
    },
    async ({ database, schema, include_views }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const kinds = include_views ? ['r', 'p', 'v', 'm', 'f'] : ['r', 'p'];
      const result = await executeReadOnly(client, `
        SELECT c.relname AS name, c.relkind AS kind,
               c.reltuples::bigint AS estimate,
               pg_total_relation_size(c.oid) AS total_bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = ANY($2) AND NOT c.relispartition
        ORDER BY c.relname
      `, [nsp, kinds]);

      const tables = [];
      for (const row of result.rows) {
        const isTable = row.kind === 'r' || row.kind === 'p';
        let rowCount: number | null = Number(row.estimate) >= 0 ? Number(row.estimate) : null;
        let exact = false;
        // Never analyzed (-1) or empty estimate: count small tables exactly
        if (isTable && (rowCount === null || rowCount === 0) && Number(row.total_bytes) <= EXACT_COUNT_MAX_BYTES) {
          try {
            const counted = await executeReadOnly(client, pgFormat('SELECT count(*)::bigint AS n FROM %I.%I', nsp, row.name), [], 10000);
            rowCount = Number(counted.rows[0].n);
            exact = true;
          } catch {
            // keep the estimate
          }
        }
        tables.push({
          name: row.name,
          type: RELKIND[row.kind] ?? row.kind,
          row_count: isTable ? rowCount : null,
          row_count_exact: exact,
          size: row.size,
          ...(row.comment ? { comment: row.comment } : {}),
        });
      }
      return jsonResult({ schema: nsp, tables, count: tables.length });
    })
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description: 'Full structure of a table or view: columns (type, nullability, default, identity/generated, comment), primary key, foreign keys (multi-column and cross-schema), unique and check constraints, indexes, and the tables that reference it.',
      inputSchema: { table: tableParam, database: databaseParam, schema: schemaParam },
      annotations: READ,
    },
    async ({ table, database, schema }) => withClient(database, async (client) => {
      const nsp = resolveSchema(schema);
      const rel = await executeReadOnly(client, `
        SELECT c.oid, c.relkind, obj_description(c.oid, 'pg_class') AS comment, c.reltuples::bigint AS estimate,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS size
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
      `, [nsp, table]);
      if (rel.rows.length === 0) {
        return errorResult(`Table "${nsp}"."${table}" not found. Use list_tables${schema ? '' : ' (or list_schemas: the table may be in another schema)'}.`);
      }
      const { oid, relkind, comment, estimate, size } = rel.rows[0];

      const columns = await executeReadOnly(client, `
        SELECT a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS type,
               NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS "default",
               CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END AS identity,
               CASE a.attgenerated WHEN 's' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated,
               col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [oid]);

      const constraints = await executeReadOnly(client, `
        SELECT con.conname AS name, con.contype AS type,
               ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.n ORDER BY k.i)::text[] AS columns,
               fn.nspname AS foreign_schema, fc.relname AS foreign_table,
               ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.n ORDER BY k.i)::text[] AS foreign_columns,
               CASE con.confdeltype WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' WHEN 'r' THEN 'restrict' ELSE 'no action' END AS on_delete,
               pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        LEFT JOIN pg_class fc ON fc.oid = con.confrelid
        LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.conrelid = $1
        ORDER BY con.contype, con.conname
      `, [oid]);

      const indexes = await executeReadOnly(client, `
        SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS definition, ix.indisunique AS unique,
               ix.indisprimary AS primary, ix.indisvalid AS valid, pg_size_pretty(pg_relation_size(ix.indexrelid)) AS size
        FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
        WHERE ix.indrelid = $1
        ORDER BY i.relname
      `, [oid]);

      const referencedBy = await executeReadOnly(client, `
        SELECT n.nspname AS schema, c.relname AS table, con.conname AS constraint,
               ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.n ORDER BY k.i)::text[] AS columns
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND con.confrelid = $1
        ORDER BY n.nspname, c.relname
      `, [oid]);

      const pk = constraints.rows.find((c: any) => c.type === 'p');
      const pick = (type: string) => constraints.rows.filter((c: any) => c.type === type);
      return jsonResult({
        table,
        schema: nsp,
        type: RELKIND[relkind] ?? relkind,
        ...(comment ? { comment } : {}),
        row_estimate: Number(estimate) >= 0 ? Number(estimate) : null,
        size,
        columns: columns.rows.map((col: any) => ({
          ...col,
          is_primary_key: !!pk?.columns.includes(col.name),
        })),
        primary_key: pk ? pk.columns : [],
        foreign_keys: pick('f').map((c: any) => ({
          name: c.name, columns: c.columns,
          references: `${c.foreign_schema}.${c.foreign_table}(${c.foreign_columns.join(', ')})`,
          on_delete: c.on_delete,
        })),
        unique_constraints: pick('u').map((c: any) => ({ name: c.name, columns: c.columns })),
        check_constraints: pick('c').map((c: any) => ({ name: c.name, definition: c.definition })),
        exclusion_constraints: pick('x').map((c: any) => ({ name: c.name, definition: c.definition })),
        indexes: indexes.rows,
        referenced_by: referencedBy.rows,
      });
    })
  );
}

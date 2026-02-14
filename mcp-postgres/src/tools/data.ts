import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, errorResult, config } from '../types.js';
import pgFormat from 'pg-format';

export function registerDataTools(server: McpServer) {
  server.tool(
    'read_rows',
    'Read rows from a table with pagination (limit/offset) and optional sorting. Maximum 5000 rows per request.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      limit: z.number().min(1).max(5000).default(100).describe('Max rows to return (default: 100, max: 5000)'),
      offset: z.number().min(0).default(0).describe('Offset for pagination'),
      sort_by: z.string().optional().describe('Column to sort by'),
      sort_order: z.enum(['asc', 'desc']).default('asc').describe('Sort order'),
      columns: z.array(z.string()).optional().describe('Columns to select (default: all)'),
    },
    async ({ table, database, schema, limit, offset, sort_by, sort_order, columns }) => {
      const client = await getClient(database);
      try {
        const effectiveLimit = Math.min(limit, config.maxRows);

        // Build SELECT clause
        const selectCols = columns?.length
          ? columns.map(c => pgFormat('%I', c)).join(', ')
          : '*';

        // Build query
        let sql = pgFormat('SELECT %s FROM %I.%I', selectCols, schema, table);

        if (sort_by) {
          sql += pgFormat(' ORDER BY %I %s', sort_by, sort_order.toUpperCase());
        }

        sql += ` LIMIT $1 OFFSET $2`;

        const result = await executeReadOnly(client, sql, [effectiveLimit, offset]);

        // Get row count estimate
        const countResult = await executeReadOnly(client, `
          SELECT COALESCE(reltuples::bigint, 0) as estimate
          FROM pg_class
          WHERE relname = $1
            AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
        `, [table, schema]);

        const totalEstimate = countResult.rows[0]?.estimate || 0;

        return jsonResult({
          rows: result.rows,
          row_count: result.rows.length,
          total_estimate: parseInt(totalEstimate, 10),
          offset,
          has_more: result.rows.length === effectiveLimit,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'search_table',
    'Full-text search (ILIKE) across all columns of a table. Casts all columns to text for comparison. Useful for finding data without knowing the exact schema.',
    {
      table: z.string().describe('Table name'),
      search: z.string().describe('Search term (case-insensitive, partial match)'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      limit: z.number().min(1).max(1000).default(50).describe('Max results (default: 50)'),
    },
    async ({ table, database, schema, search, limit }) => {
      const client = await getClient(database);
      try {
        // Get column names
        const colResult = await executeReadOnly(client, `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, table]);

        if (colResult.rows.length === 0) {
          return errorResult(`Table "${schema}"."${table}" not found or has no columns`);
        }

        // Build ILIKE conditions for each column
        const conditions = colResult.rows
          .map((r: any) => pgFormat('%I::text ILIKE $1', r.column_name))
          .join(' OR ');

        const sql = pgFormat('SELECT * FROM %I.%I WHERE ', schema, table) + conditions + ' LIMIT $2';
        const searchPattern = `%${search}%`;

        const result = await executeReadOnly(client, sql, [searchPattern, limit]);

        return jsonResult({
          rows: result.rows,
          row_count: result.rows.length,
          search_term: search,
          table: `${schema}.${table}`,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'count_rows',
    'Count rows in a table. Uses fast pg_class estimates when no filter is specified, falls back to COUNT(*) with filters.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      where: z.string().optional().describe('Optional WHERE clause (e.g., "age > 18 AND status = \'active\'")'),
    },
    async ({ table, database, schema, where }) => {
      const client = await getClient(database);
      try {
        if (!where) {
          // Fast estimate via reltuples
          const estimateResult = await executeReadOnly(client, `
            SELECT COALESCE(reltuples::bigint, 0) as estimate
            FROM pg_class
            WHERE relname = $1
              AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
          `, [table, schema]);

          const estimate = parseInt(estimateResult.rows[0]?.estimate || '0', 10);

          if (estimate > 0) {
            return jsonResult({
              table: `${schema}.${table}`,
              count: estimate,
              is_estimate: true,
            });
          }

          // Fallback to actual COUNT
          const countResult = await executeReadOnly(
            client,
            pgFormat('SELECT COUNT(*) as count FROM %I.%I', schema, table)
          );
          return jsonResult({
            table: `${schema}.${table}`,
            count: parseInt(countResult.rows[0].count, 10),
            is_estimate: false,
          });
        }

        // With WHERE filter, must use actual COUNT
        const sql = pgFormat('SELECT COUNT(*) as count FROM %I.%I WHERE ', schema, table) + where;
        const result = await executeReadOnly(client, sql);

        return jsonResult({
          table: `${schema}.${table}`,
          count: parseInt(result.rows[0].count, 10),
          is_estimate: false,
          filter: where,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

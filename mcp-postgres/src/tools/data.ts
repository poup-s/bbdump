import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, errorResult, config } from '../types.js';
import { buildWhereClause, type Filter } from '../filters.js';
import pgFormat from 'pg-format';

const filterSchema = z.object({
  column: z.string().describe('Column name'),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is_null', 'is_not_null'])
    .describe('Comparison operator'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
    .describe('Value to compare (not needed for is_null/is_not_null)'),
});

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
    'Pattern search (ILIKE) across all columns of a table. Casts all columns to text for comparison. Useful for finding data without knowing the exact schema.',
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
    'full_text_search',
    'PostgreSQL full-text search using tsvector/tsquery. Supports language-aware stemming and relevance ranking. More powerful than ILIKE search for natural language queries.',
    {
      table: z.string().describe('Table name'),
      query: z.string().describe('Search query (supports PostgreSQL tsquery syntax: & for AND, | for OR, ! for NOT)'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      language: z.string().default('english').describe('Text search language config (default: english). Use "french", "simple", etc.'),
      columns: z.array(z.string()).optional().describe('Columns to search (default: all text/varchar columns)'),
      limit: z.number().min(1).max(1000).default(50).describe('Max results (default: 50)'),
    },
    async ({ table, database, schema, query, language, columns, limit }) => {
      const client = await getClient(database);
      try {
        // Get text columns if not specified
        let searchColumns: string[];
        if (columns?.length) {
          searchColumns = columns;
        } else {
          const colResult = await executeReadOnly(client, `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
              AND data_type IN ('text', 'character varying', 'character', 'varchar', 'char')
            ORDER BY ordinal_position
          `, [schema, table]);

          if (colResult.rows.length === 0) {
            return errorResult(`No text columns found in "${schema}"."${table}"`);
          }
          searchColumns = colResult.rows.map((r: any) => r.column_name);
        }

        // Build tsvector from columns: to_tsvector(lang, coalesce(col1,'') || ' ' || coalesce(col2,'') ...)
        const tsvectorParts = searchColumns
          .map(c => pgFormat('COALESCE(%I::text, \'\')', c))
          .join(" || ' ' || ");
        const tsvector = `to_tsvector($1, ${tsvectorParts})`;
        const tsquery = `plainto_tsquery($1, $2)`;

        const sql = pgFormat('SELECT *, ts_rank(%s, %s) as search_rank FROM %I.%I', tsvector, tsquery, schema, table)
          + ` WHERE ${tsvector} @@ ${tsquery}`
          + ` ORDER BY search_rank DESC LIMIT $3`;

        const result = await executeReadOnly(client, sql, [language, query, limit]);

        return jsonResult({
          rows: result.rows,
          row_count: result.rows.length,
          query,
          language,
          searched_columns: searchColumns,
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
    'Count rows in a table. Uses fast pg_class estimates when no filter is specified, falls back to COUNT(*) with structured filters.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      filters: z.array(filterSchema).optional().describe('Optional filters (e.g., [{column: "age", operator: "gt", value: 18}])'),
    },
    async ({ table, database, schema, filters }) => {
      const client = await getClient(database);
      try {
        if (!filters || filters.length === 0) {
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

        // With filters, use parameterized COUNT
        const { clause, params } = buildWhereClause(filters as Filter[]);
        const sql = pgFormat('SELECT COUNT(*) as count FROM %I.%I ', schema, table) + clause;
        const result = await executeReadOnly(client, sql, params);

        return jsonResult({
          table: `${schema}.${table}`,
          count: parseInt(result.rows[0].count, 10),
          is_estimate: false,
          filters,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

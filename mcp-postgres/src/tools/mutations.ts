import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeWrite } from '../db.js';
import { jsonResult, errorResult } from '../types.js';
import { buildWhereClause, type Filter } from '../filters.js';
import pgFormat from 'pg-format';

const filterSchema = z.object({
  column: z.string().describe('Column name'),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is_null', 'is_not_null'])
    .describe('Comparison operator'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional()
    .describe('Value to compare (not needed for is_null/is_not_null)'),
});

export function registerMutationTools(server: McpServer) {
  server.tool(
    'insert_rows',
    'Insert one or more rows into a table. Values are parameterized to prevent SQL injection.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .min(1)
        .describe('Array of row objects to insert (e.g., [{"name": "Alice", "age": 30}])'),
    },
    async ({ table, database, schema, rows }) => {
      const client = await getClient(database);
      try {
        // Use columns from the first row — all rows must have the same keys
        const columns = Object.keys(rows[0]);
        if (columns.length === 0) {
          return errorResult('Row objects must have at least one column');
        }

        const colList = columns.map(c => pgFormat('%I', c)).join(', ');

        // Build parameterized VALUES: ($1, $2, $3), ($4, $5, $6), ...
        const valuePlaceholders: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (const row of rows) {
          const placeholders: string[] = [];
          for (const col of columns) {
            placeholders.push(`$${paramIndex}`);
            params.push(row[col] ?? null);
            paramIndex++;
          }
          valuePlaceholders.push(`(${placeholders.join(', ')})`);
        }

        const sql = pgFormat('INSERT INTO %I.%I', schema, table)
          + ` (${colList}) VALUES ${valuePlaceholders.join(', ')}`
          + ' RETURNING *';

        const result = await executeWrite(client, sql, params);

        return jsonResult({
          inserted: result.rowCount,
          rows: result.rows,
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
    'update_rows',
    'Update rows in a table using structured filters. At least one filter is required to prevent accidental full-table updates.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      set: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .describe('Columns to update (e.g., {"name": "Bob", "age": 31})'),
      filters: z.array(filterSchema).min(1)
        .describe('Filters to select rows to update (at least one required)'),
    },
    async ({ table, database, schema, set, filters }) => {
      const client = await getClient(database);
      try {
        const setCols = Object.keys(set);
        if (setCols.length === 0) {
          return errorResult('SET object must have at least one column to update');
        }

        // Build SET clause: col1 = $1, col2 = $2, ...
        const setClauseParts: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (const col of setCols) {
          setClauseParts.push(`${pgFormat('%I', col)} = $${paramIndex}`);
          params.push(set[col] ?? null);
          paramIndex++;
        }

        // Build WHERE clause starting after SET params
        const { clause, params: whereParams } = buildWhereClause(filters as Filter[], paramIndex);
        params.push(...whereParams);

        const sql = pgFormat('UPDATE %I.%I SET ', schema, table)
          + setClauseParts.join(', ')
          + ` ${clause}`
          + ' RETURNING *';

        const result = await executeWrite(client, sql, params);

        return jsonResult({
          updated: result.rowCount,
          rows: result.rows,
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
    'delete_rows',
    'Delete rows from a table using structured filters. At least one filter is required to prevent accidental full-table deletes.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
      filters: z.array(filterSchema).min(1)
        .describe('Filters to select rows to delete (at least one required)'),
    },
    async ({ table, database, schema, filters }) => {
      const client = await getClient(database);
      try {
        const { clause, params } = buildWhereClause(filters as Filter[]);

        const sql = pgFormat('DELETE FROM %I.%I ', schema, table) + clause + ' RETURNING *';

        const result = await executeWrite(client, sql, params);

        return jsonResult({
          deleted: result.rowCount,
          rows: result.rows,
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
    'execute_write_query',
    'Execute a write SQL query (INSERT, UPDATE, DELETE, CREATE, ALTER, etc.). Use this for complex mutations that cannot be expressed with the structured tools. Runs with a statement timeout.',
    {
      sql: z.string().describe('SQL query to execute'),
      database: z.string().optional().describe('Database name'),
      timeout_ms: z.number().default(60000).describe('Timeout in milliseconds (default: 60000)'),
    },
    async ({ sql, database, timeout_ms }) => {
      const client = await getClient(database);
      try {
        const startTime = Date.now();
        const result = await executeWrite(client, sql, undefined, timeout_ms);
        const duration = Date.now() - startTime;

        return jsonResult({
          rows: result.rows || [],
          fields: result.fields?.map(f => f.name) || [],
          row_count: result.rows?.length || 0,
          affected_rows: result.rowCount,
          duration_ms: duration,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

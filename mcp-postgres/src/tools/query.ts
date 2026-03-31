import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly, getActiveConnectionInfo } from '../db.js';
import { jsonResult, errorResult, config } from '../types.js';
import { recordQuery } from '../history.js';

// Defense-in-depth: early rejection of write operations with a clear error message.
// The real protection is the BEGIN READ ONLY transaction in executeReadOnly().
// This regex can be bypassed (comments, CTEs, etc.) but that's fine — PostgreSQL
// will reject the write attempt anyway. This just provides a better UX.
const WRITE_PATTERN = /\b(DROP|DELETE|UPDATE|INSERT\s+INTO|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b/i;

export function registerQueryTools(server: McpServer) {
  server.tool(
    'execute_query',
    'Execute a read-only SQL query. Runs inside a READ ONLY transaction with a statement timeout. Only SELECT queries are allowed — write operations (INSERT, UPDATE, DELETE, DROP, etc.) are rejected.',
    {
      sql: z.string().describe('SQL query to execute (SELECT only)'),
      database: z.string().optional().describe('Database name'),
      timeout_ms: z.number().default(60000).describe('Timeout in milliseconds (default: 60000)'),
      max_rows: z.number().min(1).max(5000).default(1000).describe('Max rows returned (default: 1000)'),
    },
    async ({ sql, database, timeout_ms, max_rows }) => {
      // Pre-execution validation: reject write operations
      if (WRITE_PATTERN.test(sql)) {
        return errorResult(
          'Write operations are not allowed. Only SELECT queries can be executed. ' +
          'Detected forbidden keyword in query.'
        );
      }

      const client = await getClient(database);
      try {
        const effectiveMaxRows = Math.min(max_rows, config.maxRows);
        const startTime = Date.now();

        const result = await executeReadOnly(client, sql, undefined, timeout_ms);
        const duration = Date.now() - startTime;

        const dbName = database || getActiveConnectionInfo().database;
        recordQuery({ tool: 'execute_query', database: dbName, sql, duration_ms: duration });

        const truncated = result.rows.length > effectiveMaxRows;
        const rows = truncated ? result.rows.slice(0, effectiveMaxRows) : result.rows;
        const fields = result.fields?.map(f => f.name) || [];

        return jsonResult({
          rows,
          fields,
          row_count: rows.length,
          total_row_count: result.rowCount,
          truncated,
          duration_ms: duration,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'explain_query',
    'Show the execution plan of a SQL query using EXPLAIN ANALYZE. Useful for performance analysis. Runs inside a READ ONLY transaction.',
    {
      sql: z.string().describe('SQL query to analyze'),
      database: z.string().optional().describe('Database name'),
      analyze: z.boolean().default(true).describe('Use ANALYZE (actually executes the query, default: true)'),
      format: z.enum(['text', 'json']).default('text').describe('Output format (default: text)'),
    },
    async ({ sql, database, analyze, format }) => {
      // Pre-execution validation
      if (WRITE_PATTERN.test(sql)) {
        return errorResult(
          'Write operations are not allowed. Only SELECT queries can be analyzed.'
        );
      }

      const client = await getClient(database);
      try {
        const analyzeFlag = analyze ? 'ANALYZE true,' : '';
        const explainSql = `EXPLAIN (${analyzeFlag} FORMAT ${format}) ${sql}`;

        const startTime = Date.now();
        const result = await executeReadOnly(client, explainSql);
        const dbName = database || getActiveConnectionInfo().database;
        recordQuery({ tool: 'explain_query', database: dbName, sql: explainSql, duration_ms: Date.now() - startTime });

        if (format === 'json') {
          return jsonResult(result.rows[0]['QUERY PLAN']);
        }

        const plan = result.rows.map((r: any) => r['QUERY PLAN']).join('\n');
        return { content: [{ type: 'text' as const, text: plan }] };
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

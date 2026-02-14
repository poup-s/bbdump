import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, errorResult } from '../types.js';

export function registerExtraTools(server: McpServer) {
  server.tool(
    'list_extensions',
    'List PostgreSQL extensions (both installed and available)',
    {
      database: z.string().optional().describe('Database name'),
    },
    async ({ database }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            name,
            default_version,
            installed_version,
            comment,
            (installed_version IS NOT NULL) as is_installed
          FROM pg_available_extensions
          ORDER BY name
        `);
        return jsonResult({
          extensions: result.rows,
          installed_count: result.rows.filter((r: any) => r.is_installed).length,
          total_count: result.rows.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'get_table_stats',
    'Get detailed table statistics: live/dead tuples, last vacuum, last analyze, vacuum count, etc.',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    async ({ table, database, schema }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            relname as table_name,
            n_live_tup as live_tuples,
            n_dead_tup as dead_tuples,
            CASE WHEN n_live_tup > 0
              THEN round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)
              ELSE 0
            END as dead_tuple_percent,
            last_vacuum,
            last_autovacuum,
            last_analyze,
            last_autoanalyze,
            vacuum_count,
            autovacuum_count,
            analyze_count,
            autoanalyze_count,
            n_tup_ins as inserts_since_vacuum,
            n_tup_upd as updates_since_vacuum,
            n_tup_del as deletes_since_vacuum
          FROM pg_stat_user_tables
          WHERE relname = $1 AND schemaname = $2
        `, [table, schema]);

        if (result.rows.length === 0) {
          return errorResult(`Table "${schema}"."${table}" not found in statistics`);
        }

        return jsonResult(result.rows[0]);
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'find_column',
    'Search for a column name across all tables in the database. Useful for schema discovery and finding where a specific field is used.',
    {
      column_pattern: z.string().describe('Search pattern (ILIKE, e.g., "%user%", "%email%")'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    async ({ column_pattern, database, schema }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            table_name, column_name, data_type,
            is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND column_name ILIKE $2
          ORDER BY table_name, ordinal_position
        `, [schema, column_pattern]);
        return jsonResult({
          pattern: column_pattern,
          matches: result.rows,
          count: result.rows.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'list_views',
    'List all views in the database with their SQL definitions',
    {
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    async ({ database, schema }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            table_name as view_name,
            view_definition
          FROM information_schema.views
          WHERE table_schema = $1
          ORDER BY table_name
        `, [schema]);
        return jsonResult({ views: result.rows, count: result.rows.length });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'list_functions',
    'List stored functions and procedures in the database',
    {
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    async ({ database, schema }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            p.proname as name,
            pg_get_function_arguments(p.oid) as arguments,
            pg_get_function_result(p.oid) as return_type,
            CASE p.prokind
              WHEN 'f' THEN 'function'
              WHEN 'p' THEN 'procedure'
              WHEN 'a' THEN 'aggregate'
              WHEN 'w' THEN 'window'
            END as kind,
            d.description as comment
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          LEFT JOIN pg_description d ON p.oid = d.objoid
          WHERE n.nspname = $1
          ORDER BY p.proname
        `, [schema]);
        return jsonResult({ functions: result.rows, count: result.rows.length });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'list_active_connections',
    'List active connections to the PostgreSQL server. Optionally filter by database name.',
    {
      database: z.string().optional().describe('Filter by database name (optional)'),
    },
    async ({ database }) => {
      const client = await getClient();
      try {
        let sql = `
          SELECT
            pid,
            datname as database,
            usename as username,
            client_addr,
            state,
            query,
            query_start,
            state_change,
            backend_start
          FROM pg_stat_activity
          WHERE pid != pg_backend_pid()
        `;
        const params: any[] = [];

        if (database) {
          sql += ' AND datname = $1';
          params.push(database);
        }

        sql += ' ORDER BY backend_start DESC';

        const result = await executeReadOnly(client, sql, params);
        return jsonResult({
          connections: result.rows,
          count: result.rows.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

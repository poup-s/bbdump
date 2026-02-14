import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, errorResult } from '../types.js';

export function registerSchemaTools(server: McpServer) {
  server.tool(
    'list_schemas',
    'List all schemas in the database (excluding system schemas pg_catalog, information_schema, pg_toast)',
    {
      database: z.string().optional().describe('Database name'),
    },
    async ({ database }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT schema_name, schema_owner
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND schema_name NOT LIKE 'pg_temp_%'
            AND schema_name NOT LIKE 'pg_toast_temp_%'
          ORDER BY schema_name
        `);
        return jsonResult({ schemas: result.rows, count: result.rows.length });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'list_indexes',
    'List indexes on a table with their definition, size, and usage statistics',
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
            i.indexname as name,
            i.indexdef as definition,
            pg_size_pretty(pg_relation_size(quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))) as size,
            pg_relation_size(quote_ident(i.schemaname) || '.' || quote_ident(i.indexname)) as size_bytes,
            COALESCE(s.idx_scan, 0) as scans,
            COALESCE(s.idx_tup_read, 0) as tuples_read,
            COALESCE(s.idx_tup_fetch, 0) as tuples_fetched
          FROM pg_indexes i
          LEFT JOIN pg_stat_user_indexes s
            ON s.indexrelname = i.indexname AND s.schemaname = i.schemaname
          WHERE i.tablename = $1 AND i.schemaname = $2
          ORDER BY i.indexname
        `, [table, schema]);
        return jsonResult({
          table: `${schema}.${table}`,
          indexes: result.rows,
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
    'list_foreign_keys',
    'List all foreign key relationships for a table, showing referenced tables and columns',
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
            tc.constraint_name,
            kcu.column_name,
            ccu.table_schema AS foreign_schema,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
          ORDER BY tc.constraint_name
        `, [schema, table]);
        return jsonResult({
          table: `${schema}.${table}`,
          foreign_keys: result.rows,
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
    'list_enums',
    'List all custom ENUM types in the database with their possible values',
    {
      database: z.string().optional().describe('Database name'),
    },
    async ({ database }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            t.typname as enum_name,
            n.nspname as schema,
            array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_namespace n ON t.typnamespace = n.oid
          GROUP BY t.typname, n.nspname
          ORDER BY t.typname
        `);
        return jsonResult({ enums: result.rows, count: result.rows.length });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'get_database_size',
    'Show detailed database size breakdown: total size, per-table size, and per-index size',
    {
      database: z.string().optional().describe('Database name'),
    },
    async ({ database }) => {
      const client = await getClient(database);
      try {
        // Total database size
        const totalResult = await executeReadOnly(client, `
          SELECT
            pg_size_pretty(pg_database_size(current_database())) as total_size,
            pg_database_size(current_database()) as total_bytes
        `);

        // Per-table sizes
        const tablesResult = await executeReadOnly(client, `
          SELECT
            schemaname as schema,
            tablename as table,
            pg_size_pretty(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) as total_size,
            pg_size_pretty(pg_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) as table_size,
            pg_size_pretty(pg_indexes_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) as indexes_size,
            pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) as total_bytes
          FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) DESC
        `);

        return jsonResult({
          database: database || 'current',
          total_size: totalResult.rows[0].total_size,
          total_bytes: parseInt(totalResult.rows[0].total_bytes, 10),
          tables: tablesResult.rows,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

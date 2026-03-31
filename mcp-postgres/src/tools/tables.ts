import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, errorResult } from '../types.js';

export function registerTableTools(server: McpServer) {
  server.tool(
    'list_tables',
    'List all tables in a database with fast row count estimates. Uses pg_class.reltuples for speed, with COUNT(*) fallback for empty estimates.',
    {
      database: z.string().optional().describe('Database name (default: configured database)'),
      schema: z.string().default('public').describe('Schema to inspect (default: public)'),
    },
    async ({ database, schema }) => {
      const client = await getClient(database);
      try {
        const result = await executeReadOnly(client, `
          SELECT
            t.table_name as name,
            COALESCE(pc.reltuples::bigint, 0) as row_count_estimate
          FROM information_schema.tables t
          LEFT JOIN pg_class pc ON pc.relname = t.table_name
            AND pc.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
          WHERE t.table_schema = $1
            AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name
        `, [schema]);

        // Fallback COUNT(*) for tables where reltuples is 0 or negative
        const tables = [];
        for (const row of result.rows) {
          if (row.row_count_estimate <= 0) {
            try {
              const countResult = await executeReadOnly(
                client,
                `SELECT COUNT(*) as count FROM "${schema}"."${row.name}"`
              );
              tables.push({ name: row.name, row_count: parseInt(countResult.rows[0].count, 10) });
            } catch {
              tables.push({ name: row.name, row_count: 0 });
            }
          } else {
            tables.push({ name: row.name, row_count: parseInt(row.row_count_estimate, 10) });
          }
        }

        return jsonResult({
          schema,
          tables,
          count: tables.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );

  server.tool(
    'describe_table',
    'Describe the complete structure of a table: columns, data types, nullability, defaults, primary keys, and foreign keys',
    {
      table: z.string().describe('Table name'),
      database: z.string().optional().describe('Database name'),
      schema: z.string().default('public').describe('Schema (default: public)'),
    },
    async ({ table, database, schema }) => {
      const client = await getClient(database);
      try {
        // Get columns
        const columnsResult = await executeReadOnly(client, `
          SELECT
            column_name, data_type, udt_name,
            is_nullable, column_default,
            character_maximum_length,
            numeric_precision, numeric_scale,
            ordinal_position
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, table]);

        // Get primary keys
        const pkResult = await executeReadOnly(client, `
          SELECT a.attname as column_name
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          JOIN pg_class c ON c.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE i.indisprimary
            AND c.relname = $1
            AND n.nspname = $2
        `, [table, schema]);
        const pkColumns = new Set(pkResult.rows.map((r: any) => r.column_name));

        // Get foreign keys
        const fkResult = await executeReadOnly(client, `
          SELECT
            kcu.column_name,
            ccu.table_schema AS foreign_schema,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column,
            tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        `, [schema, table]);

        const fkMap = new Map<string, any>();
        for (const fk of fkResult.rows) {
          fkMap.set(fk.column_name, {
            foreign_schema: fk.foreign_schema,
            foreign_table: fk.foreign_table,
            foreign_column: fk.foreign_column,
            constraint_name: fk.constraint_name,
          });
        }

        const columns = columnsResult.rows.map((col: any) => ({
          column_name: col.column_name,
          data_type: col.data_type,
          udt_name: col.udt_name,
          is_nullable: col.is_nullable === 'YES',
          column_default: col.column_default,
          max_length: col.character_maximum_length,
          numeric_precision: col.numeric_precision,
          numeric_scale: col.numeric_scale,
          is_primary_key: pkColumns.has(col.column_name),
          foreign_key: fkMap.get(col.column_name) || null,
        }));

        return jsonResult({
          table,
          schema,
          columns,
          column_count: columns.length,
          primary_keys: Array.from(pkColumns),
          foreign_keys: fkResult.rows.length,
        });
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

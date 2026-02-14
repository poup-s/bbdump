import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, executeReadOnly } from '../db.js';
import { jsonResult, textResult, errorResult } from '../types.js';
import pgFormat from 'pg-format';

export function registerDatabaseTools(server: McpServer) {
  server.tool(
    'list_databases',
    'List all PostgreSQL databases with size, owner, encoding, and active connections count',
    {},
    async () => {
      const client = await getClient();
      try {
        const result = await executeReadOnly(client, `
          SELECT
            d.datname as name,
            pg_catalog.pg_get_userbyid(d.datdba) as owner,
            pg_catalog.pg_encoding_to_char(d.encoding) as encoding,
            d.datcollate as collate,
            d.datctype as ctype,
            pg_size_pretty(pg_database_size(d.datname)) as size,
            pg_database_size(d.datname) as size_bytes,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = d.datname)::int as connections
          FROM pg_catalog.pg_database d
          WHERE d.datistemplate = false
          ORDER BY d.datname
        `);
        return jsonResult({
          databases: result.rows,
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
    'create_database',
    'Create a new PostgreSQL database. This is the ONLY write operation available. Database name must contain only letters, numbers, and underscores.',
    {
      name: z.string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Name must contain only letters, numbers, and underscores, starting with a letter or underscore')
        .max(63, 'PostgreSQL database names are limited to 63 characters')
        .describe('Database name (letters, numbers, underscores only)'),
      owner: z.string().optional().describe('Database owner (default: current user)'),
      encoding: z.string().default('UTF8').describe('Encoding (default: UTF8)'),
    },
    async ({ name, owner, encoding }) => {
      const client = await getClient();
      try {
        // Check if database already exists
        const existing = await client.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [name]
        );
        if (existing.rows.length > 0) {
          return errorResult(`Database "${name}" already exists`);
        }

        // Build CREATE DATABASE statement with pg-format for safe identifier escaping
        let sql = pgFormat('CREATE DATABASE %I', name);
        if (owner) {
          sql += pgFormat(' OWNER %I', owner);
        }
        sql += pgFormat(' ENCODING %L', encoding);
        sql += ' TEMPLATE template0';

        await client.query(sql);

        return textResult(`Database "${name}" created successfully`);
      } catch (err: any) {
        return errorResult(err.message);
      } finally {
        client.release();
      }
    }
  );
}

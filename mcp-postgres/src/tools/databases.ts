import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pgFormat from 'pg-format';
import { withClient, executeReadOnly, getActiveConnectionInfo } from '../db.js';
import { jsonResult, textResult, errorResult } from '../types.js';
import { requestConfirmation, refusalMessage } from '../confirm.js';
import { recordQuery } from '../history.js';
import { READ, WRITE } from './common.js';

export function registerDatabaseTools(server: McpServer) {
  server.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'List the databases of the active server with size, owner, encoding and open connections.',
      inputSchema: {},
      annotations: READ,
    },
    async () => withClient(undefined, async (client) => {
      const result = await executeReadOnly(client, `
        SELECT
          d.datname AS name,
          pg_catalog.pg_get_userbyid(d.datdba) AS owner,
          pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
          d.datcollate AS collate,
          CASE WHEN has_database_privilege(d.datname, 'CONNECT')
            THEN pg_size_pretty(pg_database_size(d.datname)) END AS size,
          CASE WHEN has_database_privilege(d.datname, 'CONNECT')
            THEN pg_database_size(d.datname) END AS size_bytes,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = d.datname)::int AS connections,
          d.datname = current_database() AS is_current
        FROM pg_catalog.pg_database d
        WHERE d.datistemplate = false
        ORDER BY d.datname
      `);
      return jsonResult({ databases: result.rows, count: result.rows.length });
    })
  );

  server.registerTool(
    'create_database',
    {
      title: 'Create a database',
      description: 'Create a database on the active server. Confirmed by the user in the bbdump app before it runs.',
      inputSchema: {
        name: z.string()
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Name must contain only letters, numbers, and underscores, starting with a letter or underscore')
          .max(63, 'PostgreSQL database names are limited to 63 characters')
          .describe('Database name (letters, numbers, underscores only)'),
        owner: z.string().optional().describe('Database owner (default: current user)'),
        encoding: z.string().default('UTF8').describe('Encoding (default: UTF8)'),
      },
      annotations: WRITE,
    },
    async ({ name, owner, encoding }) => withClient(undefined, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (existing.rows.length > 0) return errorResult(`Database "${name}" already exists`);

      let sql = pgFormat('CREATE DATABASE %I', name);
      if (owner) sql += pgFormat(' OWNER %I', owner);
      sql += pgFormat(' ENCODING %L TEMPLATE template0', encoding);

      const dbName = getActiveConnectionInfo().database;
      const outcome = await requestConfirmation({ tool: 'create_database', database: dbName, sql, description: `CREATE DATABASE "${name}"` });
      if (!outcome.approved) return errorResult(refusalMessage(outcome));

      const startTime = Date.now();
      await client.query(sql);
      recordQuery({ tool: 'create_database', database: dbName, sql, duration_ms: Date.now() - startTime });
      return textResult(`Database "${name}" created. Its tables are reached with the database parameter of each tool.`);
    })
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pg from 'pg';
import { setActiveConnection, getActiveConnectionInfo } from '../db.js';
import {
  isBbdumpConfigured,
  listConnections,
  getConnectionParams,
} from '../connections.js';
import { jsonResult, textResult, errorResult } from '../types.js';

export function registerConnectionTools(server: McpServer) {
  server.tool(
    'list_connections',
    'List all database connections configured in bbdump. Shows name, display name, host, port, user, and SSL status. Passwords are never exposed. Use use_connection to switch to a specific connection.',
    {},
    async () => {
      if (!isBbdumpConfigured()) {
        return errorResult(
          'bbdump config integration is not available. ' +
          'The MCP server is using direct environment variable credentials (PGHOST, PGPORT, PGUSER, PGPASSWORD). ' +
          'To enable multi-connection support, reinstall the MCP server from bbdump Settings.'
        );
      }

      try {
        const connections = listConnections();
        if (!connections) {
          return errorResult('Failed to read bbdump configuration file.');
        }

        const current = getActiveConnectionInfo();

        return jsonResult({
          connections,
          count: connections.length,
          active_connection: `${current.user}@${current.host}:${current.port}`,
        });
      } catch (err: any) {
        return errorResult(err.message);
      }
    }
  );

  server.tool(
    'use_connection',
    'Switch the active database connection to one configured in bbdump. All subsequent tool calls will use this connection. The password is decrypted from bbdump config automatically.',
    {
      name: z.string().describe('The connection name, displayName, or id as shown in list_connections. Use id to disambiguate when multiple databases share the same name.'),
    },
    async ({ name }) => {
      if (!isBbdumpConfigured()) {
        return errorResult(
          'bbdump config integration is not available. Cannot switch connections.'
        );
      }

      try {
        const params = getConnectionParams(name);
        if (!params) {
          return errorResult(
            `Connection "${name}" not found in bbdump configuration. Use list_connections to see available connections.`
          );
        }

        setActiveConnection(params);

        return textResult(
          `Switched to connection "${name}" — database "${params.database}" on ${params.user}@${params.host}:${params.port}. ` +
          `All subsequent database operations will use this connection.`
        );
      } catch (err: any) {
        return errorResult(`Failed to switch connection: ${err.message}`);
      }
    }
  );

  server.tool(
    'test_connection',
    'Test connectivity to a database connection configured in bbdump without switching the active connection. Returns reachability, latency, and server version.',
    {
      name: z.string().describe('The connection name, displayName, or id as shown in list_connections.'),
    },
    async ({ name }) => {
      if (!isBbdumpConfigured()) {
        return errorResult('bbdump config integration is not available. Cannot test connections.');
      }

      let pool: pg.Pool | null = null;
      try {
        const params = getConnectionParams(name);
        if (!params) {
          return errorResult(
            `Connection "${name}" not found in bbdump configuration. Use list_connections to see available connections.`
          );
        }

        const sslConfig = params.ssl ? { rejectUnauthorized: params.sslRejectUnauthorized ?? false } : undefined;

        pool = new pg.Pool({
          host: params.host,
          port: params.port,
          user: params.user,
          password: params.password || undefined,
          database: params.database,
          max: 1,
          connectionTimeoutMillis: 5000,
          ssl: sslConfig,
        });

        const startTime = Date.now();
        const client = await pool.connect();
        try {
          const result = await client.query('SELECT version()');
          const latency = Date.now() - startTime;
          return jsonResult({
            reachable: true,
            latency_ms: latency,
            version: result.rows[0]?.version,
            connection: `${params.user}@${params.host}:${params.port}/${params.database}`,
          });
        } finally {
          client.release();
        }
      } catch (err: any) {
        return jsonResult({
          reachable: false,
          error: err.message,
          connection: name,
        });
      } finally {
        if (pool) {
          await pool.end().catch(() => {});
        }
      }
    }
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
}

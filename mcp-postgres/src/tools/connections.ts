import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import pg from 'pg';
import { setActiveConnection, getActiveConnectionInfo, buildSslConfig, explainError } from '../db.js';
import { isBbdumpConfigured, listConnections, getConnectionParams, type ConnectionParams } from '../connections.js';
import { reachThroughApp } from '../tunnel.js';
import { jsonResult, errorResult } from '../types.js';
import { READ, LOCAL } from './common.js';

const NOT_CONFIGURED = 'bbdump config integration is not available: this MCP server uses the PG* environment variables only. '
  + 'Reinstall it from bbdump Settings → MCP to reach the databases saved in bbdump.';

/** Connects once with the connection's own SSL settings: version, latency, size */
async function probe(params: ConnectionParams) {
  const pool = new pg.Pool({
    host: params.host,
    port: params.port,
    user: params.user,
    password: params.password || undefined,
    database: params.database,
    max: 1,
    connectionTimeoutMillis: 8000,
    ssl: buildSslConfig(params),
    application_name: 'bbdump-mcp',
  });
  const started = Date.now();
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT current_setting('server_version') AS version, current_user AS user,
                pg_size_pretty(pg_database_size(current_database())) AS size,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS tables`
      );
      return { reachable: true as const, latency_ms: Date.now() - started, ...result.rows[0] };
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    'list_connections',
    {
      title: 'List bbdump connections',
      description: 'List the databases saved in bbdump (id, name, project, host, user, SSL, default schema, last backup) and the active connection. Passwords are never shown. Start here, then call use_connection.',
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      if (!isBbdumpConfigured()) return errorResult(NOT_CONFIGURED);
      const connections = listConnections();
      if (!connections) return errorResult('Failed to read the bbdump configuration file.');
      const active = getActiveConnectionInfo();
      return jsonResult({
        connections,
        count: connections.length,
        active_connection: {
          name: active.label ?? null,
          target: `${active.user}@${active.host}:${active.port}/${active.database}`,
          default_schema: active.default_schema,
        },
      });
    }
  );

  server.registerTool(
    'use_connection',
    {
      title: 'Switch connection',
      description: 'Make a database saved in bbdump the active connection for every following call. Its password is decrypted from the bbdump configuration. The connection is checked first: on failure, the active one is kept.',
      inputSchema: {
        name: z.string().describe('Connection id, name or display name, as shown by list_connections (the id disambiguates duplicates)'),
      },
      annotations: LOCAL,
    },
    async ({ name }) => {
      if (!isBbdumpConfigured()) return errorResult(NOT_CONFIGURED);
      let params: ConnectionParams | null;
      try {
        params = getConnectionParams(name);
      } catch (err: any) {
        return errorResult(`Cannot read the connection "${name}": ${err.message}`);
      }
      if (!params) return errorResult(`Connection "${name}" not found in bbdump. Use list_connections to see the saved databases.`);

      try {
        params = await reachThroughApp(params);
        const info = await probe(params);
        setActiveConnection(params, name);
        return jsonResult({
          switched_to: name,
          target: `${params.user}@${params.host}:${params.port}/${params.database}`,
          default_schema: params.defaultSchema || 'public',
          server_version: info.version,
          size: info.size,
          tables: info.tables,
          next: 'get_schema_overview gives every table with its columns and relations in one call.',
        });
      } catch (err) {
        return errorResult(`"${name}" is not reachable, the active connection is unchanged: ${explainError(err)}`);
      }
    }
  );

  server.registerTool(
    'test_connection',
    {
      title: 'Test a connection',
      description: 'Check that a database saved in bbdump is reachable (with its SSL settings) without switching to it: latency, server version, size, table count.',
      inputSchema: {
        name: z.string().describe('Connection id, name or display name, as shown by list_connections'),
      },
      annotations: READ,
    },
    async ({ name }) => {
      if (!isBbdumpConfigured()) return errorResult(NOT_CONFIGURED);
      try {
        const saved = getConnectionParams(name);
        if (!saved) return errorResult(`Connection "${name}" not found in bbdump. Use list_connections to see the saved databases.`);
        const params = await reachThroughApp(saved);
        const info = await probe(params);
        return jsonResult({ ...info, connection: `${params.user}@${params.host}:${params.port}/${params.database}` });
      } catch (err: any) {
        return jsonResult({ reachable: false, error: err.message, connection: name });
      }
    }
  );
}

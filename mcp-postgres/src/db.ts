import pg from 'pg';
import * as fs from 'fs';
import type * as tls from 'tls';
import { checkServerIdentity as tlsCheckServerIdentity } from 'tls';
import { config, errorResult, MAX_TIMEOUT_MS, type ToolResult } from './types.js';
import type { ConnectionParams } from './connections.js';
import { reachThroughApp } from './tunnel.js';

const { Pool } = pg;
type PoolClient = pg.PoolClient;

const pools = new Map<string, pg.Pool>();

interface ActiveConnection extends ConnectionParams {
  /** bbdump connection name, when chosen with use_connection */
  label?: string;
}

// Active connection — mutable, switchable at runtime.
// Safe for MCP stdio transport which processes requests sequentially (single JSON-RPC stream).
let activeConnection: ActiveConnection = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
};

/**
 * node-postgres ssl options. prefer/require: encrypted, certificate not checked (unless
 * sslRejectUnauthorized). verify-ca/verify-full: chain checked against sslRootCert (e.g.
 * AWS RDS global-bundle.pem) or the system store; verify-ca skips the host name check.
 */
export function buildSslConfig(conn: ConnectionParams): tls.ConnectionOptions | undefined {
  const mode = conn.sslMode || (conn.ssl ? 'require' : undefined);
  if (!mode || mode === 'disable') return undefined;
  const effectiveMode = mode === 'require' && conn.sslRootCert ? 'verify-ca' : mode;
  if (effectiveMode === 'prefer' || effectiveMode === 'require') {
    return { rejectUnauthorized: conn.sslRejectUnauthorized ?? false };
  }
  const options: tls.ConnectionOptions = { rejectUnauthorized: true };
  if (conn.sslRootCert) options.ca = fs.readFileSync(conn.sslRootCert, 'utf8');
  // verify-ca: chain only. verify-full: also check the real host (node-postgres sends
  // no servername for IP hosts, so Node would otherwise check "localhost")
  options.checkServerIdentity = effectiveMode === 'verify-ca'
    ? () => undefined
    : (_hostname, cert) => tlsCheckServerIdentity(conn.host, cert);
  return options;
}

export function setActiveConnection(params: ConnectionParams, label?: string): void {
  activeConnection = { ...params, label };
}

export function getActiveConnectionInfo(): { host: string; port: number; user: string; database: string; label?: string; default_schema: string } {
  return {
    host: activeConnection.host,
    port: activeConnection.port,
    user: activeConnection.user,
    database: activeConnection.database,
    label: activeConnection.label,
    default_schema: activeConnection.defaultSchema || 'public',
  };
}

/** The schema a tool works on: the one asked, else the connection's (Prisma ?schema=), else public */
export function resolveSchema(schema?: string): string {
  return schema || activeConnection.defaultSchema || 'public';
}

function poolKey(database: string): string {
  // SSL settings are part of the key: switching CA/mode must not reuse a pool
  const ssl = `${activeConnection.sslMode || (activeConnection.ssl ? 'require' : 'none')}:${activeConnection.sslRootCert || ''}`;
  return `${activeConnection.user}@${activeConnection.host}:${activeConnection.port}/${database}#${ssl}`;
}

function newPool(database: string, ssl: tls.ConnectionOptions | undefined, key: string): pg.Pool {
  const pool = new Pool({
    host: activeConnection.host,
    port: activeConnection.port,
    user: activeConnection.user,
    password: activeConnection.password || undefined,
    database,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl,
    application_name: 'bbdump-mcp',
  });
  pool.on('error', (err) => {
    console.error(`Pool error [${key}]:`, err.message);
  });
  return pool;
}

export function getPool(database?: string): pg.Pool {
  const db = database || activeConnection.database;
  const key = poolKey(db);
  let pool = pools.get(key);
  if (!pool) {
    pool = newPool(db, buildSslConfig(activeConnection), key);
    pools.set(key, pool);
  }
  return pool;
}

export async function getClient(database?: string): Promise<PoolClient> {
  // Behind SSH: make sure the app's tunnel is open (it closes when unused, and reopens
  // on the same port when possible; a new port gives new pools)
  if (activeConnection.sshDatabaseId) {
    const reached = await reachThroughApp(activeConnection);
    activeConnection = { ...activeConnection, host: reached.host, port: reached.port };
  }
  const pool = getPool(database);
  try {
    return await pool.connect();
  } catch (err: any) {
    // SSL auto-retry: only when no SSL was configured (never downgrade an explicit
    // verify-ca/verify-full to an unchecked connection)
    const sslConfigured = !!buildSslConfig(activeConnection);
    if (!sslConfigured && (err.message?.includes('no encryption') || err.message?.includes('SSL'))) {
      const db = database || activeConnection.database;
      const key = poolKey(db);
      const oldPool = pools.get(key);
      if (oldPool) {
        await oldPool.end().catch((e) => console.error('Failed to close old pool:', e.message));
        pools.delete(key);
      }
      const sslPool = newPool(db, { rejectUnauthorized: false }, key);
      pools.set(key, sslPool);
      return await sslPool.connect();
    }
    throw err;
  }
}

/** A tip for errors a model can fix by itself (wrong connection, missing table…) */
export function explainError(err: any): string {
  const message: string = err?.message || String(err);
  const code: string | undefined = err?.code;
  if (/role ".*" does not exist|password authentication failed|no pg_hba.conf entry/.test(message)) {
    return `${message}. The active connection is ${activeConnection.user}@${activeConnection.host}:${activeConnection.port}/${activeConnection.database}: use list_connections then use_connection to pick a database saved in bbdump.`;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|ENOTFOUND|timeout expired/.test(message)) {
    return `${message}. The server ${activeConnection.host}:${activeConnection.port} is not reachable: check it is running, or use_connection to another database.`;
  }
  if (/cannot insert multiple commands into a prepared statement/.test(message)) {
    return 'Only one SQL statement per call here: split it, or use execute_write_query (several statements, confirmed in bbdump) for changes.';
  }
  if (code === '42P01') return `${message}. Use list_tables (or get_schema_overview) to see the tables, and check the schema name.`;
  if (code === '42703') return `${message}. Use describe_table to see the column names.`;
  if (code === '3D000') return `${message}. Use list_databases to see the databases of this server.`;
  if (code === '25006') return `${message}. This tool is read-only: use execute_write_query (confirmed in bbdump) to change data.`;
  if (code === '57014') return `${message}. The statement hit its timeout: narrow the query or raise timeout_ms.`;
  return message;
}

/** Runs `fn` with a pooled client, always released; errors become tool errors with a tip */
export async function withClient(
  database: string | undefined,
  fn: (client: PoolClient) => Promise<ToolResult>,
): Promise<ToolResult> {
  let client: PoolClient | null = null;
  try {
    client = await getClient(database);
    return await fn(client);
  } catch (err) {
    return errorResult(explainError(err));
  } finally {
    client?.release();
  }
}

export const clampTimeout = (timeoutMs?: number) => Math.min(Math.max(1000, timeoutMs || config.statementTimeout), MAX_TIMEOUT_MS);

export async function executeReadOnly(
  client: PoolClient,
  sql: string,
  params?: any[],
  timeoutMs?: number
): Promise<pg.QueryResult> {
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${clampTimeout(timeoutMs)}`);
    // Force the extended protocol: it accepts a single statement only, so a
    // "SELECT 1; COMMIT; ..." payload cannot end the READ ONLY transaction.
    const result = await client.query({ text: sql, values: params ?? [], queryMode: 'extended' } as pg.QueryConfig);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => console.error('ROLLBACK failed:', (e as Error).message));
    throw err;
  }
}

/** Several statements (simple protocol) give an array of results: keep the last one */
function lastResult(result: pg.QueryResult | pg.QueryResult[]): pg.QueryResult & { statements?: number } {
  if (Array.isArray(result)) {
    const last = result[result.length - 1];
    return Object.assign(last ?? ({ rows: [], fields: [], rowCount: 0 } as unknown as pg.QueryResult), { statements: result.length });
  }
  return result;
}

export async function executeWrite(
  client: PoolClient,
  sql: string,
  params?: any[],
  timeoutMs?: number
): Promise<pg.QueryResult & { statements?: number }> {
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${clampTimeout(timeoutMs)}`);
    const result = lastResult(await client.query(sql, params) as pg.QueryResult | pg.QueryResult[]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => console.error('ROLLBACK failed:', (e as Error).message));
    throw err;
  }
}

/**
 * Runs ONE statement and rolls it back. The extended protocol refuses several statements,
 * so a "...; COMMIT; ..." payload cannot make a dry run permanent.
 */
export async function executeDryRun(
  client: PoolClient,
  sql: string,
  params?: any[],
  timeoutMs?: number
): Promise<pg.QueryResult> {
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${clampTimeout(timeoutMs)}`);
    const result = await client.query({ text: sql, values: params ?? [], queryMode: 'extended' } as pg.QueryConfig);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => console.error('ROLLBACK failed:', (e as Error).message));
    throw err;
  }
}

export async function closeAll(): Promise<void> {
  for (const [key, pool] of Array.from(pools.entries())) {
    console.error(`Closing pool: ${key}`);
    await pool.end().catch((e) => console.error(`Failed to close pool ${key}:`, (e as Error).message));
    pools.delete(key);
  }
}

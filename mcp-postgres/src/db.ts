import pg from 'pg';
import { config } from './types.js';

const { Pool } = pg;
type PoolClient = pg.PoolClient;

const pools = new Map<string, pg.Pool>();

// Active connection — mutable, switchable at runtime
interface ActiveConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

let activeConnection: ActiveConnection = {
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
};

export function setActiveConnection(params: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}): void {
  activeConnection = { ...params };
}

export function getActiveConnectionInfo(): { host: string; port: number; user: string; database: string } {
  return {
    host: activeConnection.host,
    port: activeConnection.port,
    user: activeConnection.user,
    database: activeConnection.database,
  };
}

function poolKey(database: string): string {
  return `${activeConnection.user}@${activeConnection.host}:${activeConnection.port}/${database}`;
}

export function getPool(database?: string): pg.Pool {
  const db = database || activeConnection.database;
  const key = poolKey(db);

  let pool = pools.get(key);
  if (pool) return pool;

  const sslConfig = activeConnection.ssl ? { rejectUnauthorized: false } : undefined;

  pool = new Pool({
    host: activeConnection.host,
    port: activeConnection.port,
    user: activeConnection.user,
    password: activeConnection.password || undefined,
    database: db,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: sslConfig,
  });

  pool.on('error', (err) => {
    console.error(`Pool error [${key}]:`, err.message);
  });

  pools.set(key, pool);
  return pool;
}

export async function getClient(database?: string): Promise<PoolClient> {
  const pool = getPool(database);
  try {
    return await pool.connect();
  } catch (err: any) {
    // SSL auto-retry: if connection fails without SSL, retry with SSL
    if (err.message?.includes('no encryption') || err.message?.includes('SSL')) {
      const db = database || activeConnection.database;
      const key = poolKey(db);

      // Remove old pool
      const oldPool = pools.get(key);
      if (oldPool) {
        await oldPool.end().catch(() => {});
        pools.delete(key);
      }

      // Create new pool with SSL
      const sslPool = new Pool({
        host: activeConnection.host,
        port: activeConnection.port,
        user: activeConnection.user,
        password: activeConnection.password || undefined,
        database: db,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: false },
      });

      sslPool.on('error', (sslErr) => {
        console.error(`Pool error (SSL) [${key}]:`, sslErr.message);
      });

      pools.set(key, sslPool);
      return await sslPool.connect();
    }
    throw err;
  }
}

export async function executeReadOnly(
  client: PoolClient,
  sql: string,
  params?: any[],
  timeoutMs?: number
): Promise<pg.QueryResult> {
  const timeout = timeoutMs || config.statementTimeout;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function closeAll(): Promise<void> {
  const entries = Array.from(pools.entries());
  for (const [key, pool] of entries) {
    console.error(`Closing pool: ${key}`);
    await pool.end().catch(() => {});
    pools.delete(key);
  }
}

import { Client } from 'pg';
import * as os from 'os';
import { logger } from './logger';
import { getErrorMessage } from './utils';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalHost(host?: string): boolean {
  return !!host && LOCAL_HOSTS.has(host);
}

async function tryConnect(
  user: string,
  port: number,
  password?: string,
  onConnected?: (client: Client) => Promise<void>,
): Promise<'ok' | 'no-role' | 'other'> {
  const useSocket = process.platform === 'linux' && !password;
  const client = new Client({
    host: useSocket ? '/var/run/postgresql' : 'localhost',
    port,
    user,
    password: password || undefined,
    database: 'postgres',
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    if (onConnected) await onConnected(client);
    return 'ok';
  } catch (error) {
    const message = getErrorMessage(error);
    return /role ".*" does not exist/.test(message) ? 'no-role' : 'other';
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * For a database on the local server, returns a PostgreSQL role that actually exists
 * when the configured one does not (Homebrew creates a superuser named after the OS
 * user, not "postgres"). Returns null when no change is needed or none can be found.
 */
export async function resolveLocalUser(db: {
  host?: string;
  port?: number;
  user?: string;
  connectionString?: string;
  /** Behind SSH: host/port are the server's, never this computer's PostgreSQL */
  ssh?: unknown;
}, password?: string): Promise<string | null> {
  if (db.ssh || db.connectionString || !isLocalHost(db.host)) return null;

  const port = db.port || 5432;
  const configured = db.user || 'postgres';
  if ((await tryConnect(configured, port, password)) !== 'no-role') return null;

  const candidates = [os.userInfo().username, 'postgres'].filter(u => u && u !== configured);
  for (const candidate of candidates) {
    if ((await tryConnect(candidate, port, password)) === 'ok') {
      logger.info(`Local role "${configured}" does not exist, using "${candidate}" instead`);
      return candidate;
    }
  }
  return null;
}

/**
 * Finds the role bbdump can use on the local server without a password: the OS user
 * first (Homebrew, or a role created by the Linux setup), then "postgres" (peer auth on
 * Linux when running as that user). Also returns the server version. Never throws.
 */
export async function findLocalRole(port = 5432): Promise<{ role: string; serverVersion?: string } | null> {
  let osUser = '';
  try {
    osUser = os.userInfo().username;
  } catch {
    // No passwd entry: only "postgres" can be tried
  }
  const candidates = [...new Set([osUser, 'postgres'].filter(Boolean))];
  for (const role of candidates) {
    let serverVersion: string | undefined;
    try {
      const result = await tryConnect(role, port, undefined, async (client) => {
        const { rows } = await client.query<{ server_version: string }>('SHOW server_version');
        serverVersion = rows[0]?.server_version?.split(' ')[0];
      });
      if (result === 'ok') return { role, serverVersion };
    } catch {
      // Try the next candidate
    }
  }
  return null;
}

export async function safeResolveLocalUser(...args: Parameters<typeof resolveLocalUser>): Promise<string | null> {
  try {
    return await resolveLocalUser(...args);
  } catch (error) {
    logger.warn(`Local role detection failed: ${getErrorMessage(error)}`);
    return null;
  }
}

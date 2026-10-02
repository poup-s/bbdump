/**
 * Saved databases behind SSH (a VPS whose PostgreSQL is not exposed) are reached through
 * a tunnel the bbdump app opens and shares: the MCP server asks the app where it is.
 */
import { appApi } from './confirm.js';
import type { ConnectionParams } from './connections.js';

export async function reachThroughApp<T extends ConnectionParams>(params: T): Promise<T> {
  if (!params.sshDatabaseId) return params;
  const result = await appApi<{ success: boolean; host?: string; port?: number; error?: string }>(
    'POST', '/tunnel', { database: params.sshDatabaseId }, 45000,
  );
  if (!result.success || !result.host || !result.port) {
    throw new Error(`SSH tunnel to this database failed: ${result.error ?? 'unknown error'}`);
  }
  return { ...params, host: result.host, port: result.port };
}

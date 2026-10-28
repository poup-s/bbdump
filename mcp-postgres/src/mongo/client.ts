/**
 * The active MongoDB database, chosen with use_connection. While it is active the PostgreSQL
 * tools refuse to run (they would reach the previous PostgreSQL connection without saying so).
 * The driver is loaded on first use only.
 */
import type { MongoClient, Db } from 'mongodb';
import { authSourceHint, mongoConnection, parseMongoUri, type MongoTarget } from '../shared/mongoUri.js';
import { mongoToolsEnabled, type MongoFeature } from './features.js';
import { appApi } from '../confirm.js';

export const QUERY_TIMEOUT_MS = 30_000;
export const COUNT_TIMEOUT_MS = 10_000;

interface ActiveMongo {
  id: string;
  label: string;
  database: string;
  hosts: string;
  /** For the journal of changes */
  user: string;
  port: number;
  client: MongoClient;
  /** Behind SSH: the saved target, the database id the app opens the tunnel for, and its local port */
  ssh?: { target: MongoTarget; databaseId: string; port: number };
}

let active: ActiveMongo | null = null;

export function activeMongo(): { id: string; label: string; database: string; hosts: string; user: string; port: number } | null {
  return active && { id: active.id, label: active.label, database: active.database, hosts: active.hosts, user: active.user, port: active.port };
}

/** First line of a driver error, with a hint for the usual authSource mistake when it may be one */
export function mongoError(err: unknown, target?: MongoTarget): string {
  const message = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
  const hint = target && /authentication failed/i.test(message) ? authSourceHint(target) : undefined;
  return hint ? `${message.replace(/\.+$/, '')}. ${hint}` : message;
}

/**
 * A saved database behind SSH, through the tunnel the bbdump app opens and shares (as for
 * PostgreSQL): its local end, one server reached directly, the host name not checkable.
 */
async function reach(target: MongoTarget, sshDatabaseId: string | undefined): Promise<MongoTarget> {
  if (!sshDatabaseId) return target;
  const result = await appApi<{ success: boolean; host?: string; port?: number; error?: string }>('POST', '/tunnel', { database: sshDatabaseId }, 45000);
  if (!result.success || !result.host || !result.port) throw new Error(`SSH tunnel to this database failed: ${result.error ?? 'unknown error'}`);
  return {
    ...target,
    host: result.host,
    port: result.port,
    connectionString: undefined,
    viaTunnel: true,
    sslMode: target.sslMode === 'verify-full' ? 'verify-ca' : target.sslMode,
  };
}

async function connect(target: MongoTarget): Promise<{ client: MongoClient; database: string; hosts: string; user: string; port: number }> {
  const { MongoClient } = await import('mongodb');
  const { uri, database, hosts } = mongoConnection(target);
  const parsed = parseMongoUri(uri);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'bbdump-mcp' });
  try {
    await client.connect();
    return { client, database, hosts, user: parsed?.username ?? '', port: parsed?.hosts[0]?.port ?? 27017 };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

/** Version, collections and size of a database: the check before switching, and test_connection */
async function describeServer(client: MongoClient, database: string) {
  const db = client.db(database);
  const started = Date.now();
  await db.command({ ping: 1 });
  const latency = Date.now() - started;
  const info = await db.admin().command({ buildInfo: 1 }).catch(() => ({ version: undefined }));
  const collections = await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
  const stats = await db.command({ dbStats: 1, scale: 1 }).catch(() => null);
  return {
    latency_ms: latency,
    version: info.version ? String(info.version) : null,
    collections: collections.filter((c) => !c.name.startsWith('system.')).length,
    size_bytes: typeof stats?.storageSize === 'number' ? stats.storageSize : null,
  };
}

/** Connects to a saved MongoDB database and makes it the active one; the previous one is closed */
export async function useMongo(id: string, label: string, target: MongoTarget, sshDatabaseId?: string) {
  const reached = await reach(target, sshDatabaseId);
  const { client, database, hosts, user, port } = await connect(reached);
  try {
    const info = await describeServer(client, database);
    await clearMongo();
    active = { id, label, database, hosts, user, port, client, ...(sshDatabaseId ? { ssh: { target, databaseId: sshDatabaseId, port: reached.port } } : {}) };
    return { database, hosts, ...info };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

/** Checks a saved MongoDB database without switching to it */
export async function testMongo(target: MongoTarget, sshDatabaseId?: string) {
  const { client, database, hosts } = await connect(await reach(target, sshDatabaseId));
  try {
    return { database, hosts, ...(await describeServer(client, database)) };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Before each mongo_* call: the app closes a tunnel left unused, and reopens it on the same
 * port when it can; on another port, the client connects again.
 */
export async function keepReachable(): Promise<void> {
  const current = active;
  if (!current?.ssh) return;
  const reached = await reach(current.ssh.target, current.ssh.databaseId);
  if (reached.port !== current.ssh.port) await useMongo(current.id, current.label, current.ssh.target, current.ssh.databaseId);
}

/** Back to PostgreSQL (use_connection on a PostgreSQL database), or shutting down */
export async function clearMongo(): Promise<void> {
  const previous = active;
  active = null;
  await previous?.client.close().catch(() => {});
}

/** The active MongoDB database for a mongo_* tool, or why it cannot be read (or changed) */
export function mongoDb(feature: MongoFeature = 'mcp.read'): Db {
  if (!mongoToolsEnabled(feature)) {
    throw new Error(feature === 'mcp.write' && mongoToolsEnabled()
      ? 'Changing MongoDB databases is turned off in bbdump.'
      : 'Reading MongoDB databases is turned off in bbdump.');
  }
  if (!active) throw new Error('No MongoDB database is active: call list_connections, then use_connection on a MongoDB database.');
  return active.client.db(active.database);
}

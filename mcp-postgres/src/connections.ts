import * as crypto from 'crypto';
import { databaseAllowed } from './chatScope.js';
import * as fs from 'fs';
import { mongoToolsEnabled } from './mongo/features.js';
import { MONGO_DEFAULT_PORT, isMongoUri, mongoOption, parseMongoUri, type MongoTarget } from './shared/mongoUri.js';

const ALGORITHM = 'aes-256-gcm';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

interface BbdumpDatabaseConfig {
  id: string;
  name: string;
  displayName?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  encrypted?: boolean;
  ssl?: boolean;
  sslMode?: SslMode;
  sslRootCert?: string;
  connectionString?: string;
  enabled?: boolean;
  isLocalBbdump?: boolean;
  lastBackup?: string;
  /** Reached through an SSH tunnel the bbdump app opens */
  ssh?: { host?: string };
  /** Absent means PostgreSQL; MongoDB databases are offered when MongoDB is on in bbdump */
  engine?: string;
  /** MongoDB, entered field by field */
  mongo?: { authSource?: string };
}

interface BbdumpConfig {
  databases: BbdumpDatabaseConfig[];
  projects?: Array<{ id: string; name: string; databaseIds?: string[] }>;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  displayName?: string;
  project?: string;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl: boolean;
  local: boolean;
  /** SSH host the database is reached through */
  via_ssh?: string;
  default_schema?: string;
  last_backup?: string;
  /** Only for databases other than PostgreSQL */
  engine?: string;
}

export interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  sslMode?: SslMode;
  sslRootCert?: string;
  sslRejectUnauthorized?: boolean;
  /** Saved database behind SSH: host/port come from the app's tunnel (see tunnel.ts) */
  sshDatabaseId?: string;
  /** Schema used when a tool call does not name one (Prisma ?schema=, search_path) */
  defaultSchema?: string;
}

interface ParsedUrl {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  sslMode?: SslMode;
  sslRootCert?: string;
  schema?: string;
}

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * postgres:// URL parts. Not `new URL()`: passwords often hold unencoded "@", ":", "/" or
 * "%" (the last "@" ends the credentials), and IPv6 hosts may come without brackets.
 */
export function parseConnectionString(connectionString: string): ParsedUrl {
  const match = /^postgres(?:ql)?:\/\/(.*)$/i.exec(connectionString.trim());
  if (!match) return {};
  let rest = match[1];

  let query = '';
  const queryStart = rest.indexOf('?');
  if (queryStart !== -1) {
    query = rest.slice(queryStart + 1);
    rest = rest.slice(0, queryStart);
  }

  let credentials = '';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    credentials = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }

  const slash = rest.indexOf('/');
  const hostPort = slash === -1 ? rest : rest.slice(0, slash);
  const database = slash === -1 ? '' : rest.slice(slash + 1);

  let host = hostPort;
  let port: number | undefined;
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(hostPort);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] ? Number(bracketed[2]) : undefined;
  } else if ((hostPort.match(/:/g) || []).length === 1) {
    const [h, p] = hostPort.split(':');
    host = h;
    port = /^\d+$/.test(p) ? Number(p) : undefined;
  }

  const result: ParsedUrl = {
    host: host ? safeDecode(host) : undefined,
    port,
    database: database ? safeDecode(database) : undefined,
  };
  if (credentials) {
    const colon = credentials.indexOf(':');
    result.user = safeDecode(colon === -1 ? credentials : credentials.slice(0, colon)) || undefined;
    if (colon !== -1) result.password = safeDecode(credentials.slice(colon + 1)) || undefined;
  }

  const params = new URLSearchParams(query);
  const sslmode = params.get('sslmode');
  if (sslmode && (SSL_MODES as string[]).includes(sslmode)) result.sslMode = sslmode as SslMode;
  result.sslRootCert = params.get('sslrootcert') || undefined;
  // Prisma's ?schema=, or libpq options=-c search_path=x
  const searchPath = /search_path=([^\s,]+)/.exec(params.get('options') || '')?.[1];
  result.schema = params.get('schema') || params.get('currentSchema') || searchPath || undefined;
  return result;
}

export function decryptPassword(encryptedText: string, key: Buffer): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted password format: expected iv:authTag:ciphertext');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function loadEncryptionKey(): Buffer | null {
  const keyPath = process.env.BBDUMP_KEY_PATH;
  if (!keyPath) return null;
  try {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  } catch (err: any) {
    console.error(`Failed to read encryption key: ${err.message}`);
    return null;
  }
}

/** Every saved database this server may reach: PostgreSQL ones, and MongoDB ones when it is on */
function loadAllDatabases(): BbdumpConfig | null {
  const configPath = process.env.BBDUMP_CONFIG_PATH;
  if (!configPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as BbdumpConfig;
    const mongo = mongoToolsEnabled();
    // A chat on one database sees that database only
    const databases = Array.isArray(parsed.databases)
      ? parsed.databases.filter((d) => databaseAllowed(d.id) && (isPostgres(d) || (mongo && d.engine === 'mongodb')))
      : [];
    return { ...parsed, databases };
  } catch (err: any) {
    console.error(`Failed to read bbdump config: ${err.message}`);
    return null;
  }
}

const isPostgres = (db: BbdumpDatabaseConfig) => !db.engine || db.engine === 'postgresql';

/** The PostgreSQL databases only: what every tool but the mongo_* ones works on */
function loadBbdumpConfig(): BbdumpConfig | null {
  const config = loadAllDatabases();
  return config && { ...config, databases: config.databases.filter(isPostgres) };
}

/** The saved database for an id, name or display name (id wins), whatever its engine */
function findSaved(databases: BbdumpDatabaseConfig[], identifier: string): BbdumpDatabaseConfig | undefined {
  return databases.find((d) => d.id === identifier)
    || databases.find((d) => d.name === identifier || d.displayName === identifier);
}

/** Engine of a saved database: 'postgresql', 'mongodb', or null when unknown here */
export function savedEngine(identifier: string): string | null {
  const db = findSaved(loadAllDatabases()?.databases ?? [], identifier);
  return db ? db.engine || 'postgresql' : null;
}

/** A saved MongoDB database: what mongoConnection() needs, password decrypted (memory only) */
export function getMongoTarget(identifier: string): { id: string; label: string; target: MongoTarget; sshDatabaseId?: string } | null {
  const db = findSaved(loadAllDatabases()?.databases ?? [], identifier);
  if (!db || db.engine !== 'mongodb') return null;
  let password = db.password;
  if (db.encrypted !== false && password) {
    const key = loadEncryptionKey();
    if (!key) throw new Error('Encryption key not available; cannot decrypt password');
    password = decryptPassword(password, key);
  }
  return {
    id: db.id,
    label: db.displayName || db.name,
    sshDatabaseId: db.ssh ? db.id : undefined,
    target: {
      connectionString: db.connectionString,
      host: db.host,
      port: db.port,
      user: db.user,
      password: password || undefined,
      database: db.name,
      sslMode: db.sslMode || (db.ssl ? 'require' : undefined),
      sslRootCert: db.sslRootCert,
      mongo: db.mongo,
    },
  };
}

export function isBbdumpConfigured(): boolean {
  return !!(process.env.BBDUMP_CONFIG_PATH && process.env.BBDUMP_KEY_PATH);
}

export function listConnections(): ConnectionInfo[] | null {
  const bbdumpConfig = loadAllDatabases();
  if (!bbdumpConfig) return null;

  const projectOf = new Map<string, string>();
  for (const project of bbdumpConfig.projects || []) {
    for (const id of project.databaseIds || []) projectOf.set(id, project.name);
  }

  return bbdumpConfig.databases.map((db) => {
    if (db.engine === 'mongodb') return mongoConnectionInfo(db, projectOf.get(db.id));
    const uri = db.connectionString ? parseConnectionString(db.connectionString) : {};
    const sslMode = db.sslMode || uri.sslMode || (db.ssl ? 'require' : undefined);
    return {
      id: db.id,
      name: db.name,
      displayName: db.displayName,
      project: projectOf.get(db.id),
      host: uri.host || db.host,
      port: uri.port || db.port,
      user: uri.user || db.user,
      database: uri.database || db.name,
      ssl: !!sslMode && sslMode !== 'disable',
      local: !!db.isLocalBbdump,
      ...(db.ssh ? { via_ssh: db.ssh.host } : {}),
      default_schema: uri.schema,
      last_backup: db.lastBackup,
    };
  });
}

/** A MongoDB database in list_connections: hosts and database, never the password */
function mongoConnectionInfo(db: BbdumpDatabaseConfig, project: string | undefined): ConnectionInfo {
  const parsed = db.connectionString && isMongoUri(db.connectionString) ? parseMongoUri(db.connectionString) : null;
  const first = parsed?.hosts[0];
  return {
    id: db.id,
    name: db.name,
    displayName: db.displayName,
    project,
    engine: 'mongodb',
    host: parsed ? parsed.hosts.map((h) => (h.port ? `${h.host}:${h.port}` : h.host)).join(',') : db.host,
    port: first?.port || db.port || MONGO_DEFAULT_PORT,
    user: parsed?.username || db.user,
    database: db.name,
    ssl: parsed ? mongoOption(parsed, 'tls') === 'true' || mongoOption(parsed, 'ssl') === 'true' || parsed.srv : !!db.sslMode && db.sslMode !== 'disable' && db.sslMode !== 'prefer',
    local: false,
    ...(db.ssh ? { via_ssh: db.ssh.host } : {}),
    last_backup: db.lastBackup,
  };
}

/** Ids of the saved databases with this database name (any server) */
export function savedDatabaseIdsNamed(name: string): string[] {
  return (loadBbdumpConfig()?.databases ?? []).filter((d) => d.name === name).map((d) => d.id);
}

/** The saved database for an id, name or display name (id wins) */
export function findDatabase(identifier: string): { id: string; name: string; displayName?: string } | null {
  const bbdumpConfig = loadBbdumpConfig();
  if (!bbdumpConfig) return null;
  const db = bbdumpConfig.databases.find((d) => d.id === identifier)
    || bbdumpConfig.databases.find((d) => d.name === identifier || d.displayName === identifier);
  return db ? { id: db.id, name: db.name, displayName: db.displayName } : null;
}

export function getConnectionParams(identifier: string): ConnectionParams | null {
  const bbdumpConfig = loadBbdumpConfig();
  if (!bbdumpConfig) return null;

  const db = bbdumpConfig.databases.find((d) => d.id === identifier)
    || bbdumpConfig.databases.find((d) => d.name === identifier || d.displayName === identifier);
  if (!db) return null;

  let password = db.password;
  if (db.encrypted !== false && password) {
    const key = loadEncryptionKey();
    if (!key) throw new Error('Encryption key not available; cannot decrypt password');
    password = decryptPassword(password, key);
  }

  // Databases saved with a connection string may have empty/default host fields
  const uri = db.connectionString ? parseConnectionString(db.connectionString) : {};
  return {
    host: uri.host || db.host,
    port: uri.port || db.port,
    user: uri.user || db.user,
    password: uri.password || password,
    database: uri.database || db.name,
    ssl: db.ssl,
    // Through a tunnel the server name is 127.0.0.1: the chain is still checked, not the name
    sslMode: db.ssh && db.sslMode === 'verify-full' ? 'verify-ca' : db.sslMode || uri.sslMode || (db.ssl ? 'require' : undefined),
    sslRootCert: db.sslRootCert || uri.sslRootCert,
    defaultSchema: uri.schema,
    sshDatabaseId: db.ssh ? db.id : undefined,
  };
}

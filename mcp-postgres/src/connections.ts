import * as crypto from 'crypto';
import * as fs from 'fs';

const ALGORITHM = 'aes-256-gcm';

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
  enabled?: boolean;
}

interface BbdumpConfig {
  databases: BbdumpDatabaseConfig[];
}

export interface ConnectionInfo {
  id: string;
  name: string;
  displayName?: string;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl?: boolean;
}

export interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

function decryptPassword(encryptedText: string, key: Buffer): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted password format: expected iv:authTag:ciphertext');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function loadEncryptionKey(): Buffer | null {
  const keyPath = process.env.BBDUMP_KEY_PATH;
  if (!keyPath) return null;

  try {
    const keyData = fs.readFileSync(keyPath, 'utf8').trim();
    return Buffer.from(keyData, 'hex');
  } catch (err: any) {
    console.error(`Failed to read encryption key: ${err.message}`);
    return null;
  }
}

function loadBbdumpConfig(): BbdumpConfig | null {
  const configPath = process.env.BBDUMP_CONFIG_PATH;
  if (!configPath) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as BbdumpConfig;
  } catch (err: any) {
    console.error(`Failed to read bbdump config: ${err.message}`);
    return null;
  }
}

export function isBbdumpConfigured(): boolean {
  return !!(process.env.BBDUMP_CONFIG_PATH && process.env.BBDUMP_KEY_PATH);
}

export function listConnections(): ConnectionInfo[] | null {
  const bbdumpConfig = loadBbdumpConfig();
  if (!bbdumpConfig) return null;

  return bbdumpConfig.databases.map((db) => ({
    id: db.id,
    name: db.name,
    displayName: db.displayName,
    host: db.host,
    port: db.port,
    user: db.user,
    database: db.name,
    ssl: db.ssl,
  }));
}

export function getConnectionParams(identifier: string): ConnectionParams | null {
  const bbdumpConfig = loadBbdumpConfig();
  if (!bbdumpConfig) return null;

  // Try matching by id first, then by name or displayName
  const db = bbdumpConfig.databases.find((d) => d.id === identifier)
          || bbdumpConfig.databases.find((d) => d.name === identifier || d.displayName === identifier);
  if (!db) return null;

  let password = db.password;
  if (db.encrypted !== false && password) {
    const key = loadEncryptionKey();
    if (!key) {
      throw new Error('Encryption key not available; cannot decrypt password');
    }
    password = decryptPassword(password, key);
  }

  return {
    host: db.host,
    port: db.port,
    user: db.user,
    password,
    database: db.name,
    ssl: db.ssl,
  };
}

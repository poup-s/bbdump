import { AppConfig, DatabaseConfig } from '../types/config';
import { encryptionManager } from './encryption';
import { logger } from './logger';

/**
 * Connection strings are stored WITHOUT their password: the password lives in the
 * (encrypted) `password` field and is put back into the URI in memory only, when a
 * connection is made. v1.0.2 stored full URIs, password included, in plain text.
 */

const KEYWORD_PASSWORD = /(^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/i;

function isUri(cs: string): boolean {
  return /^postgres(ql)?:\/\//i.test(cs.trim());
}

/** Splits a connection string into the same string without password, and that password. */
export function splitUriPassword(connectionString: string): { connectionString: string; password?: string } {
  if (isUri(connectionString)) {
    try {
      const url = new URL(connectionString);
      if (!url.password) return { connectionString };
      const password = decodeURIComponent(url.password);
      url.password = '';
      return { connectionString: url.toString(), password };
    } catch {
      return { connectionString };
    }
  }
  // keyword/value form: host=... password=... dbname=...
  const m = connectionString.match(KEYWORD_PASSWORD);
  if (!m) return { connectionString };
  let password = m[2];
  if (password.startsWith("'")) password = password.slice(1, -1).replace(/\\(.)/g, '$1');
  const stripped = connectionString.replace(KEYWORD_PASSWORD, '$1').replace(/\s{2,}/g, ' ').trim();
  return { connectionString: stripped, password };
}

/** Puts the password back into a connection string that has none (memory only). */
export function injectUriPassword(connectionString: string | undefined, password: string | undefined): string | undefined {
  if (!connectionString || !password) return connectionString;
  if (splitUriPassword(connectionString).password !== undefined) return connectionString;
  if (isUri(connectionString)) {
    try {
      const url = new URL(connectionString);
      if (!url.username) return connectionString; // libpq cannot take a password without a user in the URI
      url.password = encodeURIComponent(password);
      return url.toString();
    } catch {
      return connectionString;
    }
  }
  const escaped = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `${connectionString} password='${escaped}'`;
}

/**
 * Credentials for a connection test from a dialog. Nothing typed (no password, none in the
 * URL) while editing a saved database means "unchanged": its saved password is used.
 */
export function credentialsForConnectionTest(
  input: { password?: string; connectionString?: string },
  /** Read only when needed (decrypting can fail) */
  savedPassword?: (() => string | undefined) | null,
): { password: string; connectionString?: string } {
  let password = input.password || '';
  let connectionString = input.connectionString || undefined;
  const typedInUri = connectionString ? splitUriPassword(connectionString).password : undefined;
  if (savedPassword && !password && typedInUri === undefined) {
    password = savedPassword() || '';
    connectionString = injectUriPassword(connectionString, password);
  }
  return { password, connectionString };
}

/**
 * The database as used at runtime: decrypted password, and connection string with
 * that password injected. Throws if the stored password cannot be decrypted.
 */
export function toRuntimeDatabase<T extends DatabaseConfig>(db: T): T {
  const password = db.encrypted && db.password ? encryptionManager.decrypt(db.password) : (db.password || '');
  return {
    ...db,
    password,
    connectionString: injectUriPassword(db.connectionString, password),
  };
}

/**
 * Migration: moves passwords embedded in stored connection strings into the
 * password field (encrypted unless the database is explicitly unencrypted).
 * Returns the number of databases changed.
 */
export function moveUriPasswordsOutOfConfig(config: AppConfig): number {
  let changed = 0;
  for (const db of config.databases || []) {
    if (!db.connectionString) continue;
    const { connectionString, password } = splitUriPassword(db.connectionString);
    if (password === undefined) continue;
    const encrypt = db.encrypted !== false;
    db.connectionString = connectionString;
    db.password = encrypt ? encryptionManager.encrypt(password) : password;
    db.encrypted = encrypt;
    changed++;
    logger.info(`Moved the password out of the stored connection string of ${db.name}`);
  }
  return changed;
}

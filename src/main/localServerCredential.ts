/**
 * Windows: the local PostgreSQL server (EDB installer) has no passwordless access like
 * Homebrew or Linux peer auth. bbdump keeps the password of its "postgres" superuser,
 * generated when bbdump installed the server or typed once by the user, encrypted in
 * <userData>/local-server.json (0600), apart from config.json so that file's format does
 * not change. Elsewhere nothing is stored and local connections keep working without one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from './paths';
import { encryptionManager } from './encryption';
import { logger } from './logger';

export interface LocalServerCredential {
  user: string;
  password: string;
}

const credentialPath = () => path.join(pathManager.appDataPath, 'local-server.json');

/** The saved credential, or null (none, or encrypted with a key that was replaced since) */
export function getLocalServerCredential(): LocalServerCredential | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialPath(), 'utf8')) as { user?: unknown; password?: unknown };
    if (typeof raw?.user !== 'string' || typeof raw.password !== 'string' || !raw.user) return null;
    return { user: raw.user, password: encryptionManager.decrypt(raw.password) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.warn('Saved local server password cannot be read: ignored');
    }
    return null;
  }
}

export function saveLocalServerCredential(credential: LocalServerCredential): void {
  const file = credentialPath();
  const tmp = `${file}.tmp`;
  const data = { user: credential.user, password: encryptionManager.encrypt(credential.password), savedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Windows: the saved password when `user` is the saved one (or not given). Else '' */
export function localServerPassword(user?: string): string {
  if (process.platform !== 'win32') return '';
  const credential = getLocalServerCredential();
  return credential && (!user || credential.user === user) ? credential.password : '';
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * A database on this computer's server with no password of its own gets the saved one, so
 * backups, the explorer and the AI assistants reach it. Anything else is returned as is.
 */
export function withLocalServerPassword<T extends { host?: string; user?: string; password?: string; connectionString?: string; ssh?: unknown; viaTunnel?: boolean }>(db: T): T {
  if (process.platform !== 'win32') return db;
  if (db.password || db.connectionString || db.ssh || db.viaTunnel || !LOCAL_HOSTS.includes(db.host || '')) return db;
  const password = localServerPassword(db.user);
  return password ? { ...db, password } : db;
}

/**
 * Passwords to try for `user` on this computer's server, in order: the one given, the saved
 * one (Windows), then none (trust auth). Never guessed ones.
 */
export function localPasswordCandidates(user: string, given?: string): string[] {
  const saved = localServerPassword(user);
  return [...new Set([given || '', saved, ''].filter((p, i) => p !== '' || i === 2))];
}

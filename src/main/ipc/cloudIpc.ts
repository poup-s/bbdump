/**
 * Cloud host accounts used to add databases (Neon for now). The API key never reaches the
 * renderer: it is stored encrypted in <userData>/cloud-credentials.json (0600), apart from
 * config.json so that file's format does not change.
 */
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from '../paths';
import { encryptionManager } from '../encryption';
import { logger } from '../logger';
import { NeonApiError, setNeonApiBase, listProjects, listBranches, listDatabases, connectionUri } from '../neonApi';

interface Credentials { neon?: string }

const credentialsPath = () => path.join(pathManager.appDataPath, 'cloud-credentials.json');

function readCredentials(): Credentials {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Credentials;
    return typeof raw === 'object' && raw ? raw : {};
  } catch {
    return {};
  }
}

function writeCredentials(credentials: Credentials) {
  const file = credentialsPath();
  if (!credentials.neon) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The saved key, or null (none, or encrypted with a key that was replaced since) */
function neonKey(): string | null {
  const stored = readCredentials().neon;
  if (!stored) return null;
  try {
    return encryptionManager.decrypt(stored);
  } catch {
    logger.warn('Saved Neon API key cannot be decrypted (encryption key changed): ignored');
    return null;
  }
}

type Reply<T> = { success: true; data: T } | { success: false; error: string; code: 'no_key' | 'invalid_key' | 'network' | 'api' };

async function attempt<T>(run: () => Promise<T>): Promise<Reply<T>> {
  try {
    return { success: true, data: await run() };
  } catch (error) {
    const code = error instanceof NeonApiError ? error.code : 'api';
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Neon API: ${message}`);
    return { success: false, error: message, code };
  }
}

async function withKey<T>(run: (key: string) => Promise<T>): Promise<Reply<T>> {
  const key = neonKey();
  if (!key) return { success: false, error: 'No Neon API key', code: 'no_key' };
  return attempt(() => run(key));
}

export function registerCloudHandlers() {
  // The dev app can talk to a mock server instead of Neon
  if (!app.isPackaged) setNeonApiBase(process.env.BBDUMP_NEON_API);

  ipcMain.handle('neon-status', () => ({ connected: neonKey() !== null }));

  /** Checks the key by listing the projects, then saves it */
  ipcMain.handle('neon-connect', async (_e, key: unknown) => {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed || trimmed.length > 512 || /\s/.test(trimmed)) return { success: false, error: 'Invalid API key', code: 'invalid_key' };
    const reply = await attempt(() => listProjects(trimmed));
    if (reply.success) {
      writeCredentials({ ...readCredentials(), neon: encryptionManager.encrypt(trimmed) });
      logger.info('Neon API key saved');
    }
    return reply;
  });

  ipcMain.handle('neon-forget', () => {
    const rest = { ...readCredentials() };
    delete rest.neon;
    writeCredentials(rest);
    logger.info('Neon API key removed');
    return { success: true };
  });

  ipcMain.handle('neon-projects', () => withKey(key => listProjects(key)));
  ipcMain.handle('neon-branches', (_e, projectId: string) => withKey(key => listBranches(key, projectId)));
  ipcMain.handle('neon-databases', (_e, projectId: string, branchId: string) => withKey(key => listDatabases(key, projectId, branchId)));
  ipcMain.handle('neon-connection-uri', (_e, projectId: string, branchId: string, database: string, role: string) =>
    withKey(key => connectionUri(key, projectId, branchId, database, role)));
}

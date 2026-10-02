/**
 * The add / edit dialog for a database on a server: the user's SSH host aliases, a first
 * connection (with the server's fingerprint when it is unknown), trusting it, and
 * reading the database URL from an env file on the server.
 */
import { ipcMain } from 'electron';
import { logger } from '../logger';
import type { SshSettings } from '../../types/config';
import { SshError, findRemoteEnvFiles, hostFingerprints, listSshHosts, readRemoteEnv, resolveTarget, runOnServer, trustHost } from '../sshTunnel';

type Failure = { success: false; code: string; error: string; fingerprints?: string[] };

const failure = async (error: unknown, ssh?: SshSettings): Promise<Failure> => {
  const code = error instanceof SshError ? error.code : 'other';
  const message = error instanceof Error ? error.message : String(error);
  // Unknown server: show its fingerprint so the user can trust it knowingly
  const fingerprints = code === 'unknown-host' && ssh ? await hostFingerprints(ssh).catch(() => []) : undefined;
  logger.warn(`SSH ${ssh?.host ?? ''}: ${code}: ${message.split('\n')[0]}`);
  return { success: false, code, error: message, fingerprints };
};

export function registerSshHandlers() {
  ipcMain.handle('ssh-hosts', () => {
    try {
      return listSshHosts();
    } catch {
      return [];
    }
  });

  /** Connects once (runs `true`): proves the alias, the key and the server's key */
  ipcMain.handle('ssh-check', async (_e, ssh: SshSettings) => {
    const started = Date.now();
    try {
      await runOnServer(ssh, 'true');
      const resolved = await resolveTarget(ssh).catch(() => null);
      return { success: true, ms: Date.now() - started, hostname: resolved?.hostname, user: resolved?.user };
    } catch (error) {
      return failure(error, ssh);
    }
  });

  ipcMain.handle('ssh-trust-host', async (_e, ssh: SshSettings) => {
    try {
      await trustHost(ssh);
      logger.info(`SSH host key of ${ssh.host} added to known_hosts`);
      return { success: true };
    } catch (error) {
      return failure(error, ssh);
    }
  });

  /** The env files on the server holding a PostgreSQL URL: paths and variable names, no values */
  ipcMain.handle('ssh-find-env', async (_e, ssh: SshSettings) => {
    try {
      const files = await findRemoteEnvFiles(ssh);
      logger.info(`SSH ${ssh.host}: ${files.length} env file(s) with a PostgreSQL URL found`);
      return { success: true, files };
    } catch (error) {
      return failure(error, ssh);
    }
  });

  /** The value of a variable in an env file on the server (the database URL, usually) */
  ipcMain.handle('ssh-read-env', async (_e, ssh: SshSettings, file: string, name: string) => {
    try {
      const value = await readRemoteEnv(ssh, file, name);
      if (value === null) return { success: false, code: 'not-found', error: `${name} not found in ${file}` };
      return { success: true, value };
    } catch (error) {
      return failure(error, ssh);
    }
  });
}

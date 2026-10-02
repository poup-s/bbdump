/** Connection parameters of a saved database (password decrypted), for dbViewer-style clients */
import { getConfig } from './ipc/configIpc';
import { toRuntimeDatabase } from './dbSecrets';
import { logger } from './logger';
import { tunnelled } from './sshTunnel';
import type { DatabaseConfig } from '../types/config';

/** Through its SSH tunnel when the database has one (opened if needed) */
export async function connectionParamsFor(dbId: string) {
  const config = getConfig();
  if (!config || !Array.isArray(config.databases)) {
    throw new Error('Configuration not loaded or databases array is missing');
  }
  const db = config.databases.find(d => d.id === dbId);
  if (!db) throw new Error(`Database with id "${dbId}" not found in configuration`);

  let runtime: DatabaseConfig;
  try {
    runtime = toRuntimeDatabase(db);
  } catch (error) {
    logger.error(`Failed to decrypt password for ${db.name}: ${error}`);
    throw new Error(`Failed to decrypt password for ${db.name}`);
  }

  const reached = await tunnelled(runtime);
  return {
    host: reached.host,
    port: reached.port,
    user: db.user,
    password: runtime.password,
    database: db.name,
    connectionString: reached.connectionString,
    ssl: db.ssl,
    sslMode: reached.sslMode,
    sslRootCert: db.sslRootCert,
    viaTunnel: reached.viaTunnel,
  };
}

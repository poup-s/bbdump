/**
 * Restore into a new database, for the engines without a local server of bbdump's own
 * (MySQL, MariaDB, MongoDB: a new database on the server of a saved database of the same
 * engine; SQLite: a new file). The database is saved only once the restore worked: a failed
 * restore removes what it created.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BackupResult, DatabaseConfig } from '../types/config';
import { getConfig, saveConfig } from './ipc/configIpc';
import { engineOf } from '../shared/engines/features';
import { isMysqlFamily } from '../shared/engines/manifests';
import { quoteIdent } from '../shared/engines/sqlGuard';
import { facetFor } from './engines/registry';
import { withSavedMysql } from './engines/mysql';
import { withSavedMongo } from './engines/mongodb';
import { closeSqlServerPools, withSavedSqlServer } from './engines/sqlserver';
import { toRuntimeDatabase } from './dbSecrets';
import { withTunnel } from './sshTunnel';
import { listBackupEntries } from './backupActions';
import { readArchiveEngine } from './backupFormat';
import { logger } from './logger';
import { getErrorMessage } from './utils';

/** Engines restored into a new database by this module (PostgreSQL creates a local one) */
export const RESTORE_TO_NEW_ENGINES = ['mysql', 'mariadb', 'mongodb', 'sqlite', 'duckdb', 'sqlserver'];

const SQLITE_FILE = /\.(sqlite3?|db3?|s3db|sl3)$/i;
const DUCKDB_FILE = /\.(duckdb|ddb|db)$/i;

export interface RestoreToNewParams {
  backupFile: string;
  /** MySQL, MariaDB, MongoDB: the saved database whose server receives the new one */
  serverOf?: string;
  /** MySQL, MariaDB, MongoDB: the new database's name */
  name?: string;
  /** SQLite, DuckDB: the new file */
  file?: string;
  /** The file's engine when the backup does not say (an old listing) */
  engine?: string;
}

export interface RestoreToNewResult {
  success: boolean;
  id?: string;
  name?: string;
  warnings?: string[];
  error?: string;
}

/** The URL of the new database: the same, another database (MySQL, MariaDB) */
export function urlWithDatabase(connectionString: string | undefined, name: string): string | undefined {
  if (!connectionString) return undefined;
  const scheme = /^(mysql|mariadb):/i.exec(connectionString)?.[1];
  // MongoDB keeps its URL: its path may be where the user is looked up, the name says the database
  if (!scheme) return connectionString;
  try {
    const url = new URL(connectionString.replace(/^(mysql|mariadb):/i, 'http:'));
    url.pathname = `/${encodeURIComponent(name)}`;
    return url.toString().replace(/^http:/, `${scheme}:`);
  } catch {
    return undefined;
  }
}

/** The new database's entry: the connection of `template` (password still encrypted), another name or file */
export function newDatabaseEntry(template: DatabaseConfig, name: string, file?: string): DatabaseConfig {
  return {
    ...template,
    id: randomUUID(),
    name,
    displayName: name,
    // SQL Server databases are saved field by field: a connection string would name the old database
    connectionString: engineOf(template) === 'sqlserver' ? undefined : urlWithDatabase(template.connectionString, name),
    sqlite: file ? { path: file } : template.sqlite,
    enabled: false,
    lastBackup: undefined,
    status: undefined,
    isLocalBbdump: false,
    syncSourceId: undefined,
  };
}

/** A database name the engine accepts, and that is safe on a command line and in a URL */
export function validNewName(name: string, engine: string): boolean {
  if (engine === 'mongodb') return /^[A-Za-z0-9_-]{1,63}$/.test(name) && !['admin', 'local', 'config'].includes(name.toLowerCase());
  return /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(name);
}

async function restoreInto(entry: DatabaseConfig, backupFile: string): Promise<BackupResult> {
  const facet = await facetFor(engineOf(entry), 'restore.toOther', 'restore');
  const runtime = toRuntimeDatabase(entry);
  // Nothing to replace in a new database
  return withTunnel(runtime, reached => facet.restore(backupFile, reached, { replace: false }));
}

export async function restoreToNewDatabase(params: RestoreToNewParams): Promise<RestoreToNewResult> {
  let undo: (() => Promise<void>) | null = null;

  const save = (entry: DatabaseConfig, result: BackupResult): RestoreToNewResult => {
    const latest = getConfig();
    latest.databases.push(entry);
    saveConfig(latest);
    undo = null;
    logger.info(`Restored ${path.basename(params.backupFile)} into the new database ${entry.name}`);
    return { success: true, id: entry.id, name: entry.name, warnings: result.warnings?.length ? result.warnings : undefined };
  };

  try {
    const config = getConfig();
    const backupEngine = listBackupEntries(config).find(e => e.file === params.backupFile || e.filename === params.backupFile)?.engine;

    if (params.file !== undefined) {
      // A file engine: SQLite or DuckDB, as the backup says (its listing, the dialog, else its first bytes), else the new file's name
      const known = backupEngine ?? params.engine ?? (path.isAbsolute(params.backupFile) ? readArchiveEngine(params.backupFile) : undefined);
      const fileEngine = known === 'duckdb' || (!known && /\.(duckdb|ddb)$/i.test(String(params.file))) ? 'duckdb' : 'sqlite';
      if (known && known !== fileEngine) throw new Error(`This backup is not a ${fileEngine === 'duckdb' ? 'DuckDB' : 'SQLite'} one`);
      const pattern = fileEngine === 'duckdb' ? DUCKDB_FILE : SQLITE_FILE;
      const file = path.resolve(String(params.file));
      if (!pattern.test(file)) throw new Error(fileEngine === 'duckdb' ? 'Choose a .duckdb file' : 'Choose a .sqlite or .db file');
      if (fs.existsSync(file)) throw new Error(`A file already exists at ${file}`);
      if (!fs.existsSync(path.dirname(file))) throw new Error(`The folder ${path.dirname(file)} does not exist`);
      const name = path.basename(file).replace(pattern, '');
      const template = config.databases.find(d => engineOf(d) === fileEngine);
      const entry: DatabaseConfig = {
        ...(template ? newDatabaseEntry(template, name) : { id: randomUUID(), name, displayName: name, enabled: false } as DatabaseConfig),
        engine: fileEngine, host: '', port: 0, user: '', password: '', encrypted: false,
        connectionString: undefined, ssh: undefined,
        sqlite: fileEngine === 'sqlite' ? { path: file } : undefined,
        duckdb: fileEngine === 'duckdb' ? { path: file } : undefined,
      };
      if (!entry.output) entry.output = template?.output ?? '';
      undo = async () => { for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`, `${file}.wal`]) fs.rmSync(f, { force: true }); };
      const result = await restoreInto(entry, params.backupFile);
      if (!result.success) throw new Error(result.error || 'Restore failed');
      return save(entry, result);
    }

    const server = config.databases.find(d => d.id === params.serverOf);
    if (!server) throw new Error('Choose the server that receives the new database');
    const engine = engineOf(server);
    if (!RESTORE_TO_NEW_ENGINES.includes(engine) || engine === 'sqlite' || engine === 'duckdb') throw new Error('This server cannot receive a new database this way');
    if (backupEngine && backupEngine !== engine) throw new Error(`This backup comes from ${backupEngine}, the server runs ${engine}`);
    const name = String(params.name ?? '').trim();
    if (!validNewName(name, engine)) throw new Error('A database name of letters, digits and _ is needed');
    if (config.databases.some(d => engineOf(d) === engine && d.name === name && d.host === server.host && d.port === server.port)) {
      throw new Error(`${name} is already saved in bbdump`);
    }
    const entry = newDatabaseEntry(server, name);

    if (isMysqlFamily(engine)) {
      await withSavedMysql(server.id, async conn => {
        const [rows] = await conn.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
        if ((rows as unknown[]).length) throw new Error(`A database named ${name} already exists on this server`);
        try {
          await conn.query(`CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4`);
        } catch (error) {
          throw new Error(`The database could not be created on this server (the account needs the CREATE privilege): ${getErrorMessage(error)}`);
        }
      });
      undo = async () => {
        await withSavedMysql(server.id, async c => { await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name, 'mysql')}`); });
      };
    } else if (engine === 'sqlserver') {
      await withSavedSqlServer(server.id, async query => {
        if ((await query('SELECT DB_ID(@p1) AS id', [name]))[0]?.id !== null) throw new Error(`A database named ${name} already exists on this server`);
        try {
          await query(`CREATE DATABASE ${quoteIdent(name, 'tsql')}`);
        } catch (error) {
          throw new Error(`The database could not be created on this server (the account needs the CREATE DATABASE permission): ${getErrorMessage(error)}`);
        }
      });
      undo = async () => {
        // Its connections (the restore's) closed first: a database in use cannot be dropped
        await closeSqlServerPools();
        await withSavedSqlServer(server.id, async query => {
          await query(`IF DB_ID(@p1) IS NOT NULL BEGIN ALTER DATABASE ${quoteIdent(name, 'tsql')} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${quoteIdent(name, 'tsql')}; END`, [name]);
        });
      };
    } else {
      // MongoDB creates a database with its first collection: only check the name is free
      await withSavedMongo(server.id, async client => {
        const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
        if (databases.some(d => d.name.toLowerCase() === name.toLowerCase())) throw new Error(`A database named ${name} already exists on this server`);
      });
      undo = async () => {
        await withSavedMongo(server.id, async client => { await client.db(name).dropDatabase(); });
      };
    }

    const result = await restoreInto(entry, params.backupFile);
    if (!result.success) throw new Error(result.error || 'Restore failed');
    return save(entry, result);
  } catch (error) {
    logger.error(`Restore into a new database failed: ${getErrorMessage(error)}`);
    const pending = undo as (() => Promise<void>) | null;
    if (pending) await pending().catch(e => logger.warn(`The new database could not be removed: ${getErrorMessage(e)}`));
    return { success: false, error: getErrorMessage(error) };
  }
}

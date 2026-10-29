/**
 * Copy and "Update from…" for saved MySQL, MariaDB and SQLite databases: the connections (SSH
 * tunnel included), the safety rules, and the copy saved as a new database.
 * - Copy (MySQL / MariaDB): a new database on the source's server, or on the server of another
 *   saved database of the same family; (SQLite): a new file. The copy is undone if it fails.
 * - Update: only a database of this computer is written (a SQLite file, or MySQL on localhost
 *   without SSH), from a database of the same family and the same project.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseConfig } from '../../types/config';
import { getConfig, saveConfig } from '../ipc/configIpc';
import { engineOf } from '../../shared/engines/features';
import { isMysqlFamily } from '../../shared/engines/manifests';
import { quoteIdent } from '../../shared/engines/sqlGuard';
import { withSavedMysql } from '../engines/mysql';
import { openSqliteFile } from '../engines/sqlite';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { buildAnonymizePlan, emptiedTables, resolveAnonymization, type AnonymizeChoices } from './anonymizedCopy';
import type { AnonymizeKind } from './dataSync';
import {
  analyzeSqlSync, applySqlSync, copyAll, inSnapshot, mysqlSide, pgShape, readSqlCatalog, sqliteSide, withCopySession,
  type CopyResult, type SqlSide,
} from './sqlCopy';
import type { SyncAnalysis, SyncChoices, SyncProgress, SyncResult } from './syncEngine';

const SQL_ENGINES = ['mysql', 'mariadb', 'sqlite'];
export const isSqlCopyEngine = (db: Pick<DatabaseConfig, 'engine'> | undefined) => SQL_ENGINES.includes(engineOf(db));
/** MySQL and MariaDB copy into each other; SQLite only into SQLite */
const family = (db: Pick<DatabaseConfig, 'engine'>) => (isMysqlFamily(engineOf(db)) ? 'mysql' : engineOf(db));

function saved(id: string): DatabaseConfig {
  const db = getConfig().databases.find(d => d.id === id);
  if (!db) throw new Error('Database not found');
  return db;
}

/** A connection to a saved database (through its tunnel), as a side */
async function withSide<T>(db: DatabaseConfig, mode: 'read' | 'write', fn: (side: SqlSide) => Promise<T>): Promise<T> {
  if (engineOf(db) === 'sqlite') {
    if (!db.sqlite?.path) throw new Error('This SQLite database has no file');
    const file = openSqliteFile(db.sqlite.path, { readOnly: mode === 'read' });
    try {
      return await fn(sqliteSide(file));
    } finally {
      file.close();
    }
  }
  return withSavedMysql(db.id, conn => fn(mysqlSide(conn, db.name)));
}

/** The URL of a copy: the same, another database */
function urlFor(connectionString: string | undefined, name: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    const scheme = /^(mysql|mariadb):/i.exec(connectionString)?.[1] ?? 'mysql';
    const url = new URL(connectionString.replace(/^(mysql|mariadb):/i, 'http:'));
    url.pathname = `/${encodeURIComponent(name)}`;
    return url.toString().replace(/^http:/, `${scheme}:`);
  } catch {
    return undefined;
  }
}

/** The copy saved as a new database: the connection of `template` (password still encrypted), another database or file */
function saveCopy(template: DatabaseConfig, source: DatabaseConfig, name: string, file?: string): DatabaseConfig {
  const config = getConfig();
  const copy: DatabaseConfig = {
    ...template,
    id: randomUUID(),
    name,
    displayName: name,
    connectionString: urlFor(template.connectionString, name),
    sqlite: file ? { path: file } : template.sqlite,
    enabled: false,
    lastBackup: undefined,
    status: undefined,
    isLocalBbdump: false,
    syncSourceId: source.id,
  };
  config.databases.push(copy);
  saveConfig(config);
  return copy;
}

export interface SqlDuplicateParams {
  sourceId: string;
  /** MySQL / MariaDB: the new database's name, on the server of `serverOf` (the source by default) */
  name?: string;
  serverOf?: string;
  /** SQLite: the new file */
  file?: string;
  anonymize?: AnonymizeChoices;
}

type Progress = (step: string, message: string, progress: number) => void;

export async function duplicateSqlDatabase(params: SqlDuplicateParams, progress: Progress): Promise<{ success: boolean; id?: string; name?: string; warnings?: string[]; error?: string }> {
  let undo: (() => Promise<void>) | null = null;
  try {
    const source = saved(params.sourceId);
    if (!isSqlCopyEngine(source)) throw new Error('Not a MySQL, MariaDB or SQLite database');

    const copyInto = (src: SqlSide, tgt: SqlSide): Promise<CopyResult> => withCopySession(src, { foreignKeys: true }, () => inSnapshot(src, async () => {
      const catalog = await readSqlCatalog(src);
      let anonymize: Map<string, AnonymizeKind> | undefined;
      let emptyTables: Set<string> | undefined;
      if (params.anonymize) {
        // Checked against the source's own plan: unknown or locked columns are refused, linked ones follow
        const plan = buildAnonymizePlan(pgShape(catalog), new Map([...catalog.tables.values()].map(t => [t.key, t.rows])));
        const strip = (key: string) => key.slice(catalog.database.length + 1);
        anonymize = new Map([...resolveAnonymization(plan, params.anonymize.columns)].map(([k, v]) => [strip(k), v] as const));
        emptyTables = new Set([...emptiedTables(plan, params.anonymize.emptyTables)].map(strip));
      }
      progress('copying', `Copying ${catalog.tables.size} table(s)…`, 20);
      return withCopySession(tgt, { foreignKeys: false }, () => copyAll(src, tgt, catalog, {
        anonymize,
        emptyTables,
        onProgress: p => progress('copying', `${p.table}: ${p.rows} row(s)`, 20 + Math.round((p.index / Math.max(1, p.total)) * 75)),
      }));
    }));

    if (engineOf(source) === 'sqlite') {
      const file = path.resolve(String(params.file ?? ''));
      if (!params.file || !/\.(sqlite3?|db3?|s3db|sl3)$/i.test(file)) throw new Error('Choose a .sqlite or .db file for the copy');
      if (fs.existsSync(file)) throw new Error(`A file already exists at ${file}`);
      if (!fs.existsSync(path.dirname(file))) throw new Error(`The folder ${path.dirname(file)} does not exist`);
      if (path.resolve(source.sqlite?.path ?? '') === file) throw new Error('The copy must be another file');
      progress('creating', `Creating ${path.basename(file)}…`, 10);
      undo = async () => { for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true }); };
      let warnings: string[] = [];
      const src = openSqliteFile(source.sqlite!.path, { readOnly: true });
      try {
        if (!params.anonymize) {
          // Not anonymized: SQLite's own online copy, exact (virtual tables and all)
          const { backup } = await import('node:sqlite');
          progress('copying', 'Copying the file…', 30);
          await backup(src, file);
        } else {
          const tgt = openSqliteFile(file, { create: true });
          try {
            warnings = (await copyInto(sqliteSide(src), sqliteSide(tgt))).warnings;
          } finally {
            tgt.close();
          }
        }
      } finally {
        src.close();
      }
      const name = path.basename(file).replace(/\.(sqlite3?|db3?|s3db|sl3)$/i, '');
      const copy = saveCopy(source, source, name, file);
      undo = null;
      progress('complete', 'Copy saved', 100);
      logger.info(`SQLite copy of ${source.name} → ${file}${params.anonymize ? ' (anonymized)' : ''}`);
      return { success: true, id: copy.id, name, warnings: warnings.length ? warnings : undefined };
    }

    // MySQL / MariaDB: a new database on a server bbdump already reaches
    const server = saved(params.serverOf || source.id);
    if (family(server) !== family(source)) throw new Error('The copy goes to a server of the same engine');
    const name = String(params.name ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(name)) throw new Error('A database name of letters, digits and _ is needed');

    const result = await withSavedMysql(source.id, async srcConn => withSavedMysql(server.id, async tgtConn => {
      const src = mysqlSide(srcConn, source.name);
      const tgt = mysqlSide(tgtConn, name);
      const [charset] = await src.all('SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()');
      if ((await tgt.all('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name])).length) throw new Error(`A database named ${name} already exists on this server`);
      progress('creating', `Creating ${name}…`, 10);
      const [prior] = await tgt.all('SELECT DATABASE() AS db');
      // Only plain names: the charset and collation come from the server's own catalog
      const plain = (v: unknown) => (typeof v === 'string' && /^\w+$/.test(v) ? v : null);
      try {
        await tgt.run(`CREATE DATABASE ${quoteIdent(name, 'mysql')}${plain(charset?.cs) ? ` CHARACTER SET ${plain(charset.cs)}` : ''}${plain(charset?.co) ? ` COLLATE ${plain(charset.co)}` : ''}`);
      } catch (error) {
        throw new Error(`The database could not be created on this server (the account needs the CREATE privilege): ${getErrorMessage(error)}`);
      }
      undo = async () => {
        await withSavedMysql(server.id, async c => { await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name, 'mysql')}`); });
      };
      await tgt.run(`USE ${quoteIdent(name, 'mysql')}`);
      try {
        return await copyInto(src, tgt);
      } finally {
        // The pooled connection goes back to its own database
        if (prior?.db) await tgt.run(`USE ${quoteIdent(String(prior.db), 'mysql')}`).catch(() => {});
      }
    }));
    const copy = saveCopy(server, source, name);
    undo = null;
    progress('complete', 'Copy saved', 100);
    logger.info(`${engineOf(source)} copy of ${source.name} → ${name} on ${server.host}:${server.port}${params.anonymize ? ' (anonymized)' : ''}: ${result.rows} row(s)`);
    return { success: true, id: copy.id, name, warnings: result.warnings.length ? result.warnings : undefined };
  } catch (error) {
    logger.error(`Copy failed: ${getErrorMessage(error)}`);
    const pending = undo as (() => Promise<void>) | null;
    if (pending) await pending().catch(e => logger.warn(`The unfinished copy could not be removed: ${getErrorMessage(e)}`));
    return { success: false, error: getErrorMessage(error) };
  }
}

// --- Update from… ------------------------------------------------------------------------------

/** Only a database of this computer is written, from a database of its family and project */
export function sqlPair(targetId: string, sourceId: string, writable: boolean): { target: DatabaseConfig; source: DatabaseConfig } {
  const target = saved(targetId);
  const source = saved(sourceId);
  if (target.id === source.id) throw new Error('The source and the target are the same database');
  if (family(target) !== family(source)) throw new Error('The source must be a database of the same engine');
  if (writable) {
    const host = (target.host || '').toLowerCase();
    const local = engineOf(target) === 'sqlite' || (['localhost', '127.0.0.1', '::1'].includes(host) && !target.ssh);
    if (!local) throw new Error('Only a database of this computer can be updated from another one');
    const project = (getConfig().projects ?? []).find(p => p.databaseIds?.includes(target.id));
    if (!project?.databaseIds?.includes(source.id)) throw new Error('The source must be a database of the same project');
  }
  return { target, source };
}

export async function analyzeSqlPair(targetId: string, sourceId: string, writable: boolean): Promise<SyncAnalysis> {
  const { target, source } = sqlPair(targetId, sourceId, writable);
  return withSide(source, 'read', src => withCopySession(src, { foreignKeys: true }, () => inSnapshot(src, () =>
    withSide(target, 'read', async tgt => {
      const analysis = await analyzeSqlSync(src, tgt);
      return {
        source: { id: source.id, name: source.displayName || source.name, host: source.host, version: 0 },
        target: { id: target.id, name: target.displayName || target.name, host: target.host, version: 0 },
        ...analysis,
      };
    }))));
}

export async function applySqlPair(
  targetId: string,
  sourceId: string,
  choices: SyncChoices,
  onProgress: (p: SyncProgress) => void,
): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
  const { target, source } = sqlPair(targetId, sourceId, true);
  return withSide(source, 'read', src => withCopySession(src, { foreignKeys: true }, () => inSnapshot(src, () =>
    // MySQL checks keys (INSERT IGNORE skips orphans); SQLite keeps its default (off)
    withSide(target, 'write', tgt => withCopySession(tgt, { foreignKeys: tgt.dialect === 'mysql' }, () => applySqlSync(src, tgt, choices, onProgress))))));
}

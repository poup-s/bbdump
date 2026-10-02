/**
 * Update a local database from a source (e.g. prod): schema additions, then the rows the
 * local copy lacks, optionally anonymized. The source is only read, in one READ ONLY
 * snapshot; only a database on the local server (isLocalBbdump) can be written.
 */
import type { PoolClient } from 'pg';
import { withConnection } from '../dbViewer';
import { connectionParamsFor } from '../savedConnection';
import { getConfig, saveConfig } from '../ipc/configIpc';
import { runBackupNow } from '../backupActions';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import { readCatalog, type Catalog, type CatalogTable } from './catalog';
import { diffSchemas, type SchemaChange } from './schemaDiff';
import {
  anonymizationCandidates, catchUpSequences, copyMissingRows, countMissingRows, dependencyOrder, timeColumn,
  type AnonymizeCandidate, type AnonymizeKind,
} from './dataSync';

/** Missing rows found key by key up to this many source rows; a count difference beyond */
const EXACT_LIMIT = 50000;
/** Rows counted exactly (count(*)) up to this size; the planner estimate beyond */
const COUNT_LIMIT = 2_000_000;
/** Tables bigger than this are left out by default */
const LARGE_TABLE = 1_000_000;

export interface TablePlan {
  key: string;
  newTable: boolean;
  primaryKey: string[] | null;
  sourceRows: number;
  localRows: number;
  missing: number | null;
  missingExact: boolean;
  timeColumn?: string;
  defaultSelected: boolean;
  reason?: 'no_primary_key' | 'too_large' | 'up_to_date';
}

export interface SyncAnalysis {
  source: { id: string; name: string; host: string; version: number };
  target: { id: string; name: string; host: string; version: number };
  schema: SchemaChange[];
  tables: TablePlan[];
  anonymize: AnonymizeCandidate[];
}

export interface SyncChoices {
  changes: string[];
  tables: Array<{ key: string; recentDays?: number }>;
  anonymize: Array<{ table: string; column: string; kind: AnonymizeKind }>;
  backup: boolean;
}

export type SyncProgress =
  | { stage: 'backup' }
  | { stage: 'schema'; done: number; total: number; current?: string }
  | { stage: 'data'; table: string; index: number; total: number; copied: number; skipped: number }
  | { stage: 'done' };

export interface SyncResult {
  success: boolean;
  error?: string;
  backupFile?: string;
  schema: { applied: number; failed: Array<{ id: string; error: string }> };
  tables: Array<{ key: string; copied: number; skipped: number; error?: string }>;
}

function pair(targetId: string, sourceId: string, writable = true) {
  const databases = getConfig().databases;
  const target = databases.find(d => d.id === targetId);
  const source = databases.find(d => d.id === sourceId);
  if (!target || !source) throw new Error('Database not found');
  if (target.id === source.id) throw new Error('The source and the target are the same database');
  if (writable) {
    // Never write anywhere but a database of the local server, from a database of its project
    const host = (target.host || '').toLowerCase();
    const onThisComputer = ['localhost', '127.0.0.1', '::1'].includes(host) || host.startsWith('/');
    if (!target.isLocalBbdump || !onThisComputer) throw new Error('Only a database of the local server can be updated from another one');
    const project = (getConfig().projects ?? []).find(p => p.databaseIds?.includes(target.id));
    if (!project?.databaseIds?.includes(source.id)) throw new Error('The source must be a database of the same project');
  }
  return { target, source };
}

/** Runs fn in a REPEATABLE READ READ ONLY transaction on the source: one consistent snapshot */
async function onSource<T>(sourceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(await connectionParamsFor(sourceId), async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL TimeZone = 'UTC'`);
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  });
}

async function onTarget<T>(targetId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(await connectionParamsFor(targetId), async (client) => {
    await client.query(`SET TimeZone = 'UTC'`);
    return fn(client);
  });
}

async function exactCount(client: PoolClient, t: CatalogTable): Promise<number> {
  const rel = `"${t.schema.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`;
  return Number((await client.query(`SELECT count(*) AS n FROM ${rel}`)).rows[0].n);
}

export async function analyzeSync(targetId: string, sourceId: string): Promise<SyncAnalysis> {
  pair(targetId, sourceId);

  // Remember the source for next time
  const config = getConfig();
  const saved = config.databases.find(d => d.id === targetId);
  if (saved && saved.syncSourceId !== sourceId) {
    saved.syncSourceId = sourceId;
    saveConfig(config);
  }
  return analyze(targetId, sourceId, onTarget);
}

/**
 * What a database lacks compared to another one (schema and rows), both only read: any
 * two saved databases, e.g. for the MCP server's compare_databases. Nothing is remembered.
 */
export async function compareDatabases(sourceId: string, targetId: string): Promise<SyncAnalysis> {
  pair(targetId, sourceId, false);
  return analyze(targetId, sourceId, onSource);
}

async function analyze(
  targetId: string,
  sourceId: string,
  openTarget: <T>(id: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
): Promise<SyncAnalysis> {
  const { target, source } = pair(targetId, sourceId, false);
  return onSource(sourceId, (src) => openTarget(targetId, async (tgt) => {
    const sourceCatalog = await readCatalog(src);
    const targetCatalog = await readCatalog(tgt);
    const schema = diffSchemas(sourceCatalog, targetCatalog);

    const tables: TablePlan[] = [];
    for (const table of sourceCatalog.tables.values()) {
      const local = targetCatalog.tables.get(table.key);
      const sourceRows = table.estimate < COUNT_LIMIT ? await exactCount(src, table) : table.estimate;
      const localRows = !local ? 0 : local.estimate < COUNT_LIMIT ? await exactCount(tgt, local) : local.estimate;
      const plan: TablePlan = {
        key: table.key, newTable: !local, primaryKey: table.primaryKey, sourceRows, localRows,
        missing: null, missingExact: false, timeColumn: timeColumn(table), defaultSelected: false,
      };
      if (!table.primaryKey) plan.reason = 'no_primary_key';
      else if (!local || localRows === 0) { plan.missing = sourceRows; plan.missingExact = table.estimate < COUNT_LIMIT; }
      else if (sourceRows <= EXACT_LIMIT && local.primaryKey?.join() === table.primaryKey.join()) {
        plan.missing = await countMissingRows(src, tgt, table, local);
        plan.missingExact = true;
      } else {
        plan.missing = Math.max(0, sourceRows - localRows);
      }
      // "Up to date" only when checked key by key; a count difference of 0 may hide rows
      if (plan.primaryKey && plan.missing === 0 && plan.missingExact) plan.reason = 'up_to_date';
      if (plan.primaryKey && sourceRows > LARGE_TABLE) plan.reason = 'too_large';
      plan.defaultSelected = !!plan.primaryKey && !!plan.missing && sourceRows <= LARGE_TABLE;
      tables.push(plan);
    }

    const anonymize = [...sourceCatalog.tables.values()].flatMap(anonymizationCandidates);
    return {
      source: { id: source.id, name: source.displayName || source.name, host: source.host, version: sourceCatalog.serverVersion },
      target: { id: target.id, name: target.displayName || target.name, host: target.host, version: targetCatalog.serverVersion },
      schema,
      tables: tables.sort((a, b) => a.key.localeCompare(b.key)),
      anonymize,
    };
  }));
}

export async function applySync(targetId: string, sourceId: string, choices: SyncChoices, onProgress: (p: SyncProgress) => void): Promise<SyncResult> {
  const result: SyncResult = { success: false, schema: { applied: 0, failed: [] }, tables: [] };
  try {
    pair(targetId, sourceId);

    if (choices.backup) {
      onProgress({ stage: 'backup' });
      const backup = await runBackupNow(targetId);
      if (!backup.success) return { ...result, error: `Backup of the local database failed, nothing was changed: ${backup.error}` };
      result.backupFile = backup.filePath;
    }

    await onSource(sourceId, (src) => onTarget(targetId, async (tgt) => {
      // Schema: from the source as it is now (the analysis may be minutes old)
      const sourceCatalog: Catalog = await readCatalog(src);
      const wanted = new Set(choices.changes);
      const changes = diffSchemas(sourceCatalog, await readCatalog(tgt)).filter(c => wanted.has(c.id));
      let done = 0;
      // Extensions and enum values first, each on its own (a new enum value cannot be
      // used in the transaction that adds it)
      for (const change of changes.filter(c => c.kind === 'enum_value' || c.kind === 'extension')) {
        onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
        try {
          for (const sql of change.sql) await tgt.query(sql);
          result.schema.applied++;
        } catch (error) {
          result.schema.failed.push({ id: change.id, error: getErrorMessage(error) });
        }
        done++;
      }
      await tgt.query('BEGIN');
      try {
        for (const change of changes.filter(c => c.kind !== 'enum_value' && c.kind !== 'extension')) {
          onProgress({ stage: 'schema', done, total: changes.length, current: change.object });
          await tgt.query('SAVEPOINT bbdump_change');
          try {
            for (const sql of change.sql) await tgt.query(sql);
            await tgt.query('RELEASE SAVEPOINT bbdump_change');
            result.schema.applied++;
          } catch (error) {
            await tgt.query('ROLLBACK TO SAVEPOINT bbdump_change');
            result.schema.failed.push({ id: change.id, error: getErrorMessage(error) });
          }
          done++;
        }
        await tgt.query('COMMIT');
      } catch (error) {
        await tgt.query('ROLLBACK').catch(() => {});
        throw error;
      }
      onProgress({ stage: 'schema', done, total: changes.length });

      // Data: parents first, each table in its own transaction
      const targetCatalog = await readCatalog(tgt);
      const chosen = new Map(choices.tables.map(t => [t.key, t]));
      const ordered = dependencyOrder([...sourceCatalog.tables.values()].filter(t => chosen.has(t.key)));
      for (let index = 0; index < ordered.length; index++) {
        const table = ordered[index];
        const local = targetCatalog.tables.get(table.key);
        const outcome: SyncResult['tables'][number] = { key: table.key, copied: 0, skipped: 0 };
        result.tables.push(outcome);
        if (!local) { outcome.error = 'the table does not exist locally (its schema change was not applied)'; continue; }
        const anonymize = new Map(choices.anonymize.filter(a => a.table === table.key).map(a => [a.column, a.kind] as const));
        const recentDays = chosen.get(table.key)?.recentDays;
        const selfReferencing = table.constraints.some(c => c.type === 'f' && c.references === table.key);
        // A failed read must not end the source snapshot for the next tables
        await src.query('SAVEPOINT bbdump_table');
        try {
          // A table referencing itself: rows whose parent comes later get in on the next pass
          for (let pass = 0; pass < (selfReferencing ? 4 : 1); pass++) {
            await tgt.query('BEGIN');
            try {
              const copy = await copyMissingRows(src, tgt, table, local, {
                anonymize, recentDays, timeColumn: recentDays ? timeColumn(table) : undefined,
                onBatch: (copied, skipped) => onProgress({ stage: 'data', table: table.key, index, total: ordered.length, copied: outcome.copied + copied, skipped }),
              });
              await catchUpSequences(tgt, local);
              await tgt.query('COMMIT');
              outcome.copied += copy.copied;
              outcome.skipped = copy.skipped;
              if (copy.copied === 0 || copy.skipped === 0) break;
            } catch (error) {
              await tgt.query('ROLLBACK').catch(() => {});
              throw error;
            }
          }
          await src.query('RELEASE SAVEPOINT bbdump_table');
        } catch (error) {
          outcome.error = getErrorMessage(error);
          await src.query('ROLLBACK TO SAVEPOINT bbdump_table').catch(() => {});
        }
        onProgress({ stage: 'data', table: table.key, index: index + 1, total: ordered.length, copied: outcome.copied, skipped: outcome.skipped });
      }
    }));

    onProgress({ stage: 'done' });
    result.success = true;
    logger.info(`Sync ${sourceId} → ${targetId}: ${result.schema.applied} schema change(s), ${result.tables.reduce((n, t) => n + t.copied, 0)} row(s) copied`);
    return result;
  } catch (error) {
    logger.error(`Sync ${sourceId} → ${targetId} failed: ${getErrorMessage(error)}`);
    return { ...result, error: getErrorMessage(error) };
  }
}

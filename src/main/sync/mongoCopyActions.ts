/**
 * Copy and "Update from…" for saved MongoDB databases: the connections (SSH tunnel included),
 * the safety rules, and the copy saved as a new database.
 * - Copy: a new database on the source's server, or on the server of another saved MongoDB
 *   database. It is removed if the copy fails.
 * - Update: only a database of this computer is written (127.0.0.1 / localhost, without SSH),
 *   from a MongoDB database of the same project.
 */
import { randomUUID } from 'crypto';
import type { DatabaseConfig } from '../../types/config';
import { getConfig, saveConfig } from '../ipc/configIpc';
import { engineOf } from '../../shared/engines/features';
import { withSavedMongo } from '../engines/mongodb';
import { logger } from '../logger';
import { getErrorMessage } from '../utils';
import type { AnonymizeChoices } from './anonymizedCopy';
import type { AnonymizeKind } from './dataSync';
import { analyzeMongoSync, applyMongoSync, copyMongoDatabase } from './mongoCopy';
import type { SyncAnalysis, SyncChoices, SyncProgress, SyncResult } from './syncEngine';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

function saved(id: string): DatabaseConfig {
    const db = getConfig().databases.find(d => d.id === id);
    if (!db) throw new Error('Database not found');
    return db;
}

export interface MongoDuplicateParams {
    sourceId: string;
    /** The new database's name, on the server of `serverOf` (the source's by default) */
    name?: string;
    serverOf?: string;
    anonymize?: AnonymizeChoices;
}

type Progress = (step: string, message: string, progress: number) => void;

/** The copy's entry: the connection of `template` (password still encrypted), another database */
function saveCopy(template: DatabaseConfig, source: DatabaseConfig, name: string): DatabaseConfig {
    const config = getConfig();
    const onThisComputer = LOCAL_HOSTS.includes((template.host || '').toLowerCase()) && !template.ssh && !template.connectionString;
    const copy: DatabaseConfig = {
        ...template,
        id: randomUUID(),
        name,
        displayName: name,
        enabled: false,
        lastBackup: undefined,
        status: undefined,
        // A copy on this computer's server bbdump manages is deleted with it, like a local database
        isLocalBbdump: onThisComputer && !!template.isLocalBbdump,
        syncSourceId: source.id,
    };
    config.databases.push(copy);
    saveConfig(config);
    return copy;
}

export async function duplicateMongoDatabase(params: MongoDuplicateParams, progress: Progress): Promise<{ success: boolean; id?: string; name?: string; warnings?: string[]; error?: string }> {
    let undo: (() => Promise<void>) | null = null;
    try {
        const source = saved(params.sourceId);
        if (engineOf(source) !== 'mongodb') throw new Error('Not a MongoDB database');
        const server = saved(params.serverOf || source.id);
        if (engineOf(server) !== 'mongodb') throw new Error('The copy goes to a MongoDB server');
        const name = String(params.name ?? '').trim();
        if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) throw new Error('A database name of letters, digits, - and _ is needed');

        // The choices name collections "<database>.<collection>", as the dialog lists them
        const anonymize = new Map<string, Map<string, AnonymizeKind>>();
        const strip = (table: string) => table.slice(table.indexOf('.') + 1);
        for (const c of params.anonymize?.columns ?? []) {
            const collection = strip(c.table);
            if (!anonymize.has(collection)) anonymize.set(collection, new Map());
            anonymize.get(collection)!.set(c.column, c.kind);
        }
        const emptyCollections = new Set((params.anonymize?.emptyTables ?? []).map(strip));

        const result = await withSavedMongo(source.id, (srcClient, srcName) => withSavedMongo(server.id, async tgtClient => {
            const { databases } = await tgtClient.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
            if (databases.some(d => d.name === name)) throw new Error(`A database named ${name} already exists on this server`);
            undo = async () => {
                await withSavedMongo(server.id, async c => { await c.db(name).dropDatabase(); });
            };
            progress('creating', `Creating ${name}…`, 10);
            return copyMongoDatabase(srcClient.db(srcName), tgtClient.db(name), {
                anonymize,
                emptyCollections,
                onProgress: p => progress('copying', `${p.collection}: ${p.documents} document(s)`, 15 + Math.round((p.index / Math.max(1, p.total)) * 80)),
            });
        }));
        const copy = saveCopy(server, source, name);
        undo = null;
        progress('complete', 'Copy saved', 100);
        logger.info(`MongoDB copy of ${source.name} → ${name} on ${server.host}:${server.port}${params.anonymize ? ' (anonymized)' : ''}: ${result.documents} document(s)`);
        return { success: true, id: copy.id, name, warnings: result.warnings.length ? result.warnings : undefined };
    } catch (error) {
        logger.error(`Copy failed: ${getErrorMessage(error)}`);
        const pending = undo as (() => Promise<void>) | null;
        if (pending) await pending().catch(e => logger.warn(`The unfinished copy could not be removed: ${getErrorMessage(e)}`));
        return { success: false, error: getErrorMessage(error) };
    }
}

/** The two databases of an update, checked: same engine, the target on this computer, same project */
export function mongoPair(targetId: string, sourceId: string, writable: boolean): { target: DatabaseConfig; source: DatabaseConfig } {
    const target = saved(targetId);
    const source = saved(sourceId);
    if (target.id === source.id) throw new Error('The source and the target are the same database');
    if (engineOf(target) !== 'mongodb' || engineOf(source) !== 'mongodb') throw new Error('The source must be a database of the same engine');
    if (writable) {
        const local = LOCAL_HOSTS.includes((target.host || '').toLowerCase()) && !target.ssh && !target.connectionString;
        if (!local) throw new Error('Only a database of this computer can be updated from another one');
        const project = (getConfig().projects ?? []).find(p => p.databaseIds?.includes(target.id));
        if (!project?.databaseIds?.includes(source.id)) throw new Error('The source must be a database of the same project');
    }
    return { target, source };
}

export async function analyzeMongoPair(targetId: string, sourceId: string, writable: boolean): Promise<SyncAnalysis> {
    const { target, source } = mongoPair(targetId, sourceId, writable);
    return withSavedMongo(source.id, (srcClient, srcName) => withSavedMongo(target.id, async (tgtClient, tgtName) => ({
        source: { id: source.id, name: source.displayName || source.name, host: source.host, version: 0 },
        target: { id: target.id, name: target.displayName || target.name, host: target.host, version: 0 },
        ...(await analyzeMongoSync(srcClient.db(srcName), tgtClient.db(tgtName))),
    })));
}

export async function applyMongoPair(targetId: string, sourceId: string, choices: SyncChoices, onProgress: (p: SyncProgress) => void): Promise<Pick<SyncResult, 'schema' | 'tables'>> {
    const { target, source } = mongoPair(targetId, sourceId, true);
    return withSavedMongo(source.id, (srcClient, srcName) => withSavedMongo(target.id, (tgtClient, tgtName) =>
        applyMongoSync(srcClient.db(srcName), tgtClient.db(tgtName), choices, onProgress)));
}

/**
 * The contract a database engine implements to be driven by bbdump. A driver only provides the
 * facets it supports: no empty method stands for "not supported" — the manifest says 'no'
 * and the facet is absent (test/engines.test.mjs checks both agree).
 *
 * Facets take the id of a saved database and reach it themselves (tunnel, password). Results
 * keep the shapes the explorer already displays: another engine maps its data onto them
 * (a collection is an entity, a document a row).
 */
import type * as explorer from '../dbViewer';
import type { BackupManager } from '../backup';
import type { DatabaseConfig, MongoSettings, SqliteSettings } from '../../types/config';
import type { EngineManifest, FacetName } from '../../shared/engines/types';
import type { AggregateQuery, AggregateResult, CollectionDescription, CollectionInfo, DocumentEdit, DocumentPage, DocumentQuery } from '../../shared/engines/documents';

type FirstArg<F> = F extends (arg: infer A, ...rest: never[]) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
/** What the explorer passes besides the connection */
type Args<F> = Omit<FirstArg<F>, 'host' | 'port' | 'user' | 'password' | 'database' | 'connectionString' | 'ssl' | 'sslMode' | 'sslRootCert' | 'viaTunnel'>;

/**
 * What a dialog's connection test sends, already resolved by the handler: password decrypted
 * (or typed), SSH tunnel opened when there is one. `mongo` only for MongoDB, `sqlite` for SQLite.
 */
export type ConnectionTestInput = FirstArg<typeof explorer.testConnection> & { mongo?: MongoSettings; sqlite?: SqliteSettings };

export interface ConnectionFacet {
    /** Server version and number of entities (tables, collections) */
    test(input: ConnectionTestInput): Promise<{ version: string; tables: number }>;
}

/** Databases, namespaces (schemas) and entities (tables, views, collections) */
export interface CatalogFacet {
    listNamespaces(dbId: string): Promise<Result<typeof explorer.getDatabaseSchemas>>;
    listEntities(dbId: string, namespace?: string): Promise<Result<typeof explorer.getDatabaseTables>>;
    describeEntity(dbId: string, args: Args<typeof explorer.getTableSchema>): Promise<Result<typeof explorer.getTableSchema>>;
    entityRelations(dbId: string, args: Args<typeof explorer.getTableRelations>): Promise<Result<typeof explorer.getTableRelations>>;
    fullSchema(dbId: string, namespace?: string): Promise<Result<typeof explorer.getDatabaseFullSchema>>;
    enumValues(dbId: string, args: Args<typeof explorer.getEnumValues>): Promise<Result<typeof explorer.getEnumValues>>;
}

/** The records of an entity: read a page, look one up, change them */
export interface RecordsFacet {
    count(dbId: string, args: Args<typeof explorer.countTableRows>): Promise<Result<typeof explorer.countTableRows>>;
    page(dbId: string, args: Args<typeof explorer.getTableData>): Promise<Result<typeof explorer.getTableData>>;
    lookup(dbId: string, args: Args<typeof explorer.getFkRow>): Promise<Result<typeof explorer.getFkRow>>;
    update(dbId: string, args: Args<typeof explorer.updateTableData>): Promise<Result<typeof explorer.updateTableData>>;
    remove(dbId: string, args: Args<typeof explorer.deleteTableRow>): Promise<Result<typeof explorer.deleteTableRow>>;
    insert(dbId: string, args: Args<typeof explorer.insertTableRow>): Promise<Result<typeof explorer.insertTableRow>>;
}

/** Document databases: collections and their documents (relaxed Extended JSON) */
export interface DocumentsFacet {
    listCollections(dbId: string): Promise<CollectionInfo[]>;
    find(dbId: string, query: DocumentQuery): Promise<DocumentPage>;
    /** Fields deduced from a random sample, and the indexes */
    describe(dbId: string, collection: string): Promise<CollectionDescription>;
    /** A read-only aggregation pipeline (no $out / $merge, no server-side JavaScript) */
    aggregate(dbId: string, query: AggregateQuery): Promise<AggregateResult>;
}

/**
 * Document databases: one document at a time. Replace and delete are refused when the
 * document changed since it was read (`original`), and never touch another document.
 */
export interface DocumentWritesFacet {
    /** The JSON text of a new document; returns its _id (relaxed Extended JSON) */
    insert(dbId: string, collection: string, document: string): Promise<{ id: unknown }>;
    replace(dbId: string, edit: DocumentEdit): Promise<{ document: Record<string, unknown> }>;
    remove(dbId: string, edit: DocumentEdit): Promise<void>;
}

/** Queries written by the user or the AI, in the manifest's query language */
export interface QueryFacet {
    run(dbId: string, args: Args<typeof explorer.executeQuery>): Promise<Result<typeof explorer.executeQuery>>;
    runMutation(dbId: string, args: Args<typeof explorer.executeMutationQuery>): Promise<Result<typeof explorer.executeMutationQuery>>;
}

export interface StatsFacet {
    /** Bytes, null when unknown */
    size(dbId: string): Promise<number | null>;
}

/**
 * One dump of a database already reached (tunnel open, password decrypted). Retention, history
 * and the tunnel stay in BackupManager.backupDatabase, the same for every engine.
 */
export interface BackupFacet {
    dump(db: DatabaseConfig): ReturnType<BackupManager['executeBackup']>;
}

type RestoreArgs = Parameters<BackupManager['restoreBackup']>;

export interface RestoreFacet {
    /** The target is reached (tunnel open, password decrypted); `mongo` only for MongoDB, `sqlite` for SQLite */
    restore(backupFile: RestoreArgs[0], target: RestoreArgs[1] & { mongo?: MongoSettings; sqlite?: SqliteSettings }, options?: RestoreArgs[2]): ReturnType<BackupManager['restoreBackup']>;
}

export interface EngineDriver {
    manifest: EngineManifest;
    connection?: ConnectionFacet;
    catalog?: CatalogFacet;
    records?: RecordsFacet;
    documents?: DocumentsFacet;
    documentWrites?: DocumentWritesFacet;
    query?: QueryFacet;
    stats?: StatsFacet;
    backup?: BackupFacet;
    restore?: RestoreFacet;
}

export type Facets = { [K in FacetName]: NonNullable<EngineDriver[K]> };

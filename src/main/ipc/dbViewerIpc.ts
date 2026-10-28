import { ipcMain } from 'electron';
import { getErrorMessage } from '../utils';
import * as dbViewer from '../dbViewer';
import { logger } from '../logger';
import { credentialsForConnectionTest, toRuntimeDatabase } from '../dbSecrets';
import { tunnelled } from '../sshTunnel';
import { DatabaseConfig } from '../../types/config';
import { getConfig } from './configIpc';
import * as postgresConfig from '../postgresConfig';
import { facetFor, facetForDb } from '../engines/registry';
import { requireFeature } from '../featureFlags';
import { engineOf } from '../../shared/engines/features';
import type { AggregateQuery, DocumentEdit, DocumentQuery } from '../../shared/engines/documents';

export async function closeAllPools() {
    await dbViewer.closeAllPools();
}

export function registerDbViewerHandlers() {
    // Database Viewer Handlers
    /**
     * Database dialogs: test the connection being edited. An empty password with the id of a
     * saved database means "unchanged": the stored one is used (decrypted here, never sent back).
     */
    ipcMain.handle('test-database-connection', async (_, params: {
        id?: string; host: string; port: number; user: string; password?: string; database: string;
        connectionString?: string; sslMode?: DatabaseConfig['sslMode']; sslRootCert?: string;
        ssh?: DatabaseConfig['ssh']; engine?: string; mongo?: DatabaseConfig['mongo'];
    }) => {
        const saved = params.id ? getConfig()?.databases?.find(db => db.id === params.id) : undefined;
        // Tested by the database's engine (a saved one keeps its own), when it is turned on
        const engine = engineOf(saved ?? params);
        const connection = await facetFor(engine, 'connection.test', 'connection');
        if (params.ssh) requireFeature(engine, 'connection.ssh');
        const { password, connectionString } = credentialsForConnectionTest(
            params,
            saved ? () => toRuntimeDatabase(saved).password : null,
        );
        // A database on a server: through its SSH tunnel (opened for the test, then reused)
        const reached = await tunnelled({
            host: params.host, port: params.port, connectionString, sslMode: params.sslMode || 'disable', ssh: params.ssh,
            viaTunnel: undefined as boolean | undefined,
        });
        const sslMode = reached.sslMode || 'disable';
        try {
            return await connection.test({
                mongo: params.mongo,
                host: reached.host,
                port: reached.port,
                user: params.user,
                password,
                database: params.database,
                connectionString: reached.connectionString,
                ssl: ['require', 'verify-ca', 'verify-full'].includes(sslMode),
                sslMode,
                sslRootCert: sslMode === 'disable' ? undefined : params.sslRootCert,
                viaTunnel: reached.viaTunnel,
            });
        } catch (error) {
            logger.warn(`Connection test failed for ${params.database}@${params.host}: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('get-database-tables', async (_, params: { host: string; port: number; user: string; password: string; database: string; connectionString?: string; schema?: string }) => {
        try {
            logger.info(`Getting tables for database: ${params.database}`);
            return await dbViewer.getDatabaseTables(params);
        } catch (error) {
            logger.error(`Error getting database tables: ${error}`);
            throw error;
        }
    });

    // Document databases (MongoDB): collections, a page of documents, sampled fields and indexes
    ipcMain.handle('documents-collections', async (_, params: { db: { id: string } }) => {
        const documents = await facetForDb(params.db.id, 'explorer.documents', 'documents');
        return documents.listCollections(params.db.id);
    });

    ipcMain.handle('documents-find', async (_, params: { db: { id: string }; query: DocumentQuery }) => {
        const documents = await facetForDb(params.db.id, 'explorer.documents', 'documents');
        logger.info(`Reading documents of ${params.query?.collection} (skip ${params.query?.skip ?? 0}, limit ${params.query?.limit ?? 50})`);
        return documents.find(params.db.id, params.query);
    });

    ipcMain.handle('documents-describe', async (_, params: { db: { id: string }; collection: string }) => {
        const documents = await facetForDb(params.db.id, 'explorer.documents', 'documents');
        return documents.describe(params.db.id, params.collection);
    });

    ipcMain.handle('documents-aggregate', async (_, params: { db: { id: string }; query: AggregateQuery }) => {
        const documents = await facetForDb(params.db.id, 'explorer.aggregate', 'documents');
        logger.info(`Aggregation on ${params.query?.collection}`);
        return documents.aggregate(params.db.id, params.query);
    });

    // A dashboard block of a MongoDB database (read only, like its SQL blocks)
    ipcMain.handle('dashboards-aggregate', async (_, params: { db: { id: string }; query: AggregateQuery }) => {
        const documents = await facetForDb(params.db.id, 'dashboards', 'documents');
        return documents.aggregate(params.db.id, { collection: params.query?.collection, pipeline: params.query?.pipeline, limit: params.query?.limit });
    });

    // One document at a time, refused when it changed since the explorer read it
    ipcMain.handle('documents-insert', async (_, params: { db: { id: string }; collection: string; document: string }) => {
        const writes = await facetForDb(params.db.id, 'explorer.editDocuments', 'documentWrites');
        return writes.insert(params.db.id, params.collection, params.document);
    });

    ipcMain.handle('documents-replace', async (_, params: { db: { id: string }; edit: DocumentEdit }) => {
        const writes = await facetForDb(params.db.id, 'explorer.editDocuments', 'documentWrites');
        return writes.replace(params.db.id, params.edit);
    });

    ipcMain.handle('documents-delete', async (_, params: { db: { id: string }; edit: DocumentEdit }) => {
        const writes = await facetForDb(params.db.id, 'explorer.editDocuments', 'documentWrites');
        await writes.remove(params.db.id, params.edit);
    });

    ipcMain.handle('get-db-schemas', async (_, params: { db: { id: string } }) => {
        try {
            logger.info(`Getting schemas for database: ${params.db.id}`);
            const catalog = await facetForDb(params.db.id, 'explorer.browse', 'catalog');
            return await catalog.listNamespaces(params.db.id);
        } catch (error) {
            logger.error(`Error getting database schemas: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    // Alias for compatibility with frontend usage via store.viewerDb
    ipcMain.handle('get-db-tables', async (_, params: { db: { id: string }, schema?: string }) => {
        try {
            logger.info(`Getting tables for database: ${params.db.id} (schema: ${params.schema || dbViewer.DEFAULT_SCHEMA})`);
            const catalog = await facetForDb(params.db.id, 'explorer.browse', 'catalog');
            return await catalog.listEntities(params.db.id, params.schema);
        } catch (error) {
            logger.error(`Error getting database tables: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    ipcMain.handle('get-db-full-schema', async (_, params: { db: { id: string }, schema?: string }) => {
        try {
            logger.info(`Getting full schema for database: ${params.db.id}${params.schema ? ` (schema: ${params.schema})` : ''}`);
            const catalog = await facetForDb(params.db.id, 'explorer.diagram', 'catalog');
            return await catalog.fullSchema(params.db.id, params.schema);
        } catch (error) {
            logger.error(`Error getting database full schema: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    ipcMain.handle('count-table-rows', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Counting rows of table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const records = await facetForDb(params.db.id, 'explorer.browse', 'records');
            return await records.count(params.db.id, { schema: params.schema, table: params.table });
        } catch (error) {
            logger.error(`Error counting table rows: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-schema', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Getting schema for table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const catalog = await facetForDb(params.db.id, 'explorer.browse', 'catalog');
            return await catalog.describeEntity(params.db.id, { schema: params.schema, table: params.table });
        } catch (error) {
            logger.error(`Error getting table schema: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-relations', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Getting relations for table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const catalog = await facetForDb(params.db.id, 'explorer.browse', 'catalog');
            return await catalog.entityRelations(params.db.id, { schema: params.schema, table: params.table });
        } catch (error) {
            logger.error(`Error getting table relations: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-data', async (_, params: { db: { id: string }, schema?: string, table: string, limit?: number, page?: number, pageSize?: number, search?: string, sortBy?: string, sortOrder?: 'asc' | 'desc' }) => {
        try {
            const limit = params.limit || params.pageSize || 50;
            const offset = params.page ? (params.page - 1) * limit : 0;

            logger.info(`Getting data for table: ${params.table} (limit: ${limit}, offset: ${offset}, search: ${params.search || ''}, sort: ${params.sortBy || ''} ${params.sortOrder || ''})`);
            const records = await facetForDb(params.db.id, 'explorer.browse', 'records');
            return await records.page(params.db.id, {
                schema: params.schema,
                table: params.table,
                limit,
                offset,
                search: params.search,
                sortBy: params.sortBy,
                sortOrder: params.sortOrder
            });
        } catch (error) {
            logger.error(`Error getting table data: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-fk-row', async (_, params: {
        db: { id: string };
        schema?: string;
        table: string;
        column: string;
        value: unknown;
    }) => {
        try {
            const records = await facetForDb(params.db.id, 'explorer.browse', 'records');
            return await records.lookup(params.db.id, {
                schema: params.schema,
                table: params.table,
                column: params.column,
                value: params.value
            });
        } catch (error) {
            logger.error(`Error getting FK row: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('update-table-data', async (_, params: {
        db: { id: string };
        schema?: string;
        table: string;
        changes: Parameters<typeof dbViewer.updateTableData>[0]['changes'];
    }) => {
        try {
            logger.info(`Updating table data: ${params.table} (${params.changes.length} changes)`);
            const records = await facetForDb(params.db.id, 'explorer.edit', 'records');
            return await records.update(params.db.id, {
                schema: params.schema,
                table: params.table,
                changes: params.changes
            });
        } catch (error) {
            logger.error(`Error updating table data: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('delete-table-row', async (_, params: {
        db: { id: string };
        schema?: string;
        table: string;
        rowId: unknown;
        primaryKeyColumn: string;
    }) => {
        try {
            logger.info(`Deleting row from table: ${params.table}`);
            const records = await facetForDb(params.db.id, 'explorer.edit', 'records');
            return await records.remove(params.db.id, {
                schema: params.schema,
                table: params.table,
                rowId: params.rowId,
                primaryKeyColumn: params.primaryKeyColumn
            });
        } catch (error) {
            logger.error(`Error deleting row: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('insert-table-row', async (_, params: {
        db: { id: string };
        schema?: string;
        table: string;
        rowData: Record<string, unknown>;
    }) => {
        try {
            logger.info(`Inserting row into table: ${params.table}`);
            const records = await facetForDb(params.db.id, 'explorer.edit', 'records');
            return await records.insert(params.db.id, {
                schema: params.schema,
                table: params.table,
                rowData: params.rowData
            });
        } catch (error) {
            logger.error(`Error inserting row: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-enum-values', async (_, params: {
        db: { id: string };
        typeName: string;
        typeSchema?: string;
    }) => {
        try {
            logger.info(`Getting enum values for type: ${params.typeName}`);
            const catalog = await facetForDb(params.db.id, 'explorer.browse', 'catalog');
            return await catalog.enumValues(params.db.id, {
                typeName: params.typeName,
                typeSchema: params.typeSchema
            });
        } catch (error) {
            logger.error(`Error getting enum values: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('execute-sql', async (_, params: {
        db: { id: string };
        sql: string;
        maxRows?: number;
        timeoutMs?: number;
        params?: unknown[];
    }) => {
        try {
            logger.info(`Executing SQL query on ${params.db.id} (maxRows: ${params.maxRows || 500})`);
            const query = await facetForDb(params.db.id, 'explorer.query', 'query');
            // Bound values (dashboard filters): plain values only, never SQL
            const values = Array.isArray(params.params)
                ? params.params.slice(0, 50).map(v => (v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v as string | number | boolean | null : null))
                : undefined;
            return await query.run(params.db.id, {
                sql: params.sql,
                maxRows: params.maxRows,
                timeoutMs: params.timeoutMs,
                values,
            });
        } catch (error) {
            logger.error(`Error executing SQL query: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    ipcMain.handle('execute-sql-mutation', async (_, params: {
        db: { id: string };
        sql: string;
        maxRows?: number;
        timeoutMs?: number;
    }) => {
        try {
            const config = getConfig();
            if (!config.allowSqlMutations) {
                throw new Error('SQL mutations are disabled in settings');
            }
            logger.info(`Executing SQL mutation on ${params.db.id}`);
            const query = await facetForDb(params.db.id, 'explorer.query', 'query');
            return await query.runMutation(params.db.id, {
                sql: params.sql,
                maxRows: params.maxRows,
                timeoutMs: params.timeoutMs
            });
        } catch (error) {
            logger.error(`Error executing SQL mutation: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    // PostgreSQL Configuration Handlers (kept here as they are related to DB management/viewing tools)
    ipcMain.handle('get-postgres-config', async (_, port: number = 5432) => {
        try {
            return await postgresConfig.getPostgresConfigInfo(port);
        } catch (error) {
            logger.error(`Error getting PostgreSQL config: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('kill-postgres-connection', async (_, pid: number, port: number = 5432) => {
        try {
            return await postgresConfig.killConnection(pid, port);
        } catch (error) {
            logger.error(`Error killing PostgreSQL connection: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('disconnect-postgres-database', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.disconnectDatabase(dbName, port);
        } catch (error) {
            logger.error(`Error disconnecting PostgreSQL database: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('drop-postgres-database', async (_, dbName: string, port: number = 5432, forceDisconnect: boolean = true) => {
        try {
            return await postgresConfig.dropDatabase(dbName, port, forceDisconnect);
        } catch (error) {
            logger.error(`Error dropping PostgreSQL database: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('test-postgres-connection', async (_, dbName: string, port: number = 5432, password?: string) => {
        try {
            return await postgresConfig.testDatabaseConnection(dbName, port, password);
        } catch (error) {
            logger.error(`Error testing PostgreSQL connection: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('get-postgres-extensions', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.listPostgresExtensions(dbName, port);
        } catch (error) {
            logger.error(`Error getting PostgreSQL extensions: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('install-postgres-extension', async (_, dbName: string, extensionName: string, port: number = 5432) => {
        try {
            return await postgresConfig.installExtension(dbName, extensionName, port);
        } catch (error) {
            logger.error(`Error installing PostgreSQL extension: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('uninstall-postgres-extension', async (_, dbName: string, extensionName: string, port: number = 5432) => {
        try {
            return await postgresConfig.uninstallExtension(dbName, extensionName, port);
        } catch (error) {
            logger.error(`Error uninstalling PostgreSQL extension: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    // Update a local database from another one (schema additions, missing rows)
    ipcMain.handle('sync-analyze', async (_, targetId: string, sourceId: string) => {
        const { analyzeSync } = await import('../sync/syncEngine');
        try {
            return { success: true, analysis: await analyzeSync(String(targetId), String(sourceId)) };
        } catch (error) {
            logger.error(`Sync analysis failed: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('sync-apply', async (event, targetId: string, sourceId: string, choices: unknown) => {
        const { applySync } = await import('../sync/syncEngine');
        const c = (choices ?? {}) as Record<string, unknown>;
        const safeChoices = {
            changes: Array.isArray(c.changes) ? c.changes.map(String) : [],
            tables: Array.isArray(c.tables) ? (c.tables as Array<{ key: unknown; recentDays?: unknown }>).map(t => ({
                key: String(t.key),
                recentDays: typeof t.recentDays === 'number' && t.recentDays > 0 ? t.recentDays : undefined,
            })) : [],
            anonymize: Array.isArray(c.anonymize) ? (c.anonymize as Array<{ table: unknown; column: unknown; kind: unknown }>)
                .filter(a => ['email', 'phone', 'name', 'address', 'ip', 'secret'].includes(String(a.kind)))
                .map(a => ({ table: String(a.table), column: String(a.column), kind: String(a.kind) as 'email' })) : [],
            backup: c.backup !== false,
        };
        return applySync(String(targetId), String(sourceId), safeChoices, (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send('sync-progress', progress);
        });
    });

    // Journal of the changes made by AI clients (MCP), and their undo
    ipcMain.handle('ai-journal-list', async (_, databaseId?: string) => {
        const { listJournal } = await import('../aiJournal');
        return listJournal(typeof databaseId === 'string' ? databaseId : undefined);
    });

    ipcMain.handle('ai-journal-preview', async (_, id: string) => {
        const { previewUndo } = await import('../aiJournal');
        try {
            return { success: true, ...(await previewUndo(String(id))) };
        } catch (error) {
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('ai-journal-undo', async (_, id: string) => {
        const { undoChange } = await import('../aiJournal');
        return undoChange(String(id));
    });

    ipcMain.handle('get-extension-catalog', async (_, dbName: string, port: number = 5432) => {
        const { EXTENSION_CATALOG, extensionPackage, packageInstallCommand } = await import('../extensionCatalog');
        try {
            const server = await postgresConfig.getExtensionServerInfo(dbName, port);
            const manager = server.packageManager;
            // Package and command for THIS server (Homebrew formula, postgresql-17-x, x_17…)
            const entries = EXTENSION_CATALOG.map(entry => ({
                ...entry,
                package: manager ? extensionPackage(entry, manager, server.major) : null,
                command: manager ? packageInstallCommand(entry, manager, server.major) : null,
            }));
            return { entries, server };
        } catch (error) {
            logger.warn(`Extension server info unavailable: ${getErrorMessage(error)}`);
            return { entries: EXTENSION_CATALOG, server: null };
        }
    });

    ipcMain.handle('install-extension-package', async (_, dbName: string, extensionName: string, port: number = 5432) => {
        try {
            return await postgresConfig.installExtensionPackage(dbName, extensionName, port);
        } catch (error) {
            logger.error(`Error installing extension package: ${getErrorMessage(error)}`);
            return { success: false, error: getErrorMessage(error) };
        }
    });

    ipcMain.handle('get-postgres-performance-stats', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.getPostgresPerformanceStats(dbName, port);
        } catch (error) {
            logger.error(`Error getting PostgreSQL performance stats: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('reset-postgres-performance-stats', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.resetPostgresPerformanceStats(dbName, port);
        } catch (error) {
            logger.error(`Error resetting PostgreSQL performance stats: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('restart-postgres', async (_) => {
        try {
            return await postgresConfig.restartPostgres();
        } catch (error) {
            logger.error(`Error restarting PostgreSQL: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('check-postgres-config', async (_, extensionName: string) => {
        try {
            return await postgresConfig.checkPostgresConfig(extensionName);
        } catch (error) {
            logger.error(`Error checking PostgreSQL config: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('fix-postgres-config', async (_, extensionName: string) => {
        try {
            return await postgresConfig.fixPostgresConfig(extensionName);
        } catch (error) {
            logger.error(`Error fixing PostgreSQL config: ${getErrorMessage(error)}`);
            throw error;
        }
    });

    ipcMain.handle('get-database-size', async (_, dbId: string): Promise<number | null> => {
        try {
            const stats = await facetForDb(dbId, 'stats.size', 'stats');
            return await stats.size(dbId);
        } catch (error) {
            logger.error(`Error getting database size for ${dbId}: ${getErrorMessage(error)}`);
            return null;
        }
    });
}

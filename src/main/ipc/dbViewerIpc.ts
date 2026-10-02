import { ipcMain } from 'electron';
import { getErrorMessage } from '../utils';
import * as dbViewer from '../dbViewer';
import { logger } from '../logger';
import { credentialsForConnectionTest, toRuntimeDatabase } from '../dbSecrets';
import { connectionParamsFor } from '../savedConnection';
import { tunnelled } from '../sshTunnel';
import { DatabaseConfig } from '../../types/config';
import { getConfig } from './configIpc';
import * as postgresConfig from '../postgresConfig';

export async function closeAllPools() {
    await dbViewer.closeAllPools();
}

// Connection parameters of a saved database (lookup by id, password decrypted)
const getDbConfig = (dbId: string) => connectionParamsFor(dbId);

export function registerDbViewerHandlers() {
    // Database Viewer Handlers
    /**
     * Database dialogs: test the connection being edited. An empty password with the id of a
     * saved database means "unchanged": the stored one is used (decrypted here, never sent back).
     */
    ipcMain.handle('test-database-connection', async (_, params: {
        id?: string; host: string; port: number; user: string; password?: string; database: string;
        connectionString?: string; sslMode?: DatabaseConfig['sslMode']; sslRootCert?: string;
        ssh?: DatabaseConfig['ssh'];
    }) => {
        const saved = params.id ? getConfig()?.databases?.find(db => db.id === params.id) : undefined;
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
            return await dbViewer.testConnection({
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

    ipcMain.handle('get-db-schemas', async (_, params: { db: { id: string } }) => {
        try {
            logger.info(`Getting schemas for database: ${params.db.id}`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getDatabaseSchemas(dbConfig);
        } catch (error) {
            logger.error(`Error getting database schemas: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    // Alias for compatibility with frontend usage via store.viewerDb
    ipcMain.handle('get-db-tables', async (_, params: { db: { id: string }, schema?: string }) => {
        try {
            logger.info(`Getting tables for database: ${params.db.id} (schema: ${params.schema || dbViewer.DEFAULT_SCHEMA})`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getDatabaseTables({ ...dbConfig, schema: params.schema });
        } catch (error) {
            logger.error(`Error getting database tables: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    ipcMain.handle('get-db-full-schema', async (_, params: { db: { id: string }, schema?: string }) => {
        try {
            logger.info(`Getting full schema for database: ${params.db.id}${params.schema ? ` (schema: ${params.schema})` : ''}`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getDatabaseFullSchema({ ...dbConfig, schema: params.schema });
        } catch (error) {
            logger.error(`Error getting database full schema: ${getErrorMessage(error) || error}`);
            throw error;
        }
    });

    ipcMain.handle('count-table-rows', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Counting rows of table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.countTableRows({ ...dbConfig, schema: params.schema, table: params.table });
        } catch (error) {
            logger.error(`Error counting table rows: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-schema', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Getting schema for table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getTableSchema({ ...dbConfig, schema: params.schema, table: params.table });
        } catch (error) {
            logger.error(`Error getting table schema: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-relations', async (_, params: { db: { id: string }, schema?: string, table: string }) => {
        try {
            logger.info(`Getting relations for table: ${params.schema || dbViewer.DEFAULT_SCHEMA}.${params.table}`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getTableRelations({ ...dbConfig, schema: params.schema, table: params.table });
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getTableData({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getFkRow({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.updateTableData({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.deleteTableRow({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.insertTableRow({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.getEnumValues({
                ...dbConfig,
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
    }) => {
        try {
            logger.info(`Executing SQL query on ${params.db.id} (maxRows: ${params.maxRows || 500})`);
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.executeQuery({
                ...dbConfig,
                sql: params.sql,
                maxRows: params.maxRows,
                timeoutMs: params.timeoutMs
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
            const dbConfig = await getDbConfig(params.db.id);
            return await dbViewer.executeMutationQuery({
                ...dbConfig,
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
            const dbConfig = await getDbConfig(dbId);
            const result = await dbViewer.executeQuery({
                ...dbConfig,
                sql: 'SELECT pg_database_size(current_database()) as size',
                maxRows: 1,
                timeoutMs: 5000
            });
            if (result.rows && result.rows.length > 0) {
                return parseInt(result.rows[0].size, 10);
            }
            return null;
        } catch (error) {
            logger.error(`Error getting database size for ${dbId}: ${getErrorMessage(error)}`);
            return null;
        }
    });
}

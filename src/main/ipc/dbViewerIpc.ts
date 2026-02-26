import { ipcMain } from 'electron';
import * as dbViewer from '../dbViewer';
import { logger } from '../logger';
import { encryptionManager } from '../encryption';
import { getConfig } from './configIpc';
import * as postgresConfig from '../postgresConfig';

export async function closeAllPools() {
    await dbViewer.closeAllPools();
}

// Helper to get db config from the shared config state (lookup by id)
const getDbConfig = (dbId: string) => {
    const config = getConfig();
    if (!config || !config.databases || !Array.isArray(config.databases)) {
        throw new Error(`Configuration not loaded or databases array is missing`);
    }

    const db = config.databases.find(d => d.id === dbId);
    if (!db) {
        throw new Error(`Database with id "${dbId}" not found in configuration`);
    }

    let password = db.password;
    try {
        if (db.encrypted) {
            password = encryptionManager.decrypt(db.password);
        }
    } catch (error) {
        logger.error(`Failed to decrypt password for ${db.name}: ${error}`);
        throw new Error(`Failed to decrypt password for ${db.name}`);
    }

    return {
        host: db.host,
        port: db.port,
        user: db.user,
        password: password,
        database: db.name,
        connectionString: db.connectionString,
        ssl: db.ssl
    };
};

export function registerDbViewerHandlers() {
    // Database Viewer Handlers
    ipcMain.handle('get-database-tables', async (_, params: { host: string; port: number; user: string; password: string; database: string; connectionString?: string }) => {
        try {
            logger.info(`Getting tables for database: ${params.database}`);
            return await dbViewer.getDatabaseTables(params);
        } catch (error) {
            logger.error(`Error getting database tables: ${error}`);
            throw error;
        }
    });

    // Alias for compatibility with frontend usage via store.viewerDb
    ipcMain.handle('get-db-tables', async (_, params: { db: { id: string } }) => {
        try {
            logger.info(`Getting tables for database: ${params.db.id}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getDatabaseTables(dbConfig);
        } catch (error: any) {
            logger.error(`Error getting database tables: ${error.message || error}`);
            throw error;
        }
    });

    ipcMain.handle('get-db-full-schema', async (_, params: { db: { id: string } }) => {
        try {
            logger.info(`Getting full schema for database: ${params.db.id}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getDatabaseFullSchema(dbConfig);
        } catch (error: any) {
            logger.error(`Error getting database full schema: ${error.message || error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-schema', async (_, params: { db: { id: string }, table: string }) => {
        try {
            logger.info(`Getting schema for table: ${params.table}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getTableSchema({ ...dbConfig, table: params.table });
        } catch (error) {
            logger.error(`Error getting table schema: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-relations', async (_, params: { db: { id: string }, table: string }) => {
        try {
            logger.info(`Getting relations for table: ${params.table}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getTableRelations({ ...dbConfig, table: params.table });
        } catch (error) {
            logger.error(`Error getting table relations: ${error}`);
            throw error;
        }
    });

    ipcMain.handle('get-table-data', async (_, params: { db: { id: string }, table: string, limit?: number, page?: number, pageSize?: number, search?: string, sortBy?: string, sortOrder?: 'asc' | 'desc' }) => {
        try {
            const limit = params.limit || params.pageSize || 50;
            const offset = params.page ? (params.page - 1) * limit : 0;

            logger.info(`Getting data for table: ${params.table} (limit: ${limit}, offset: ${offset}, search: ${params.search || ''}, sort: ${params.sortBy || ''} ${params.sortOrder || ''})`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getTableData({
                ...dbConfig,
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
        table: string;
        column: string;
        value: any;
    }) => {
        try {
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getFkRow({
                ...dbConfig,
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
        table: string;
        changes: Array<any>;
    }) => {
        try {
            logger.info(`Updating table data: ${params.table} (${params.changes.length} changes)`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.updateTableData({
                ...dbConfig,
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
        table: string;
        rowId: any;
        primaryKeyColumn: string;
    }) => {
        try {
            logger.info(`Deleting row from table: ${params.table}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.deleteTableRow({
                ...dbConfig,
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
        table: string;
        rowData: any;
    }) => {
        try {
            logger.info(`Inserting row into table: ${params.table}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.insertTableRow({
                ...dbConfig,
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
    }) => {
        try {
            logger.info(`Getting enum values for type: ${params.typeName}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.getEnumValues({
                ...dbConfig,
                typeName: params.typeName
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
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.executeQuery({
                ...dbConfig,
                sql: params.sql,
                maxRows: params.maxRows,
                timeoutMs: params.timeoutMs
            });
        } catch (error: any) {
            logger.error(`Error executing SQL query: ${error.message || error}`);
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
            logger.info(`Executing SQL mutation on ${params.db.id}`);
            const dbConfig = getDbConfig(params.db.id);
            return await dbViewer.executeMutationQuery({
                ...dbConfig,
                sql: params.sql,
                maxRows: params.maxRows,
                timeoutMs: params.timeoutMs
            });
        } catch (error: any) {
            logger.error(`Error executing SQL mutation: ${error.message || error}`);
            throw error;
        }
    });

    // PostgreSQL Configuration Handlers (kept here as they are related to DB management/viewing tools)
    ipcMain.handle('get-postgres-config', async (_, port: number = 5432) => {
        try {
            return await postgresConfig.getPostgresConfigInfo(port);
        } catch (error: any) {
            logger.error(`Error getting PostgreSQL config: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('kill-postgres-connection', async (_, pid: number, port: number = 5432) => {
        try {
            return await postgresConfig.killConnection(pid, port);
        } catch (error: any) {
            logger.error(`Error killing PostgreSQL connection: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('disconnect-postgres-database', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.disconnectDatabase(dbName, port);
        } catch (error: any) {
            logger.error(`Error disconnecting PostgreSQL database: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('drop-postgres-database', async (_, dbName: string, port: number = 5432, forceDisconnect: boolean = true) => {
        try {
            return await postgresConfig.dropDatabase(dbName, port, forceDisconnect);
        } catch (error: any) {
            logger.error(`Error dropping PostgreSQL database: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('test-postgres-connection', async (_, dbName: string, port: number = 5432, password?: string) => {
        try {
            return await postgresConfig.testDatabaseConnection(dbName, port, password);
        } catch (error: any) {
            logger.error(`Error testing PostgreSQL connection: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('get-postgres-extensions', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.listPostgresExtensions(dbName, port);
        } catch (error: any) {
            logger.error(`Error getting PostgreSQL extensions: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('install-postgres-extension', async (_, dbName: string, extensionName: string, port: number = 5432) => {
        try {
            return await postgresConfig.installExtension(dbName, extensionName, port);
        } catch (error: any) {
            logger.error(`Error installing PostgreSQL extension: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('uninstall-postgres-extension', async (_, dbName: string, extensionName: string, port: number = 5432) => {
        try {
            return await postgresConfig.uninstallExtension(dbName, extensionName, port);
        } catch (error: any) {
            logger.error(`Error uninstalling PostgreSQL extension: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('get-postgres-performance-stats', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.getPostgresPerformanceStats(dbName, port);
        } catch (error: any) {
            logger.error(`Error getting PostgreSQL performance stats: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('reset-postgres-performance-stats', async (_, dbName: string, port: number = 5432) => {
        try {
            return await postgresConfig.resetPostgresPerformanceStats(dbName, port);
        } catch (error: any) {
            logger.error(`Error resetting PostgreSQL performance stats: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('restart-postgres', async (_) => {
        try {
            return await postgresConfig.restartPostgres();
        } catch (error: any) {
            logger.error(`Error restarting PostgreSQL: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('check-postgres-config', async (_, extensionName: string) => {
        try {
            return await postgresConfig.checkPostgresConfig(extensionName);
        } catch (error: any) {
            logger.error(`Error checking PostgreSQL config: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('fix-postgres-config', async (_, extensionName: string) => {
        try {
            return await postgresConfig.fixPostgresConfig(extensionName);
        } catch (error: any) {
            logger.error(`Error fixing PostgreSQL config: ${error.message}`);
            throw error;
        }
    });

    ipcMain.handle('get-database-size', async (_, dbId: string): Promise<number | null> => {
        try {
            const dbConfig = getDbConfig(dbId);
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
        } catch (error: any) {
            logger.error(`Error getting database size for ${dbId}: ${error.message}`);
            return null;
        }
    });
}

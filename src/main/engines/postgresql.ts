/**
 * PostgreSQL driver: the code bbdump always had (explorer, pg_dump, pg_restore), behind the
 * engine contract. Nothing is rewritten here, only routed.
 */
import * as explorer from '../dbViewer';
import { backupManager } from '../backup';
import { connectionParamsFor } from '../savedConnection';
import { POSTGRESQL } from '../../shared/engines/manifests';
import type { EngineDriver } from './driver';

const reach = connectionParamsFor;

export const postgresqlDriver: EngineDriver = {
    manifest: POSTGRESQL,

    connection: {
        test: input => explorer.testConnection(input),
    },

    catalog: {
        listNamespaces: async dbId => explorer.getDatabaseSchemas(await reach(dbId)),
        listEntities: async (dbId, namespace) => explorer.getDatabaseTables({ ...await reach(dbId), schema: namespace }),
        describeEntity: async (dbId, args) => explorer.getTableSchema({ ...await reach(dbId), ...args }),
        entityRelations: async (dbId, args) => explorer.getTableRelations({ ...await reach(dbId), ...args }),
        fullSchema: async (dbId, namespace) => explorer.getDatabaseFullSchema({ ...await reach(dbId), schema: namespace }),
        enumValues: async (dbId, args) => explorer.getEnumValues({ ...await reach(dbId), ...args }),
    },

    records: {
        count: async (dbId, args) => explorer.countTableRows({ ...await reach(dbId), ...args }),
        page: async (dbId, args) => explorer.getTableData({ ...await reach(dbId), ...args }),
        lookup: async (dbId, args) => explorer.getFkRow({ ...await reach(dbId), ...args }),
        update: async (dbId, args) => explorer.updateTableData({ ...await reach(dbId), ...args }),
        remove: async (dbId, args) => explorer.deleteTableRow({ ...await reach(dbId), ...args }),
        insert: async (dbId, args) => explorer.insertTableRow({ ...await reach(dbId), ...args }),
    },

    query: {
        run: async (dbId, args) => explorer.executeQuery({ ...await reach(dbId), ...args }),
        runMutation: async (dbId, args) => explorer.executeMutationQuery({ ...await reach(dbId), ...args }),
    },

    stats: {
        size: async dbId => {
            const result = await explorer.executeQuery({
                ...await reach(dbId),
                sql: 'SELECT pg_database_size(current_database()) as size',
                maxRows: 1,
                timeoutMs: 5000,
            });
            return result.rows && result.rows.length > 0 ? parseInt(result.rows[0].size, 10) : null;
        },
    },

    backup: {
        dump: db => backupManager.executeBackup(db),
    },

    restore: {
        restore: (backupFile, target, options) => backupManager.restoreBackup(backupFile, target, options),
    },
};

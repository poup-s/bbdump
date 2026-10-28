/**
 * What each engine supports, as data the renderer can read too. A feature set to 'yes' or
 * 'beta' must have the driver facet it needs (checked by test/engines.test.mjs).
 */
import type { EngineManifest, Support } from './types';
import type { FeatureKey } from './features';

const POSTGRESQL_FEATURES = {
    'connection.test': 'yes',
    'connection.ssh': 'yes',
    'connection.tls': 'yes',
    'backup.run': 'yes',
    'backup.schedule': 'yes',
    'backup.verify': 'yes',
    'backup.encrypt': 'yes',
    'restore.replace': 'yes',
    'restore.toOther': 'yes',
    'explorer.browse': 'yes',
    // Tables, not documents
    'explorer.documents': 'no',
    'explorer.editDocuments': 'no',
    'explorer.aggregate': 'no',
    'explorer.edit': 'yes',
    'explorer.query': 'yes',
    'explorer.diagram': 'yes',
    'stats.size': 'yes',
    'database.duplicate': 'yes',
    'sync.fromSource': 'yes',
    'sync.anonymize': 'yes',
    'mask.fields': 'yes',
    'chat': 'yes',
    'dashboards': 'yes',
    'mcp.read': 'yes',
    'mcp.write': 'yes',
    'mcp.undo': 'yes',
    'proxy.tcp': 'yes',
    'local.server': 'yes',
} as const satisfies Record<FeatureKey, Support>;

export const POSTGRESQL: EngineManifest = {
    id: 'postgresql',
    label: 'PostgreSQL',
    defaultPort: 5432,
    uriSchemes: ['postgresql', 'postgres'],
    queryLanguage: 'sql',
    features: POSTGRESQL_FEATURES,
};

/**
 * MongoDB (stable since 1.5, always on): connection, backups and restore (mongodump /
 * mongorestore), the explorer, the AI (MCP, chat, dashboards). Everything not listed is 'no'.
 */
const MONGODB_FEATURES = {
    'connection.test': 'yes',
    'connection.tls': 'yes',
    // Through the user's ssh: one server, reached directly (no replica set discovery)
    'connection.ssh': 'yes',
    'stats.size': 'yes',
    'backup.run': 'yes',
    'backup.schedule': 'yes',
    'backup.verify': 'yes',
    'backup.encrypt': 'yes',
    // Replaces the collections the backup holds (no transaction across them: "back up first" stays on)
    'restore.replace': 'yes',
    // Collections, documents (filter, sort, pages), sampled schema, indexes
    'explorer.documents': 'yes',
    // One document at a time, refused when it changed since it was read
    'explorer.editDocuments': 'yes',
    // Read-only pipelines ($out / $merge and server-side JavaScript refused)
    'explorer.aggregate': 'yes',
    // AI assistants (MCP): collections, find, count, aggregate; writes confirmed in bbdump, with undo
    'mcp.read': 'yes',
    'mcp.write': 'yes',
    'mcp.undo': 'yes',
    // Personal fields hidden from the AI, chosen by path (customer.email, items[].sku)
    'mask.fields': 'yes',
    // The database chat (read only), through the mongo_* tools
    'chat': 'yes',
    // Dashboards made with the AI: each block is a read-only aggregation
    'dashboards': 'yes',
} as const satisfies Partial<Record<FeatureKey, Support>>;

export const MONGODB: EngineManifest = {
    id: 'mongodb',
    label: 'MongoDB',
    defaultPort: 27017,
    uriSchemes: ['mongodb', 'mongodb+srv'],
    features: MONGODB_FEATURES,
};

/**
 * MySQL and MariaDB: one driver (mysql2), two products. Tables like PostgreSQL, so the table
 * explorer, the SQL editor, dashboards and the AI's sql_* tools; a backup is the server's own
 * dump tool (mysqldump or mariadb-dump) written compressed. One database = one namespace.
 */
const MYSQL_FEATURES = {
    'connection.test': 'yes',
    'connection.tls': 'yes',
    // Through the user's ssh, like PostgreSQL: the dump tools and the AI's tools use the same tunnel
    'connection.ssh': 'yes',
    'stats.size': 'yes',
    'backup.run': 'yes',
    'backup.schedule': 'yes',
    'backup.verify': 'yes',
    'backup.encrypt': 'yes',
    // The tables of the backup replace those of the target (no transaction around DDL: "back up first" stays on)
    'restore.replace': 'yes',
    'explorer.browse': 'yes',
    'explorer.edit': 'yes',
    'explorer.query': 'yes',
    'explorer.diagram': 'yes',
    'mcp.read': 'yes',
    'mcp.write': 'yes',
    'mcp.undo': 'yes',
    'mask.fields': 'yes',
    'chat': 'yes',
    'dashboards': 'yes',
} as const satisfies Partial<Record<FeatureKey, Support>>;

export const MYSQL: EngineManifest = {
    id: 'mysql',
    label: 'MySQL',
    defaultPort: 3306,
    uriSchemes: ['mysql'],
    queryLanguage: 'sql',
    features: MYSQL_FEATURES,
};

export const MARIADB: EngineManifest = {
    id: 'mariadb',
    label: 'MariaDB',
    defaultPort: 3306,
    uriSchemes: ['mariadb'],
    queryLanguage: 'sql',
    features: MYSQL_FEATURES,
};

/**
 * SQLite: a file on this computer, read and written in-process (node:sqlite, no tool to
 * install). Backups use SQLite's online backup (consistent while an app writes to it), and a
 * restore writes into the file the same way. No server: no SSH, TLS or proxy.
 */
const SQLITE_FEATURES = {
    'connection.test': 'yes',
    'stats.size': 'yes',
    'backup.run': 'yes',
    'backup.schedule': 'yes',
    'backup.verify': 'yes',
    'backup.encrypt': 'yes',
    'restore.replace': 'yes',
    'explorer.browse': 'yes',
    'explorer.edit': 'yes',
    'explorer.query': 'yes',
    'explorer.diagram': 'yes',
    'mcp.read': 'yes',
    'mcp.write': 'yes',
    'mcp.undo': 'yes',
    'mask.fields': 'yes',
    'chat': 'yes',
    'dashboards': 'yes',
} as const satisfies Partial<Record<FeatureKey, Support>>;

export const SQLITE: EngineManifest = {
    id: 'sqlite',
    label: 'SQLite',
    uriSchemes: [],
    queryLanguage: 'sql',
    features: SQLITE_FEATURES,
};

export const MANIFESTS: readonly EngineManifest[] = [POSTGRESQL, MONGODB, MYSQL, MARIADB, SQLITE];

/** Engines whose databases are tables queried in SQL (the table explorer, SQL dashboards) */
export const SQL_ENGINES: readonly string[] = ['postgresql', 'mysql', 'mariadb', 'sqlite'];

/** MySQL-family engines (one driver, one dialect) */
export const isMysqlFamily = (engine: string | undefined) => engine === 'mysql' || engine === 'mariadb';

/** Undefined for an engine this version does not know (a database saved by a newer bbdump) */
export function manifestFor(engine: string): EngineManifest | undefined {
    return MANIFESTS.find(manifest => manifest.id === engine);
}

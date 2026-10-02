export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export interface Database {
    id: string;
    name: string;
    displayName?: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    encrypted?: boolean;
    encryptBackups?: boolean;
    retentionCount?: number; // Keep only the N most recent backups
    verifyBackups?: boolean; // Read back each dump with pg_restore (default true)
    cron?: string;
    enabled?: boolean;
    output: string;
    connectionString?: string;
    ssl?: boolean; // Legacy, kept in sync with sslMode
    sslMode?: SslMode;
    sslRootCert?: string;
    lastBackup?: string;
    _originalPassword?: string; // For UI logic
    isLocalBbdump?: boolean; // True if created by bbdump
    masked?: boolean; // True if name should be hidden in UI
    syncSourceId?: string; // Local database: the saved database it is updated from
    /** Reached through an SSH tunnel; host/port hold the server and the remote port */
    ssh?: {
        host: string;
        user?: string;
        port?: number;
        remoteHost: string;
        remotePort: number;
        envFile?: string;
        envVar?: string;
    };
}

export interface Backup {
    filename: string;
    /** Absolute path, used by delete / download / restore (absent before 1.1.0) */
    file?: string;
    databaseId: string;
    path: string;
    size: number;
    created: string;
    encrypted: boolean;
}

export interface ScheduledTask {
    databaseId: string;
    schedule: string;
}

export interface Project {
    id: string;
    name: string;
    color: string; // Tailwind class, ex: "bg-blue-500"
    databaseIds: string[]; // IDs of linked DBs
    collapsed?: boolean; // Collapsed state in the UI
    masked?: boolean; // True if name should be hidden in UI
    proxyEnabled?: boolean; // TCP proxy enabled
    proxyPort?: number; // Local proxy port
    proxyTargetDbId?: string; // ID of the proxy target DB
    proxyUser?: string; // Custom proxy URL user (default: slugified project name)
    proxyPassword?: string; // Custom proxy URL password (default: slugified project name)
    proxyDbName?: string; // Custom proxy URL database name (default: slugified project name)
}

export interface ProxyActivityEvent {
    id: number;
    timestamp: string;
    projectId: string;
    type: 'started' | 'stopped' | 'connected' | 'disconnected' | 'target-switched';
    port?: number;
    targetDbId?: string;
    targetHost?: string;
    targetPort?: number;
    remoteAddress?: string;
    message: string;
}

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
    id: number;
    message: string;
    type: ToastType;
    /** Technical detail under the message (error from PostgreSQL, file name…) */
    detail?: string;
    action?: { label: string; run: () => void };
    /** ms before it goes away (paused while hovered) */
    duration: number;
    /** How many times the same message was shown in a row */
    count: number;
    /** Bumped when the same toast is shown again: restarts its progress bar */
    restartKey: number;
}

export interface Table {
    name: string;
    row_count?: string;
}

export interface TableSchema {
    columns: Column[];
}

export interface Column {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_primary: boolean;
    is_foreign: boolean;
}

export interface TableRelation {
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    constraint_name: string;
    constraint_type?: string;
}

export type RestoreTarget = Database & { isNew?: boolean };

// ---- IPC payloads (shapes produced by the main process) ----

/** 'backup-complete' event (BackupResult + the database id) */
export interface BackupCompleteEvent {
    success: boolean;
    databaseId: string;
    database: string;
    timestamp: string;
    error?: string;
}

export interface BackupProgress {
    status: string;
    dbId: string;
    logs: string[];
    error: string | null;
}

/** Database listed by 'get-postgres-config' (local server) */
export interface PostgresDatabase {
    name: string;
    owner: string;
    encoding: string;
    collate: string;
    ctype: string;
    size: string;
    connections?: number;
    hasConnections?: boolean;
}

/** Row of 'get-postgres-extensions' */
export interface PostgresExtension {
    name: string;
    default_version: string | null;
    installed_version: string | null;
    comment: string | null;
    is_installed: boolean;
}

/** Row of 'get-postgres-performance-stats' (pg_stat_statements; bigint columns arrive as strings) */
export interface QueryStat {
    query: string;
    calls: string | number;
    total_time: number;
    mean_time: number;
    rows: string | number;
    percentage: number;
}

/** Row of 'get-db-tables' */
export interface ViewerTable {
    name: string;
    row_count: number | null;
    row_count_estimated: boolean;
}

/** Column of 'get-table-schema' */
export interface TableColumnDetail {
    column_name: string;
    data_type: string;
    udt_schema: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_primary: boolean;
    /** Single-column unique index (not the primary key) */
    is_unique?: boolean;
    /** 'YES' for identity columns (GENERATED … AS IDENTITY): column_default is then null */
    is_identity?: string;
    /** 'ALWAYS' (cannot be inserted) or 'BY DEFAULT' */
    identity_generation?: string | null;
    /** 'ALWAYS' for generated (computed) columns, which cannot be inserted */
    is_generated?: string;
    is_foreign: boolean;
    foreign_key: { schema: string; table: string; column: string } | null;
}

/** 'get-db-full-schema' result */
export interface SchemaTable {
    schema: string;
    name: string;
}

export interface SchemaColumn {
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
}

export interface SchemaPrimaryKey {
    table_schema: string;
    table_name: string;
    column_name: string;
}

export interface SchemaForeignKey {
    constraint_name: string;
    source_schema: string;
    source_table: string;
    source_column: string;
    target_schema: string;
    target_table: string;
    target_column: string;
}

export interface FullSchema {
    schema: string | null;
    tables: SchemaTable[];
    columns: SchemaColumn[];
    primaryKeys: SchemaPrimaryKey[];
    foreignKeys: SchemaForeignKey[];
}

/** Data carried by a table node in the Vue Flow diagrams */
export interface TableNodeData {
    label: string;
    schema?: string;
    table?: string;
    columns: SchemaColumn[];
    primaryKeys: string[];
}

/**
 * Build a plain DB config object safe for IPC (avoids Vue reactive proxy cloning errors)
 */
export function buildDbConfig(db: Database) {
    return {
        id: db.id,
        name: db.name,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        connectionString: db.connectionString
    };
}

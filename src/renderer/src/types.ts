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
    cron?: string;
    enabled?: boolean;
    output: string;
    connectionString?: string;
    ssl?: boolean;
    lastBackup?: string;
    _originalPassword?: string; // For UI logic
    isLocalBbdump?: boolean; // True if created by bbdump
    masked?: boolean; // True if name should be hidden in UI
}

export interface Backup {
    filename: string;
    databaseId: string;
    path: string;
    size: number;
    created: string;
    encrypted: boolean;
}

export interface Log {
    level: 'info' | 'error' | 'warn';
    timestamp: string;
    database?: string;
    message: string;
}

export interface ScheduledTask {
    databaseId: string;
    schedule: string;
}

export interface Project {
    id: string;
    name: string;
    color: string; // Tailwind class, ex: "bg-blue-500"
    databaseIds: string[]; // IDs des DB liées
    collapsed?: boolean; // État replié dans l'UI
    masked?: boolean; // True if name should be hidden in UI
}

export interface Toast {
    id: number;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
    actionUrl?: string;
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

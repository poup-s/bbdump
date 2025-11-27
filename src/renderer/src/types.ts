export interface Database {
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
}

export interface Backup {
    filename: string;
    database: string;
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
    database: string;
    schedule: string;
}

export interface Toast {
    id: number;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
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

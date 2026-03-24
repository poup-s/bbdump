export interface DatabaseConfig {
  id: string;
  isLocalBbdump?: boolean;
  name: string;
  displayName?: string;
  // PostgreSQL connection string (e.g. postgresql://user:pass@host:port/db?sslmode=require)
  // If provided, takes precedence over host, port, user, password
  connectionString?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  encrypted?: boolean; // If true, password is encrypted (default: true)
  encryptBackups?: boolean; // If true, backup files are encrypted (default: false)
  cron: string;
  output: string;
  enabled?: boolean; // If false, scheduled tasks are paused
  lastBackup?: string;
  status?: 'success' | 'error' | 'running' | 'idle';
  compressionLevel?: number; // pg_dump compression level (0-9, default: 6)
  jobs?: number; // Number of parallel pg_dump jobs (default: 1)
  backupTimeout?: number; // Timeout in milliseconds (default: 30 minutes)
  ssl?: boolean; // If true, force SSL usage (sslmode=require)
  masked?: boolean; // If true, DB name is hidden in the UI (screen sharing)
}

export interface ProjectConfig {
  id: string;
  name: string;
  color: string;
  databaseIds: string[];
  masked?: boolean;
  proxyEnabled?: boolean;
  proxyPort?: number;
  proxyTargetDbId?: string;
  proxyUser?: string;       // Custom proxy URL user (default: slugified project name)
  proxyPassword?: string;   // Custom proxy URL password (default: slugified project name)
  proxyDbName?: string;     // Custom proxy URL database name (default: slugified project name)
}

export interface AppConfig {
  databases: DatabaseConfig[];
  projects?: ProjectConfig[];
  viewMode?: 'list' | 'project';
  onboardingCompleted?: boolean;
  language?: 'en' | 'fr';
  defaultBackupPath?: string;
  allowSqlMutations?: boolean;
  mcpSkipConfirmation?: boolean;
}

export interface BackupResult {
  success: boolean;
  database: string;
  timestamp: string;
  message?: string;
  error?: string;
  output?: string;
  filePath?: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'error' | 'warn';
  database?: string;
  message: string;
}


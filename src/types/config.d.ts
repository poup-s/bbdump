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
  retentionCount?: number; // Keep only the N most recent backups (undefined = keep all)
  verifyBackups?: boolean; // Read back each dump with pg_restore (default: true)
  ssl?: boolean; // Legacy (v1.0.2): true = sslmode=require. Kept in sync with sslMode for older versions
  sslMode?: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  sslRootCert?: string; // Absolute path to a CA bundle (e.g. AWS RDS global-bundle.pem)
  masked?: boolean; // If true, DB name is hidden in the UI (screen sharing)
  syncSourceId?: string; // Local database: the saved database it is updated from ("Update from…")
  /**
   * Reached through an SSH tunnel bbdump opens itself (v1.1). `host`/`port` above then
   * hold the server's address and the remote port, so a version without SSH support
   * fails to connect instead of reaching another database.
   */
  ssh?: SshSettings;
  /** Runtime only, never saved: host/port point at a local SSH tunnel */
  viaTunnel?: boolean;
}

export interface SshSettings {
  /** Alias from ~/.ssh/config, or host name / address */
  host: string;
  /** Only when the alias does not set them */
  user?: string;
  port?: number;
  /** PostgreSQL as seen from the server (usually localhost:5432) */
  remoteHost: string;
  remotePort: number;
  /** Where the credentials were read on the server, to read them again */
  envFile?: string;
  envVar?: string;
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
  launchAtLogin?: boolean; // Start hidden in the tray at login so scheduled backups run
  /**
   * 'local': a PostgreSQL server on this computer (plus remote databases).
   * 'remote': remote databases only, no local server features.
   * Missing on configs written before v1.1: migrated to 'local' in loadConfig().
   * ('docker' is planned, see UsageMode in setup.d.ts, and not accepted yet.)
   */
  usageMode?: 'local' | 'remote';
  /**
   * Last version whose "What's new" tour was seen or skipped (v1.1). Set to a version before
   * 1.1 when a 1.0.x configuration is migrated, so the 1.1 tour shows once; missing on
   * configurations created by 1.1 or later, which never need the 1.1 tour.
   */
  whatsNewSeen?: string;
}

export interface BackupResult {
  success: boolean;
  database: string;
  timestamp: string;
  message?: string;
  error?: string;
  output?: string;
  filePath?: string;
  /** Restored, but these errors happened (pg_restore's own lines) */
  warnings?: string[];
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'error' | 'warn';
  database?: string;
  message: string;
}


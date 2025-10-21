export interface DatabaseConfig {
  name: string;
  displayName?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  encrypted?: boolean; // Si true, le mot de passe est chiffré (par défaut true)
  encryptBackups?: boolean; // Si true, les fichiers de backup sont chiffrés (par défaut false)
  cron: string;
  output: string;
  enabled?: boolean; // Si false, les tâches planifiées sont en pause
  lastBackup?: string;
  status?: 'success' | 'error' | 'running' | 'idle';
  compressionLevel?: number; // Niveau de compression pg_dump (0-9, défaut: 6)
  jobs?: number; // Nombre de jobs parallèles pour pg_dump (défaut: 1)
  backupTimeout?: number; // Timeout en millisecondes (défaut: 30 minutes)
}

export interface AppConfig {
  databases: DatabaseConfig[];
}

export interface BackupResult {
  success: boolean;
  database: string;
  timestamp: string;
  message?: string;
  error?: string;
  output?: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'error' | 'warn';
  database?: string;
  message: string;
}


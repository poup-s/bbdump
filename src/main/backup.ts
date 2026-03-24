import { spawn, exec, ChildProcess } from 'child_process';
import { getErrorMessage } from './utils';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { DatabaseConfig, BackupResult } from '../types/config';
import { logger } from './logger';
import { pathManager } from './paths';
import { fileEncryptionManager } from './fileEncryption';
import * as Electron from 'electron';

const execAsync = promisify(exec);

interface PgDumpVersion {
  path: string;
  version: string;
  majorVersion: string;
  source: 'libpq' | 'postgresql' | 'system';
}

export class BackupManager {
  private backupDir: string;
  private pgDumpPath: string;
  private pgRestorePath: string;
  private mainWindow: Electron.BrowserWindow | null = null;
  private pgDumpVersionsCache: Map<string, PgDumpVersion[]> = new Map(); // Cache par version majeure
  private allPgDumpVersions: PgDumpVersion[] = []; // All versions found
  private pgRestoreVersionsCache: Map<string, PgDumpVersion[]> = new Map(); // Cache par version majeure pour pg_restore
  private allPgRestoreVersions: PgDumpVersion[] = []; // All pg_restore versions found
  private versionsDetected: boolean = false;
  private pgRestoreVersionsDetected: boolean = false;
  private activeProcesses: Set<ChildProcess> = new Set();

  constructor() {
    this.backupDir = pathManager.backupsPath;
    // Paths will be resolved asynchronously on first use
    // For now, use the command names (will be resolved via PATH)
    this.pgDumpPath = 'pg_dump';
    this.pgRestorePath = 'pg_restore';
    this.ensureBackupDir();

    // Initialize paths asynchronously (don't await)
    this.initializePaths().catch((error) => {
      logger.warn(`Failed to initialize PostgreSQL paths: ${error.message}`);
    });

    // Detect all available versions at startup
    this.detectAllPgDumpVersions().catch((error) => {
      logger.warn(`Failed to detect all pg_dump versions: ${error.message}`);
    });

    // Detect all available pg_restore versions at startup
    this.detectAllPgRestoreVersions().catch((error) => {
      logger.warn(`Failed to detect all pg_restore versions: ${error.message}`);
    });
  }

  private async initializePaths(): Promise<void> {
    try {
      this.pgDumpPath = await this.findPostgresCommand('pg_dump');
      this.pgRestorePath = await this.findPostgresCommand('pg_restore');
      logger.info(`pg_dump found: ${this.pgDumpPath}`);
      logger.info(`pg_restore found: ${this.pgRestorePath}`);
    } catch (error) {
      logger.warn(`Failed to initialize PostgreSQL paths: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Detects all available pg_dump versions on the system
   */
  private async detectAllPgDumpVersions(): Promise<void> {
    if (this.versionsDetected) {
      return; // Already detected
    }

    try {
      logger.info('Detecting all available pg_dump versions...');
      const versions: PgDumpVersion[] = [];
      const os = process.platform;

      if (os === 'darwin') {
        // Sur macOS, chercher dans Homebrew
        await this.detectHomebrewVersions(versions);
      } else if (os === 'linux') {
        // Sur Linux, chercher dans les chemins standards
        await this.detectLinuxVersions(versions);
      }

      // Also add the system version (in PATH)
      try {
        const { stdout } = await execAsync('which pg_dump 2>/dev/null || echo ""');
        if (stdout.trim()) {
          const systemPath = stdout.trim();
          const version = await this.getPgDumpVersion(systemPath);
          if (version) {
            versions.push({
              path: systemPath,
              version: version,
              majorVersion: version.split('.')[0],
              source: 'system'
            });
          }
        }
      } catch {
        // Ignore
      }

      // Organiser par version majeure
      const versionsByMajor = new Map<string, PgDumpVersion[]>();
      for (const v of versions) {
        if (!versionsByMajor.has(v.majorVersion)) {
          versionsByMajor.set(v.majorVersion, []);
        }
        versionsByMajor.get(v.majorVersion)!.push(v);
      }

      this.pgDumpVersionsCache = versionsByMajor;
      this.allPgDumpVersions = versions;

      logger.info(`Found ${versions.length} pg_dump version(s):`);
      for (const v of versions) {
        logger.info(`  - ${v.version} at ${v.path} (${v.source})`);
      }

      this.versionsDetected = true;
    } catch (error) {
      logger.error(`Error detecting pg_dump versions: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Detects all available pg_restore versions on the system
   */
  private async detectAllPgRestoreVersions(): Promise<void> {
    if (this.pgRestoreVersionsDetected) {
      return; // Already detected
    }

    try {
      logger.info('Detecting all available pg_restore versions...');
      const versions: PgDumpVersion[] = [];
      const os = process.platform;

      if (os === 'darwin') {
        // Sur macOS, chercher dans Homebrew
        await this.detectHomebrewPgRestoreVersions(versions);
      } else if (os === 'linux') {
        // Sur Linux, chercher dans les chemins standards
        await this.detectLinuxPgRestoreVersions(versions);
      }

      // Also add the system version (in PATH)
      try {
        const { stdout } = await execAsync('which pg_restore 2>/dev/null || echo ""');
        if (stdout.trim()) {
          const systemPath = stdout.trim();
          const version = await this.getPgRestoreVersion(systemPath);
          if (version) {
            versions.push({
              path: systemPath,
              version: version,
              majorVersion: version.split('.')[0],
              source: 'system'
            });
          }
        }
      } catch {
        // Ignore
      }

      // Organiser par version majeure
      const versionsByMajor = new Map<string, PgDumpVersion[]>();
      for (const v of versions) {
        if (!versionsByMajor.has(v.majorVersion)) {
          versionsByMajor.set(v.majorVersion, []);
        }
        versionsByMajor.get(v.majorVersion)!.push(v);
      }

      this.pgRestoreVersionsCache = versionsByMajor;
      this.allPgRestoreVersions = versions;

      logger.info(`Found ${versions.length} pg_restore version(s):`);
      for (const v of versions) {
        logger.info(`  - ${v.version} at ${v.path} (${v.source})`);
      }

      this.pgRestoreVersionsDetected = true;
    } catch (error) {
      logger.error(`Error detecting pg_restore versions: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Detects pg_restore versions in Homebrew (macOS)
   */
  private async detectHomebrewPgRestoreVersions(versions: PgDumpVersion[]): Promise<void> {
    const homebrewPrefixes = ['/opt/homebrew', '/usr/local'];

    for (const prefix of homebrewPrefixes) {
      // Search in libpq (client)
      const libpqPath = `${prefix}/Cellar/libpq`;
      if (fs.existsSync(libpqPath)) {
        try {
          const libpqVersions = fs.readdirSync(libpqPath);
          for (const libpqVersion of libpqVersions) {
            const pgRestorePath = `${libpqPath}/${libpqVersion}/bin/pg_restore`;
            if (fs.existsSync(pgRestorePath)) {
              const version = await this.getPgRestoreVersion(pgRestorePath);
              if (version) {
                versions.push({
                  path: pgRestorePath,
                  version: version,
                  majorVersion: version.split('.')[0],
                  source: 'libpq'
                });
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      // Search in postgresql@* (full server)
      const cellarPath = `${prefix}/Cellar`;
      if (fs.existsSync(cellarPath)) {
        try {
          const dirs = fs.readdirSync(cellarPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const postgresPath = `${cellarPath}/${dir}`;
            if (fs.existsSync(postgresPath)) {
              const subDirs = fs.readdirSync(postgresPath);
              for (const subDir of subDirs) {
                const pgRestorePath = `${postgresPath}/${subDir}/bin/pg_restore`;
                if (fs.existsSync(pgRestorePath)) {
                  const version = await this.getPgRestoreVersion(pgRestorePath);
                  if (version) {
                    versions.push({
                      path: pgRestorePath,
                      version: version,
                      majorVersion: version.split('.')[0],
                      source: 'postgresql'
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      // Also search in /opt (symbolic links)
      const optPath = `${prefix}/opt`;
      if (fs.existsSync(optPath)) {
        try {
          const dirs = fs.readdirSync(optPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const pgRestorePath = `${optPath}/${dir}/bin/pg_restore`;
            if (fs.existsSync(pgRestorePath)) {
              const version = await this.getPgRestoreVersion(pgRestorePath);
              if (version) {
                // Check if we haven't already added it
                if (!versions.some(v => v.path === pgRestorePath)) {
                  versions.push({
                    path: pgRestorePath,
                    version: version,
                    majorVersion: version.split('.')[0],
                    source: 'postgresql'
                  });
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Detects pg_restore versions on Linux
   */
  private async detectLinuxPgRestoreVersions(versions: PgDumpVersion[]): Promise<void> {
    const possiblePaths = [
      '/usr/lib/postgresql',
      '/usr/local/lib/postgresql',
      '/opt/postgresql'
    ];

    for (const basePath of possiblePaths) {
      if (fs.existsSync(basePath)) {
        try {
          const dirs = fs.readdirSync(basePath);
          for (const dir of dirs) {
            const pgRestorePath = `${basePath}/${dir}/bin/pg_restore`;
            if (fs.existsSync(pgRestorePath)) {
              const version = await this.getPgRestoreVersion(pgRestorePath);
              if (version) {
                versions.push({
                  path: pgRestorePath,
                  version: version,
                  majorVersion: version.split('.')[0],
                  source: 'postgresql'
                });
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Detects versions in Homebrew (macOS)
   */
  private async detectHomebrewVersions(versions: PgDumpVersion[]): Promise<void> {
    const homebrewPrefixes = ['/opt/homebrew', '/usr/local'];

    for (const prefix of homebrewPrefixes) {
      // Search in libpq (client)
      const libpqPath = `${prefix}/Cellar/libpq`;
      if (fs.existsSync(libpqPath)) {
        try {
          const libpqVersions = fs.readdirSync(libpqPath);
          for (const libpqVersion of libpqVersions) {
            const pgDumpPath = `${libpqPath}/${libpqVersion}/bin/pg_dump`;
            if (fs.existsSync(pgDumpPath)) {
              const version = await this.getPgDumpVersion(pgDumpPath);
              if (version) {
                versions.push({
                  path: pgDumpPath,
                  version: version,
                  majorVersion: version.split('.')[0],
                  source: 'libpq'
                });
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      // Search in postgresql@* (full server)
      const cellarPath = `${prefix}/Cellar`;
      if (fs.existsSync(cellarPath)) {
        try {
          const dirs = fs.readdirSync(cellarPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const postgresPath = `${cellarPath}/${dir}`;
            if (fs.existsSync(postgresPath)) {
              const subDirs = fs.readdirSync(postgresPath);
              for (const subDir of subDirs) {
                const pgDumpPath = `${postgresPath}/${subDir}/bin/pg_dump`;
                if (fs.existsSync(pgDumpPath)) {
                  const version = await this.getPgDumpVersion(pgDumpPath);
                  if (version) {
                    versions.push({
                      path: pgDumpPath,
                      version: version,
                      majorVersion: version.split('.')[0],
                      source: 'postgresql'
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      // Also search in /opt (symbolic links)
      const optPath = `${prefix}/opt`;
      if (fs.existsSync(optPath)) {
        try {
          const dirs = fs.readdirSync(optPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const pgDumpPath = `${optPath}/${dir}/bin/pg_dump`;
            if (fs.existsSync(pgDumpPath)) {
              const version = await this.getPgDumpVersion(pgDumpPath);
              if (version) {
                // Check if we haven't already added it
                if (!versions.some(v => v.path === pgDumpPath)) {
                  versions.push({
                    path: pgDumpPath,
                    version: version,
                    majorVersion: version.split('.')[0],
                    source: 'postgresql'
                  });
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Detects versions on Linux
   */
  private async detectLinuxVersions(versions: PgDumpVersion[]): Promise<void> {
    const possiblePaths = [
      '/usr/lib/postgresql',       // Debian/Ubuntu
      '/usr/local/lib/postgresql', // Custom installs
      '/opt/postgresql',           // Custom installs
    ];

    for (const basePath of possiblePaths) {
      if (fs.existsSync(basePath)) {
        try {
          const dirs = fs.readdirSync(basePath);
          for (const dir of dirs) {
            const pgDumpPath = `${basePath}/${dir}/bin/pg_dump`;
            if (fs.existsSync(pgDumpPath)) {
              const version = await this.getPgDumpVersion(pgDumpPath);
              if (version) {
                versions.push({
                  path: pgDumpPath,
                  version: version,
                  majorVersion: version.split('.')[0],
                  source: 'postgresql'
                });
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    // RHEL/Fedora: /usr/pgsql-<version>/bin/pg_dump
    try {
      const { stdout } = await execAsync('ls -d /usr/pgsql-*/bin/pg_dump 2>/dev/null || echo ""');
      for (const pgDumpPath of stdout.trim().split('\n').filter(Boolean)) {
        if (fs.existsSync(pgDumpPath)) {
          const version = await this.getPgDumpVersion(pgDumpPath);
          if (version) {
            versions.push({
              path: pgDumpPath,
              version: version,
              majorVersion: version.split('.')[0],
              source: 'postgresql'
            });
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Gets the version of a pg_dump by executing it
   */
  private async getPgDumpVersion(pgDumpPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${pgDumpPath}" --version 2>&1`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Gets the version of a pg_restore by executing it
   */
  private async getPgRestoreVersion(pgRestorePath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${pgRestorePath}" --version 2>&1`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Detects the version of a PostgreSQL backup file
   * Le format custom commence par "PGDMP" suivi de la version majeure et mineure
   */
  private detectBackupVersion(backupPath: string): { major: number; minor: number } | null {
    try {
      const fd = fs.openSync(backupPath, 'r');
      const buffer = Buffer.alloc(10);
      fs.readSync(fd, buffer, 0, 10, 0);
      fs.closeSync(fd);

      // Check the magic number "PGDMP"
      const magic = buffer.toString('ascii', 0, 5);
      if (magic !== 'PGDMP') {
        return null; // Pas un fichier de backup custom
      }

      // Read the major and minor version (bytes 5 and 6)
      const major = buffer.readUInt8(5);
      const minor = buffer.readUInt8(6);

      return { major, minor };
    } catch (error) {
      logger.warn(`Failed to detect backup version: ${error}`);
      return null;
    }
  }

  setMainWindow(window: Electron.BrowserWindow | null) {
    this.mainWindow = window;
  }

  killAllActiveProcesses() {
    for (const proc of this.activeProcesses) {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
      }
    }
    this.activeProcesses.clear();
  }

  /**
   * Cleans the connection string by removing parameters unsupported by pg_dump
   */
  private cleanConnectionString(connectionString: string): string {
    try {
      // List of unsupported or problematic parameters with pg_dump
      const unsupportedParams = [
        'channel_binding',
        'target_session_attrs'
      ];

      // Parser l'URL
      const url = new URL(connectionString);

      // Clean up the parameters
      let cleaned = false;
      unsupportedParams.forEach(param => {
        if (url.searchParams.has(param)) {
          const value = url.searchParams.get(param);
          logger.info(`Removing unsupported parameter from connection string: ${param}=${value}`);
          url.searchParams.delete(param);
          cleaned = true;
        }
      });

      if (cleaned) {
        const cleanedUrl = url.toString();
        logger.info(`Cleaned connection string`);
        return cleanedUrl;
      }

      return connectionString;
    } catch (error) {
      logger.warn(`Failed to parse connection string, using as-is: ${error}`);
      return connectionString;
    }
  }

  private async findPostgresCommand(command: string): Promise<string> {
    // Use the centralized toolDetector module
    const { findPostgresCommand: findCommand } = await import('./tools/toolDetector');
    return findCommand(command);
  }

  /**
   * Detects the PostgreSQL server version and finds the corresponding pg_dump
   * Uses the detected versions cache for a fast lookup
   */
  /**
   * Connects to a database to detect the server version.
   * On Linux, tries Unix socket first (peer auth) before TCP.
   */
  private async detectServerVersion(db: DatabaseConfig): Promise<{ version: string; majorVersion: string } | null> {
    const { Client } = await import('pg');
    const isLinux = process.platform === 'linux';
    const isLocalHost = db.host === 'localhost' || db.host === '127.0.0.1';

    // Build a list of connection configs to try
    const configs: any[] = [];

    // On Linux with local host, try Unix socket first (peer auth, no password needed)
    if (isLinux && isLocalHost && !db.connectionString) {
      const currentUser = require('os').userInfo().username;
      const users = [db.user, currentUser, 'postgres'].filter(Boolean);
      const socketPaths = ['/var/run/postgresql', '/tmp'];
      for (const user of users) {
        for (const socketPath of socketPaths) {
          configs.push({
            host: socketPath,
            port: db.port,
            user: user,
            password: '',
            database: 'postgres',
            connectionTimeoutMillis: 5000
          });
        }
      }
    }

    // TCP connection (with provided password or common defaults)
    if (db.connectionString) {
      configs.push({
        connectionString: db.connectionString,
        ssl: db.ssl,
        connectionTimeoutMillis: 5000
      });
    } else {
      const passwords = isLinux ? [db.password || '', 'postgres', ''] : [db.password || ''];
      for (const pwd of passwords) {
        configs.push({
          host: db.host,
          port: db.port,
          user: db.user,
          password: pwd,
          database: db.name || 'postgres',
          ssl: db.ssl,
          connectionTimeoutMillis: 5000
        });
      }
    }

    for (const config of configs) {
      try {
        const client = new Client(config);
        await client.connect();
        try {
          const result = await client.query('SELECT version()');
          const versionMatch = result.rows[0]?.version?.match(/PostgreSQL (\d+\.\d+)/);
          if (versionMatch && versionMatch[1]) {
            return { version: versionMatch[1], majorVersion: versionMatch[1].split('.')[0] };
          }
        } finally {
          await client.end();
        }
      } catch {
        // Try next config
      }
    }

    return null;
  }

  /**
   * On Linux, try to auto-install the matching postgresql-client package.
   * Uses a temporary shell script via pkexec for reliable graphical privilege escalation.
   */
  private async tryInstallPgDumpLinux(majorVersion: string, dbName: string): Promise<boolean> {
    if (process.platform !== 'linux') return false;

    logger.info(`Attempting to auto-install postgresql-client-${majorVersion} on Linux...`, dbName);

    // Check if apt-get is available (Debian/Ubuntu)
    let hasApt = false;
    try {
      await execAsync('which apt-get 2>/dev/null');
      hasApt = true;
    } catch {
      logger.warn(`apt-get not found`, dbName);
    }

    // Helper to clear version caches after successful install
    const clearCaches = () => {
      this.versionsDetected = false;
      this.pgDumpVersionsCache.clear();
      this.allPgDumpVersions = [];
      this.pgRestoreVersionsDetected = false;
      this.pgRestoreVersionsCache.clear();
      this.allPgRestoreVersions = [];
    };

    // Helper to check if installation succeeded
    const verifyInstall = (): boolean => {
      const pgDumpPath = `/usr/lib/postgresql/${majorVersion}/bin/pg_dump`;
      if (fs.existsSync(pgDumpPath)) {
        logger.info(`postgresql-client-${majorVersion} installed, pg_dump at: ${pgDumpPath}`, dbName);
        clearCaches();
        return true;
      }
      return false;
    };

    if (hasApt) {
      // Strategy 1: Try simple apt-get install (works if user is root or package already in cache)
      for (const prefix of ['', 'sudo -n']) {
        try {
          const cmd = `${prefix} apt-get install -y postgresql-client-${majorVersion}`.trim();
          logger.info(`Trying: ${cmd}`, dbName);
          await execAsync(cmd, { timeout: 120000 });
          if (verifyInstall()) return true;
        } catch {
          // Continue to next strategy
        }
      }

      // Strategy 2: Write a temp script and run it via pkexec (graphical password prompt)
      // pkexec works better with a script file than inline commands
      const tmpScript = `/tmp/bbdump-install-pgclient-${majorVersion}.sh`;
      try {
        const scriptContent = `#!/bin/bash
set -e

# Ensure PGDG repository is configured
if ! apt-cache show "postgresql-client-${majorVersion}" >/dev/null 2>&1; then
  CODENAME=$(lsb_release -cs 2>/dev/null || echo "jammy")
  echo "deb http://apt.postgresql.org/pub/repos/apt $CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg 2>/dev/null || true
  apt-get update -y
fi

apt-get install -y postgresql-client-${majorVersion}
`;
        fs.writeFileSync(tmpScript, scriptContent, { mode: 0o755 });
        logger.info(`Running install script via pkexec...`, dbName);
        await execAsync(`pkexec bash "${tmpScript}"`, { timeout: 180000 });
        if (verifyInstall()) return true;
      } catch (error) {
        logger.info(`pkexec install failed: ${getErrorMessage(error)}`, dbName);
      } finally {
        // Cleanup temp script
        try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
      }

      // Strategy 3: Try sudo with full PGDG repo setup (for systems without pkexec)
      try {
        logger.info(`Trying sudo with PGDG repo setup...`, dbName);
        const codename = (await execAsync('lsb_release -cs 2>/dev/null || echo "jammy"')).stdout.trim();
        const commands = [
          `sudo -n sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt ${codename}-pgdg main" > /etc/apt/sources.list.d/pgdg.list'`,
          `curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo -n gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg`,
          `sudo -n apt-get update -y`,
          `sudo -n apt-get install -y postgresql-client-${majorVersion}`
        ];
        for (const cmd of commands) {
          await execAsync(cmd, { timeout: 60000 });
        }
        if (verifyInstall()) return true;
      } catch (error) {
        logger.info(`sudo PGDG install failed: ${getErrorMessage(error)}`, dbName);
      }
    }

    // dnf/yum fallback
    for (const pkgMgr of ['dnf', 'yum']) {
      try {
        await execAsync(`which ${pkgMgr} 2>/dev/null`);
        const cmd = `pkexec ${pkgMgr} install -y postgresql${majorVersion}`;
        logger.info(`Trying: ${cmd}`, dbName);
        await execAsync(cmd, { timeout: 180000 });
        if (verifyInstall()) return true;
      } catch {
        // Continue
      }
    }

    return false;
  }

  private async findCompatiblePgDump(db: DatabaseConfig): Promise<string> {
    logger.info(`Finding compatible pg_dump for database: ${db.name}`, db.name);

    // Ensure versions are detected
    if (!this.versionsDetected) {
      await this.detectAllPgDumpVersions();
    }

    try {
      // Detect the PostgreSQL server version (with Linux socket support)
      const serverInfo = await this.detectServerVersion(db);
      const serverVersion = serverInfo?.version || null;
      const serverMajorVersion = serverInfo?.majorVersion || null;

      if (serverVersion) {
        logger.info(`Detected PostgreSQL server version: ${serverVersion}`, db.name);
      } else {
        logger.warn(`Could not detect server version`, db.name);
      }

      // If we detected a version, use the cache to find the compatible pg_dump
      if (serverMajorVersion && this.pgDumpVersionsCache.has(serverMajorVersion)) {
        const compatibleVersions = this.pgDumpVersionsCache.get(serverMajorVersion)!;

        // Prefer exact or closest versions
        // Sort by preference: postgresql > libpq > system
        const sortedVersions = compatibleVersions.sort((a, b) => {
          const sourcePriority = { 'postgresql': 1, 'libpq': 2, 'system': 3 };
          return (sourcePriority[a.source] || 99) - (sourcePriority[b.source] || 99);
        });

        // Take the first compatible version (best match)
        const bestMatch = sortedVersions[0];
        logger.info(`Found compatible pg_dump ${bestMatch.version} for PostgreSQL ${serverVersion}: ${bestMatch.path} (${bestMatch.source})`, db.name);
        return bestMatch.path;
      }

      // If not found in cache, try a dynamic search (fallback)
      if (serverMajorVersion) {
        logger.warn(`No cached pg_dump found for PostgreSQL ${serverVersion}, performing dynamic search...`, db.name);
        // Re-detect versions in case new versions have been installed
        this.versionsDetected = false;
        await this.detectAllPgDumpVersions();

        if (this.pgDumpVersionsCache.has(serverMajorVersion)) {
          const compatibleVersions = this.pgDumpVersionsCache.get(serverMajorVersion)!;
          const bestMatch = compatibleVersions[0];
          logger.info(`Found compatible pg_dump ${bestMatch.version} for PostgreSQL ${serverVersion}: ${bestMatch.path}`, db.name);
          return bestMatch.path;
        }

        // On Linux, try to auto-install the matching client package
        if (process.platform === 'linux') {
          const installed = await this.tryInstallPgDumpLinux(serverMajorVersion, db.name);
          if (installed) {
            await this.detectAllPgDumpVersions();
            await this.detectAllPgRestoreVersions();
            if (this.pgDumpVersionsCache.has(serverMajorVersion)) {
              const compatibleVersions = this.pgDumpVersionsCache.get(serverMajorVersion)!;
              const bestMatch = compatibleVersions[0];
              logger.info(`Found compatible pg_dump ${bestMatch.version} after auto-install: ${bestMatch.path}`, db.name);
              return bestMatch.path;
            }
          }
        }

        logger.warn(`Could not find pg_dump for PostgreSQL ${serverVersion} (major: ${serverMajorVersion})`, db.name);
        logger.warn(`Available versions: ${Array.from(this.pgDumpVersionsCache.keys()).join(', ') || 'none'}`, db.name);

        // Throw a clear error with installation instructions
        const installHint = process.platform === 'linux'
          ? `Please install the matching client:\n  sudo apt install postgresql-client-${serverMajorVersion}\n  or: sudo dnf install postgresql${serverMajorVersion}`
          : `Please install pg_dump version ${serverMajorVersion}.x`;
        throw new Error(`pg_dump version mismatch: server is PostgreSQL ${serverVersion} but only pg_dump ${this.allPgDumpVersions.map(v => v.version).join(', ') || 'unknown'} is available.\n\n${installHint}`);
      } else {
        logger.warn(`Server version not detected, using default pg_dump: ${this.pgDumpPath}`, db.name);
        if (this.allPgDumpVersions.length > 0) {
          logger.info(`Available pg_dump versions: ${this.allPgDumpVersions.map(v => v.version).join(', ')}`, db.name);
        }
      }
    } catch (error) {
      // Re-throw version mismatch errors with clear messages
      if (getErrorMessage(error)?.includes('version mismatch')) {
        throw error;
      }
      logger.error(`Error finding compatible pg_dump: ${getErrorMessage(error)}`, db.name);
    }

    // Fallback: use the default pg_dump
    logger.info(`Using default pg_dump: ${this.pgDumpPath}`, db.name);
    return this.pgDumpPath;
  }

  /**
   * Finds a compatible pg_restore version based on the backup version
   */
  private async findCompatiblePgRestore(backupPath: string): Promise<string> {
    // Ensure versions are detected
    if (!this.pgRestoreVersionsDetected) {
      await this.detectAllPgRestoreVersions();
    }

    // Detect the backup version
    const backupVersion = this.detectBackupVersion(backupPath);
    if (!backupVersion) {
      logger.warn(`Could not detect backup version, using default pg_restore: ${this.pgRestorePath}`);
      return this.pgRestorePath;
    }

    logger.info(`Detected backup version: ${backupVersion.major}.${backupVersion.minor}`);

    // Search for a compatible pg_restore version
    // pg_restore can read backups created with the same or higher major version
    const _backupMajorVersion = backupVersion.major.toString();

    // First look for an exact or higher version
    const compatibleVersions: PgDumpVersion[] = [];

    // Iterate over all major versions >= the backup version
    for (const [majorVersion, versions] of this.pgRestoreVersionsCache.entries()) {
      const major = parseInt(majorVersion, 10);
      if (major >= backupVersion.major) {
        compatibleVersions.push(...versions);
      }
    }

    if (compatibleVersions.length > 0) {
      // Sort by version descending (most recent first)
      // pg_restore is backward-compatible, so the most recent version is always the best choice
      compatibleVersions.sort((a, b) => {
        // Comparer les versions majeures
        const aMajor = parseInt(a.majorVersion, 10);
        const bMajor = parseInt(b.majorVersion, 10);
        if (aMajor !== bMajor) {
          return bMajor - aMajor; // Descending
        }

        // If same major version, compare full versions (approximate but sufficient)
        if (a.version !== b.version) {
          return b.version.localeCompare(a.version, undefined, { numeric: true });
        }

        // If same version, prefer postgresql > libpq > system
        const sourcePriority = { 'postgresql': 1, 'libpq': 2, 'system': 3 };
        return (sourcePriority[a.source] || 99) - (sourcePriority[b.source] || 99);
      });

      const bestMatch = compatibleVersions[0];
      logger.info(`Found compatible pg_restore ${bestMatch.version} for backup version ${backupVersion.major}.${backupVersion.minor}: ${bestMatch.path} (${bestMatch.source})`);
      return bestMatch.path;
    }

    // If no compatible version found, use the default
    logger.warn(`No compatible pg_restore found for backup version ${backupVersion.major}.${backupVersion.minor}, using default: ${this.pgRestorePath}`);
    logger.warn(`Available pg_restore versions: ${Array.from(this.pgRestoreVersionsCache.keys()).join(', ') || 'none'}`);
    return this.pgRestorePath;
  }

  private ensureBackupDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      logger.info(`Backup directory created: ${this.backupDir}`);
    }
  }

  private verifyPgDumpExecutable(): { valid: boolean; error?: string } {
    try {
      // Check that the file exists
      if (!fs.existsSync(this.pgDumpPath)) {
        return {
          valid: false,
          error: `pg_dump not found at path: ${this.pgDumpPath}`
        };
      }

      // Check that the file is executable
      try {
        fs.accessSync(this.pgDumpPath, fs.constants.X_OK);
      } catch {
        return {
          valid: false,
          error: `pg_dump found but not executable: ${this.pgDumpPath}`
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Error verifying pg_dump: ${error}`
      };
    }
  }

  private async checkDiskSpace(targetPath: string): Promise<{ available: number; total: number } | null> {
    try {
      // Resolve the absolute path
      const absolutePath = path.isAbsolute(targetPath)
        ? targetPath
        : path.join(pathManager.appDataPath, targetPath);

      // Get the parent directory if it's a file
      const dirPath = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
        ? absolutePath
        : path.dirname(absolutePath);

      // Use df to get disk space (compatible with macOS and Linux)
      const { stdout } = await execAsync(`df -k "${dirPath}" | tail -1`);

      // Parser la sortie de df
      // Format: Filesystem 1K-blocks Used Available Capacity Mounted
      const parts = stdout.trim().split(/\s+/);

      if (parts.length < 4) {
        logger.warn(`Unable to parse df output: ${stdout}`);
        return null;
      }

      const available = parseInt(parts[3], 10) * 1024; // Convertir Ko en octets
      const total = parseInt(parts[1], 10) * 1024; // Convertir Ko en octets

      return { available, total };
    } catch (error) {
      logger.warn(`Error checking disk space: ${error}`);
      return null;
    }
  }

  private async estimateDatabaseSize(db: DatabaseConfig): Promise<number | null> {
    try {
      // Use psql to get the database size
      const args = [
        '-t', // Tuples-only mode (no headers)
        '-c', `SELECT pg_database_size('${db.name.replace(/'/g, "''")}');`
      ];

      // If a connection string is provided, use it
      if (db.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(db.connectionString);
        args.unshift('-d', cleanedConnectionString);
      } else {
        const isLinux = process.platform === 'linux';
        const isLocalHost = db.host === 'localhost' || db.host === '127.0.0.1';
        const hasPassword = db.password && db.password.trim().length > 0;

        // On Linux with local host and no password, use Unix socket (peer auth)
        if (isLinux && isLocalHost && !hasPassword) {
          args.unshift('-h', '/var/run/postgresql');
        } else {
          args.unshift('-h', db.host);
        }
        args.unshift('-p', db.port.toString());
        args.unshift('-U', db.user);
        args.unshift('-d', db.name);
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env
      };

      if (db.ssl) {
        env.PGSSLMODE = 'require';
      }

      // Add PGPASSWORD only if not using a connection string and if a password is provided
      // For local databases (isLocalBbdump), the password can be empty (peer/ident authentication)
      if (!db.connectionString && db.password && db.password.trim().length > 0) {
        env.PGPASSWORD = db.password;
      }

      const psqlPath = await this.findPostgresCommand('psql');
      const { stdout } = await execAsync(
        `"${psqlPath}" ${args.map(arg => `"${arg}"`).join(' ')}`,
        {
          env,
          timeout: 10000 // 10 secondes de timeout
        }
      );

      const size = parseInt(stdout.trim(), 10);

      if (isNaN(size)) {
        logger.warn(`Unable to parse database size: ${stdout}`);
        return null;
      }

      return size;
    } catch (error) {
      logger.warn(`Unable to estimate database size: ${error}`);
      return null;
    }
  }

  private async verifyDiskSpace(db: DatabaseConfig, outputPath: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check available disk space
      const diskSpace = await this.checkDiskSpace(outputPath);

      if (!diskSpace) {
        // If we can't check the space, continue with a warning
        logger.warn('Unable to verify disk space, proceeding with backup', db.name);
        return { valid: true };
      }

      logger.info(`Disk space available: ${this.formatBytes(diskSpace.available)} / ${this.formatBytes(diskSpace.total)}`, db.name);

      // Try to estimate the database size
      const estimatedSize = await this.estimateDatabaseSize(db);

      if (estimatedSize) {
        logger.info(`Estimated database size: ${this.formatBytes(estimatedSize)}`, db.name);

        // Calculate the required space with a safety margin
        // pg_dump with compression generally produces files between 5% and 20% of the original size
        // Use the same logic as executeBackup for the compression level
        const compressionLevel = db.compressionLevel ?? 6; // Default level 6, same as executeBackup

        let compressionFactor: number;

        if (compressionLevel > 0) {
          // Avec compression (format custom -F c -Z N)
          // Observed compression factor: ~8-15% for text data
          // On utilise 15% comme estimation conservatrice
          compressionFactor = 0.15;
        } else {
          // Sans compression explicite (niveau 0)
          // The custom format still compresses slightly
          compressionFactor = 0.35;
        }

        // Add an additional 50% safety margin
        const requiredSpace = estimatedSize * compressionFactor * 1.5;

        logger.info(`Compression level: ${compressionLevel}, factor: ${compressionFactor * 100}%, required space (with 50% margin): ${this.formatBytes(requiredSpace)}`, db.name);

        if (diskSpace.available < requiredSpace) {
          return {
            valid: false,
            error: `Insufficient disk space. Available: ${this.formatBytes(diskSpace.available)}, Required: ${this.formatBytes(requiredSpace)}`
          };
        }
      } else {
        // If we can't estimate the size, check that at least 1 GB is available
        const minRequiredSpace = 1024 * 1024 * 1024; // 1 Go

        if (diskSpace.available < minRequiredSpace) {
          return {
            valid: false,
            error: `Insufficient disk space. Available: ${this.formatBytes(diskSpace.available)}, Minimum required: ${this.formatBytes(minRequiredSpace)}`
          };
        }

        logger.warn('Unable to estimate database size, proceeding with backup (minimum 1GB available)', db.name);
      }

      return { valid: true };
    } catch (error) {
      logger.warn(`Error verifying disk space: ${error}`, db.name);
      // In case of error, continue with a warning rather than blocking
      return { valid: true };
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  private validateDatabaseConfig(db: DatabaseConfig): { valid: boolean; error?: string } {
    // Validation des champs requis (en premier, avant toute utilisation des champs)
    if (!db.name || db.name.trim().length === 0) {
      return { valid: false, error: 'Database name is required' };
    }

    if (!db.host || db.host.trim().length === 0) {
      return { valid: false, error: 'Host is required' };
    }

    if (!db.user || db.user.trim().length === 0) {
      return { valid: false, error: 'Username is required' };
    }

    if (!db.isLocalBbdump && (!db.password || db.password.trim().length === 0)) {
      return { valid: false, error: 'Password is required' };
    }

    // Validation du port
    if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) {
      return {
        valid: false,
        error: `Invalid port number: ${db.port}. Must be between 1 and 65535`
      };
    }

    // Validate the database name (no dangerous characters)
    const dangerousChars = /[;&|`$(){}[\]<>\\]/;
    if (dangerousChars.test(db.name)) {
      return {
        valid: false,
        error: `Database name contains dangerous characters: ${db.name}`
      };
    }

    // Validation du nom d'utilisateur
    if (dangerousChars.test(db.user)) {
      return {
        valid: false,
        error: `Username contains dangerous characters: ${db.user}`
      };
    }

    // Validate the host (block suspicious characters)
    if (dangerousChars.test(db.host)) {
      return {
        valid: false,
        error: `Host contains dangerous characters: ${db.host}`
      };
    }

    // Validation du chemin de sortie contre path traversal
    // db.output may be absent (handled below in executeBackup with the default path)
    if (!db.output || db.output.trim().length === 0) {
      return { valid: true }; // The default path will be used in executeBackup
    }

    const normalizedPath = path.normalize(db.output);

    // Bloquer les tentatives de path traversal
    if (normalizedPath.includes('..')) {
      return {
        valid: false,
        error: `Output path contains path traversal attempt: ${db.output}`
      };
    }

    // Block suspicious absolute paths (unless they are in authorized directories)
    if (path.isAbsolute(db.output)) {
      const outputDir = path.dirname(db.output);
      const appDataPath = pathManager.appDataPath;
      const backupsPath = pathManager.backupsPath;
      const homeDir = require('os').homedir();

      // Check that the absolute path starts with an authorized directory
      if (!outputDir.startsWith(appDataPath) &&
        !outputDir.startsWith(backupsPath) &&
        !outputDir.startsWith(homeDir) &&
        !outputDir.startsWith('/tmp') &&
        !outputDir.startsWith('/var/tmp')) {
        return {
          valid: false,
          error: `Output path is outside allowed directories: ${db.output}`
        };
      }
    }

    // Check that the filename doesn't contain null characters
    if (db.output.includes('\0')) {
      return {
        valid: false,
        error: `Output path contains null characters`
      };
    }

    // Validation du niveau de compression
    if (db.compressionLevel !== undefined) {
      if (!Number.isInteger(db.compressionLevel) || db.compressionLevel < 0 || db.compressionLevel > 9) {
        return {
          valid: false,
          error: `Invalid compression level: ${db.compressionLevel}. Must be between 0 and 9`
        };
      }
    }

    // Validation du nombre de jobs
    if (db.jobs !== undefined) {
      if (!Number.isInteger(db.jobs) || db.jobs < 1) {
        return {
          valid: false,
          error: `Invalid jobs count: ${db.jobs}. Must be a positive integer`
        };
      }

      // Limit the number of jobs to a reasonable maximum
      if (db.jobs > 32) {
        return {
          valid: false,
          error: `Invalid jobs count: ${db.jobs}. Must not exceed 32`
        };
      }
    }

    // Validation du timeout
    if (db.backupTimeout !== undefined) {
      if (!Number.isInteger(db.backupTimeout) || db.backupTimeout < 1000) {
        return {
          valid: false,
          error: `Invalid backup timeout: ${db.backupTimeout}. Must be at least 1000ms (1 second)`
        };
      }

      // Limit the timeout to 24 hours maximum
      const maxTimeout = 24 * 60 * 60 * 1000; // 24 heures
      if (db.backupTimeout > maxTimeout) {
        return {
          valid: false,
          error: `Invalid backup timeout: ${db.backupTimeout}. Must not exceed 24 hours (${maxTimeout}ms)`
        };
      }
    }

    return { valid: true };
  }

  async executeBackup(db: DatabaseConfig): Promise<BackupResult> {
    const timestamp = new Date().toISOString();
    logger.info(`Starting backup`, db.name);

    // Validate the database configuration
    const validation = this.validateDatabaseConfig(db);
    if (!validation.valid) {
      const errorMsg = validation.error || 'Database configuration validation failed';
      logger.error(errorMsg, db.name);
      return {
        success: false,
        database: db.name,
        timestamp,
        error: errorMsg
      };
    }

    // Check that pg_dump is available and executable
    const verification = this.verifyPgDumpExecutable();
    if (!verification.valid) {
      const errorMsg = verification.error || 'pg_dump verification failed';
      logger.error(errorMsg, db.name);
      return {
        success: false,
        database: db.name,
        timestamp,
        error: errorMsg
      };
    }

    // Build the output path
    // If db.output is not defined or empty, use the default path
    let outputPath: string;
    if (!db.output || db.output.trim() === '') {
      // Use the default backup path
      outputPath = path.join(pathManager.backupsPath, `${db.id}.backup`);
    } else if (path.isAbsolute(db.output)) {
      // If it's an absolute path, check if it points to a directory or a file
      // Use the extension of the last segment (not includes('.') which matches .config, .local, etc.)
      const lastSegment = path.basename(db.output);
      if (lastSegment.includes('.') && !lastSegment.startsWith('.')) {
        // The last segment has an extension (e.g., backup.backup) — it's a file
        outputPath = db.output;
      } else {
        // It's a directory (or a hidden directory like .config), add the filename
        outputPath = path.join(db.output, `${db.id}.backup`);
      }
    } else {
      // Chemin relatif
      const fullPath = path.join(pathManager.appDataPath, db.output);
      const lastSegment = path.basename(db.output);
      if (lastSegment.includes('.') && !lastSegment.startsWith('.')) {
        // C'est un fichier
        outputPath = fullPath;
      } else {
        // C'est un dossier, ajouter le nom du fichier
        outputPath = path.join(fullPath, `${db.id}.backup`);
      }
    }

    // S'assurer que le dossier parent existe
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Check available disk space
    const diskSpaceCheck = await this.verifyDiskSpace(db, outputPath);
    if (!diskSpaceCheck.valid) {
      const errorMsg = diskSpaceCheck.error || 'Disk space verification failed';
      logger.error(errorMsg, db.name);
      return {
        success: false,
        database: db.name,
        timestamp,
        error: errorMsg
      };
    }

    // Add a timestamp to the filename
    const ext = path.extname(outputPath);
    const basename = path.basename(outputPath, ext);
    const dirname = path.dirname(outputPath);
    const timestampedPath = path.join(
      dirname,
      `${basename}_${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`
    );

    // Default configuration
    const compressionLevel = db.compressionLevel ?? 6;
    const jobs = db.jobs ?? 1;
    const timeout = db.backupTimeout ?? 30 * 60 * 1000; // 30 minutes by default

    // Trouver le pg_dump compatible avec la version du serveur
    const compatiblePgDump = await this.findCompatiblePgDump(db);

    // Check the pg_dump version to ensure it matches
    try {
      const { stdout } = await execAsync(`"${compatiblePgDump}" --version`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      if (versionMatch) {
        const pgDumpVersion = versionMatch[1];
        logger.info(`Using pg_dump version: ${pgDumpVersion}`, db.name);
      }
    } catch (error) {
      logger.warn(`Could not verify pg_dump version: ${getErrorMessage(error)}`, db.name);
    }

    return new Promise((resolve) => {
      // Build the pg_dump arguments
      const args = [
        '-F', 'c',
        '-b',
        '-v',
        '-f', timestampedPath,
      ];

      // If a connection string is provided, use it
      if (db.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(db.connectionString);
        args.push('-d', cleanedConnectionString);
      } else {
        const isLinux = process.platform === 'linux';
        const isLocalHost = db.host === 'localhost' || db.host === '127.0.0.1';
        const hasPassword = db.password && db.password.trim().length > 0;

        // On Linux with local host and no password, use Unix socket (peer auth)
        // pg_dump -h /var/run/postgresql uses peer auth, avoiding SCRAM password issues
        if (isLinux && isLocalHost && !hasPassword) {
          args.push('-h', '/var/run/postgresql');
        } else {
          args.push('-h', db.host);
        }
        args.push('-p', db.port.toString());
        args.push('-U', db.user);
        args.push(db.name);
      }

      // Add the compression level if > 0
      if (compressionLevel > 0) {
        args.push('-Z', compressionLevel.toString());
      }

      // Add parallelization if > 1
      if (jobs > 1) {
        args.push('--jobs', jobs.toString());
      }

      logger.info(`Command: ${compatiblePgDump} ${args.join(' ')}`, db.name);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C'
      };

      if (db.ssl) {
        env.PGSSLMODE = 'require';
        env.PGSSLCERT = 'disable'; // Accept self-signed certificates
      }

      // Add PGPASSWORD only if not using a connection string and if a password is provided
      // For local databases (isLocalBbdump), the password can be empty (peer/ident authentication)
      if (!db.connectionString && db.password && db.password.trim().length > 0) {
        env.PGPASSWORD = db.password;
      }

      const pgDump = spawn(compatiblePgDump, args, { env });
      this.activeProcesses.add(pgDump);

      let errorOutput = '';
      let isTimedOut = false;
      let isSignalKilled = false;
      let cleanedUp = false;

      // Fonction de nettoyage (idempotente)
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        this.activeProcesses.delete(pgDump);
        clearTimeout(timeoutHandle);
        clearTimeout(safetyTimeoutHandle);
        process.removeListener('SIGTERM' as any, signalHandler);
        process.removeListener('SIGINT' as any, signalHandler);
      };

      // Gestionnaire de signaux pour le processus parent
      const signalHandler = (signal: NodeJS.Signals) => {
        if (!pgDump.killed) {
          isSignalKilled = true;
          logger.warn(`Received ${signal}, killing pg_dump gracefully...`, db.name);
          pgDump.kill('SIGTERM');

          setTimeout(() => {
            if (!pgDump.killed) {
              logger.warn(`SIGTERM failed, using SIGKILL...`, db.name);
              pgDump.kill('SIGKILL');
            }
          }, 5000);
        }
      };

      // Gestionnaire de timeout
      const timeoutHandle = setTimeout(() => {
        if (!pgDump.killed) {
          isTimedOut = true;
          logger.warn(`Backup timeout reached (${timeout}ms), killing pg_dump...`, db.name);
          pgDump.kill('SIGTERM');

          // If SIGTERM doesn't work after 5 seconds, use SIGKILL
          setTimeout(() => {
            if (!pgDump.killed) {
              logger.warn(`SIGTERM failed, using SIGKILL...`, db.name);
              pgDump.kill('SIGKILL');
            }
          }, 5000);
        }
      }, timeout);

      // Safety timeout: ensures cleanup even if close never fires
      const safetyTimeoutHandle = setTimeout(() => {
        if (!cleanedUp) {
          logger.warn(`Safety timeout: cleaning up signal handlers for backup of ${db.name}`);
          cleanup();
          if (!pgDump.killed) {
            pgDump.kill('SIGKILL');
          }
          resolve({
            success: false,
            database: db.name,
            timestamp,
            error: 'Backup process did not respond (safety timeout)'
          });
        }
      }, timeout + 30000);

      // Listen for signals
      process.on('SIGTERM', signalHandler);
      process.on('SIGINT', signalHandler);

      pgDump.stderr.on('data', (data) => {
        const message = data.toString();
        errorOutput += message;
        logger.info(message.trim(), db.name);
      });

      pgDump.stdout.on('data', (data) => {
        logger.info(data.toString().trim(), db.name);
      });

      pgDump.on('error', (error) => {
        cleanup();
        const errorMsg = `Error launching pg_dump: ${error.message}`;
        logger.error(errorMsg, db.name);
        resolve({
          success: false,
          database: db.name,
          timestamp,
          error: errorMsg
        });
      });

      pgDump.on('close', async (code) => {
        cleanup();

        // Check if the process was killed by timeout or signal
        if (isTimedOut) {
          const errorMsg = `Backup timeout reached (${timeout}ms)`;
          logger.error(errorMsg, db.name);
          resolve({
            success: false,
            database: db.name,
            timestamp,
            error: errorMsg
          });
          return;
        }

        if (isSignalKilled) {
          const errorMsg = 'Backup interrupted by signal';
          logger.error(errorMsg, db.name);
          resolve({
            success: false,
            database: db.name,
            timestamp,
            error: errorMsg
          });
          return;
        }

        if (code === 0) {
          // If encryption is enabled, encrypt the file
          if (db.encryptBackups) {
            const encryptedPath = timestampedPath + '.encrypted';

            try {
              logger.info(`Encrypting backup file...`, db.name);

              // Encrypt the file
              await fileEncryptionManager.encryptFile(timestampedPath, encryptedPath);

              // Delete the unencrypted file
              try {
                fs.unlinkSync(timestampedPath);
              } catch (unlinkError) {
                logger.warn(`Failed to delete unencrypted backup: ${unlinkError}`, db.name);
                // Continue anyway to rename the encrypted file
              }

              // Rename the encrypted file
              try {
                fs.renameSync(encryptedPath, timestampedPath);
              } catch (renameError) {
                logger.error(`Failed to rename encrypted file: ${renameError}`, db.name);
                throw renameError;
              }

              const successMsg = `Backup successful and encrypted: ${timestampedPath}`;
              logger.info(successMsg, db.name);
              resolve({
                success: true,
                database: db.name,
                timestamp,
                message: successMsg,
                filePath: timestampedPath
              });
            } catch (encryptError) {
              const errorMsg = `Error during encryption: ${encryptError}`;
              logger.error(errorMsg, db.name);

              // Nettoyage des fichiers en cas d'erreur
              try {
                // Delete the partial encrypted file if it exists
                if (fs.existsSync(encryptedPath)) {
                  fs.unlinkSync(encryptedPath);
                  logger.info(`Cleaned up partial encrypted file: ${encryptedPath}`, db.name);
                }

                // Also delete the unencrypted file
                if (fs.existsSync(timestampedPath)) {
                  fs.unlinkSync(timestampedPath);
                  logger.info(`Cleaned up unencrypted backup file: ${timestampedPath}`, db.name);
                }
              } catch (cleanupError) {
                logger.warn(`Failed to cleanup files after encryption error: ${cleanupError}`, db.name);
              }

              resolve({
                success: false,
                database: db.name,
                timestamp,
                error: errorMsg
              });
            }
          } else {
            const successMsg = `Backup successful: ${timestampedPath}`;
            logger.info(successMsg, db.name);
            resolve({
              success: true,
              database: db.name,
              timestamp,
              message: successMsg,
              filePath: timestampedPath
            });
          }
        } else {
          const errorMsg = `pg_dump failed with code ${code}\n${errorOutput}`;
          logger.error(errorMsg, db.name);
          resolve({
            success: false,
            database: db.name,
            timestamp,
            error: errorMsg
          });
        }
      });
    });
  }

  async backupDatabase(db: DatabaseConfig): Promise<BackupResult> {
    try {
      return await this.executeBackup(db);
    } catch (error) {
      const errorMsg = `Unexpected error: ${error}`;
      logger.error(errorMsg, db.name);
      return {
        success: false,
        database: db.name,
        timestamp: new Date().toISOString(),
        error: errorMsg
      };
    }
  }

  /**
   * Run pg_restore for a specific section (pre-data, data, post-data).
   */
  private runPgRestoreSection(
    pgRestorePath: string,
    baseArgs: string[],
    env: NodeJS.ProcessEnv,
    section: 'pre-data' | 'data' | 'post-data',
    backupPath: string,
    targetName: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const args = [...baseArgs, `--section=${section}`, backupPath];
      logger.info(`[restore:${section}] pg_restore --section=${section}`, targetName);

      const proc = spawn(pgRestorePath, args, { env });
      this.activeProcesses.add(proc);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => {
        const m = d.toString();
        stdout += m;
        logger.info(m.trim(), targetName);
      });
      proc.stderr.on('data', (d) => {
        const m = d.toString();
        stderr += m;
        logger.info(m.trim(), targetName);
      });
      proc.on('error', (err) => {
        this.activeProcesses.delete(proc);
        resolve({ code: -1, stdout, stderr: stderr + err.message });
      });
      proc.on('close', (code) => {
        this.activeProcesses.delete(proc);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /**
   * Run a SQL command on the target database via psql (stdin piped).
   */
  private async runPsqlSql(
    target: { name: string; host: string; port: number; user: string; password: string; connectionString?: string },
    sql: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const psqlPath = await this.findPostgresCommand('psql');
    const args: string[] = [];

    if (target.connectionString) {
      const cleanedConnectionString = this.cleanConnectionString(target.connectionString);
      args.push('-d', cleanedConnectionString);
    } else {
      const isLinux = process.platform === 'linux';
      const isLocalHost = target.host === 'localhost' || target.host === '127.0.0.1';
      const hasPassword = target.password && target.password.trim().length > 0;
      if (isLinux && isLocalHost && !hasPassword) {
        args.push('-h', '/var/run/postgresql');
      } else {
        args.push('-h', target.host);
      }
      args.push('-p', target.port.toString(), '-U', target.user, '-d', target.name);
    }

    return new Promise((resolve) => {
      const proc = spawn(psqlPath, args, { env });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));

      proc.stdin.write(sql);
      proc.stdin.end();
    });
  }

  async restoreBackup(backupFile: string, target: { name: string; host: string; port: number; user: string; password: string; connectionString?: string }): Promise<BackupResult> {
    const timestamp = new Date().toISOString();
    logger.info(`Starting restore of ${backupFile} to ${target.name}`, target.name);

    // Accept both absolute paths and filenames (relative to backupsPath)
    const backupPath = path.isAbsolute(backupFile) ? backupFile : path.join(pathManager.backupsPath, backupFile);

    // Check that the file exists
    if (!fs.existsSync(backupPath)) {
      const errorMsg = `Backup file not found: ${backupPath}`;
      logger.error(errorMsg, target.name);
      return {
        success: false,
        database: target.name,
        timestamp,
        error: errorMsg
      };
    }

    // Check if the file is encrypted and decrypt it if needed
    let actualBackupPath = backupPath;
    let tempDecryptedPath: string | null = null;

    if (fileEncryptionManager.isFileEncrypted(backupPath)) {
      try {
        logger.info(`Decrypting backup file...`, target.name);
        tempDecryptedPath = path.join(pathManager.backupsPath, `temp_decrypt_${Date.now()}.backup`);
        await fileEncryptionManager.decryptFile(backupPath, tempDecryptedPath);
        actualBackupPath = tempDecryptedPath;
        logger.info(`File temporarily decrypted: ${tempDecryptedPath}`, target.name);
      } catch (decryptError) {
        const errorMsg = `Error during decryption: ${decryptError}`;
        logger.error(errorMsg, target.name);

        // Clean up the partial temporary file if needed
        if (tempDecryptedPath && fs.existsSync(tempDecryptedPath)) {
          try {
            fs.unlinkSync(tempDecryptedPath);
            logger.info(`Cleaned up partial decrypted file: ${tempDecryptedPath}`, target.name);
          } catch (cleanupError) {
            logger.warn(`Failed to cleanup partial decrypted file: ${cleanupError}`, target.name);
          }
        }

        return {
          success: false,
          database: target.name,
          timestamp,
          error: errorMsg
        };
      }
    }

    // Centralized cleanup function for the temporary file
    const cleanupTempFile = () => {
      if (tempDecryptedPath && fs.existsSync(tempDecryptedPath)) {
        try {
          fs.unlinkSync(tempDecryptedPath);
          logger.info(`Temporary decrypted file deleted: ${tempDecryptedPath}`, target.name);
        } catch (cleanupError) {
          logger.warn(`Unable to delete temporary file: ${cleanupError}`, target.name);
        }
      }
    };

    try {
      // Build common pg_restore args (without --section and backup file — added per section)
      const baseArgs = [
        '-v',
        '--no-owner',
        '--no-acl',
        '--no-tablespaces',
      ];

      // Build connection args
      if (target.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(target.connectionString);
        baseArgs.push('-d', cleanedConnectionString);
      } else {
        const isLinux = process.platform === 'linux';
        const isLocalHost = target.host === 'localhost' || target.host === '127.0.0.1';
        const hasPassword = target.password && target.password.trim().length > 0;
        if (isLinux && isLocalHost && !hasPassword) {
          baseArgs.push('-h', '/var/run/postgresql');
        } else {
          baseArgs.push('-h', target.host);
        }
        baseArgs.push('-p', target.port.toString());
        baseArgs.push('-U', target.user);
        baseArgs.push('-d', target.name);
      }

      const compatiblePgRestorePath = await this.findCompatiblePgRestore(actualBackupPath);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
      };

      if (target.connectionString && target.connectionString.includes('sslmode=require')) {
        env.PGSSLMODE = 'require';
        env.PGSSLCERT = 'disable';
      }

      if (!target.connectionString && target.password && target.password.trim().length > 0) {
        env.PGPASSWORD = target.password;
      }

      let allStdout = '';
      let allStderr = '';

      // ──────────────────────────────────────────────────────────────────
      // Multi-section restore: pre-data → drop CHECK → data → recreate CHECK → post-data
      //
      // CHECK constraints that call functions referencing other tables cause
      // COPY failures when pg_restore loads data in TOC order (the referenced
      // table may not have data yet). Temporarily dropping CHECK constraints
      // around the data loading phase solves this.
      // ──────────────────────────────────────────────────────────────────

      // STEP 1: Restore schema (tables, types, functions, CHECK constraints)
      logger.info(`[restore] Step 1/5: Restoring schema (pre-data)...`, target.name);
      const preData = await this.runPgRestoreSection(
        compatiblePgRestorePath, baseArgs, env, 'pre-data', actualBackupPath, target.name,
      );
      allStdout += preData.stdout;
      allStderr += preData.stderr;

      if (preData.stderr.includes('FATAL')) {
        cleanupTempFile();
        return {
          success: false,
          database: target.name,
          timestamp,
          error: `pg_restore pre-data failed with FATAL error:\n${preData.stderr}`,
          output: preData.stdout + preData.stderr,
        };
      }

      // STEP 2: Drop CHECK constraints (save definitions in a helper table)
      logger.info(`[restore] Step 2/5: Temporarily dropping CHECK constraints...`, target.name);
      const dropCheckSql = `
        CREATE TABLE IF NOT EXISTS _bbdump_saved_checks (
          table_name text,
          constraint_name text,
          definition text
        );
        TRUNCATE _bbdump_saved_checks;
        INSERT INTO _bbdump_saved_checks
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE contype = 'c'
          AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
        DO $$ DECLARE r RECORD; dropped int := 0; BEGIN
          FOR r IN SELECT table_name, constraint_name FROM _bbdump_saved_checks LOOP
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.constraint_name);
            dropped := dropped + 1;
          END LOOP;
          RAISE NOTICE 'Dropped % CHECK constraint(s)', dropped;
        END $$;
      `;
      const dropResult = await this.runPsqlSql(target, dropCheckSql, env);
      if (dropResult.code !== 0) {
        logger.warn(`[restore] Warning: could not drop CHECK constraints: ${dropResult.stderr}`, target.name);
      } else {
        logger.info(`[restore] CHECK constraints temporarily dropped`, target.name);
      }

      // STEP 3: Load data (with triggers disabled to bypass FK constraint triggers)
      logger.info(`[restore] Step 3/5: Loading data...`, target.name);
      const dataArgs = [...baseArgs, '--disable-triggers'];
      const dataResult = await this.runPgRestoreSection(
        compatiblePgRestorePath, dataArgs, env, 'data', actualBackupPath, target.name,
      );
      allStdout += dataResult.stdout;
      allStderr += dataResult.stderr;

      // STEP 4: Recreate CHECK constraints from saved definitions
      logger.info(`[restore] Step 4/5: Recreating CHECK constraints...`, target.name);
      const recreateCheckSql = `
        DO $$ DECLARE r RECORD; recreated int := 0; BEGIN
          FOR r IN SELECT table_name, constraint_name, definition FROM _bbdump_saved_checks LOOP
            BEGIN
              EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.table_name, r.constraint_name, r.definition);
              recreated := recreated + 1;
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'Could not recreate constraint % on %: %', r.constraint_name, r.table_name, SQLERRM;
            END;
          END LOOP;
          RAISE NOTICE 'Recreated % CHECK constraint(s)', recreated;
        END $$;
        DROP TABLE IF EXISTS _bbdump_saved_checks;
      `;
      const recreateResult = await this.runPsqlSql(target, recreateCheckSql, env);
      if (recreateResult.code !== 0) {
        logger.warn(`[restore] Warning: could not recreate some CHECK constraints: ${recreateResult.stderr}`, target.name);
      } else {
        logger.info(`[restore] CHECK constraints recreated`, target.name);
      }

      // STEP 5: Restore indexes and foreign keys (post-data)
      logger.info(`[restore] Step 5/5: Creating indexes and foreign keys (post-data)...`, target.name);
      const postData = await this.runPgRestoreSection(
        compatiblePgRestorePath, baseArgs, env, 'post-data', actualBackupPath, target.name,
      );
      allStdout += postData.stdout;
      allStderr += postData.stderr;

      // Cleanup temp decrypted file
      cleanupTempFile();

      // ── Aggregate results ──
      const combinedOutput = allStdout + allStderr;

      const nonCriticalErrorPatterns = [
        /unrecognized configuration parameter/i,
        /transaction_timeout/i,
        /does not exist/i,
        /already exists/i,
        /permission denied/i,
        /role.*does not exist/i,
        /errors ignored on restore/i,
        /erreurs ignorées lors de la restauration/i,
      ];

      const hasCriticalError = allStderr.includes('FATAL') ||
        (allStderr.includes('ERROR') &&
          !nonCriticalErrorPatterns.some(pattern => pattern.test(allStderr)));

      const hasRestoreActivity =
        combinedOutput.includes('CREATE TABLE') ||
        combinedOutput.includes('CREATE INDEX') ||
        combinedOutput.includes('CREATE SEQUENCE') ||
        combinedOutput.includes('CREATE FUNCTION') ||
        combinedOutput.includes('processing data for table') ||
        combinedOutput.includes('COPY ') ||
        combinedOutput.includes('INSERT INTO') ||
        combinedOutput.includes('ALTER TABLE') ||
        combinedOutput.includes('création de TABLE') ||
        combinedOutput.includes('traitement des données de la table');

      const errorsIgnored = combinedOutput.includes('errors ignored on restore') ||
        combinedOutput.includes('erreurs ignorées lors de la restauration');

      const allSucceeded = preData.code === 0 && dataResult.code === 0 && postData.code === 0;

      if (allSucceeded) {
        const successMsg = `Restore successful from ${backupFile} to ${target.name}`;
        logger.info(successMsg, target.name);
        return {
          success: true,
          database: target.name,
          timestamp,
          message: successMsg,
          output: combinedOutput,
        };
      } else if ((hasRestoreActivity || errorsIgnored) && !hasCriticalError) {
        const successMsg = `Restore completed${errorsIgnored ? ' (some errors were ignored)' : ' with warnings'} from ${backupFile} to ${target.name}`;
        logger.info(successMsg, target.name);
        if (allStderr && !hasCriticalError) {
          logger.warn(`Non-critical warnings during restore (ignored): ${allStderr.substring(0, 500)}`, target.name);
        }
        return {
          success: true,
          database: target.name,
          timestamp,
          message: successMsg,
          output: combinedOutput,
        };
      } else {
        const errorMsg = `pg_restore failed${hasRestoreActivity ? ' (partial restore)' : ''}\n${allStderr}`;
        logger.error(errorMsg, target.name);
        return {
          success: false,
          database: target.name,
          timestamp,
          error: errorMsg,
          output: combinedOutput,
        };
      }
    } catch (err: any) {
      cleanupTempFile();
      return {
        success: false,
        database: target.name,
        timestamp,
        error: `Restore failed: ${err.message}`,
      };
    }
  }
}

export const backupManager = new BackupManager();

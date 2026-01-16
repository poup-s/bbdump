import { spawn, exec } from 'child_process';
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
  private allPgDumpVersions: PgDumpVersion[] = []; // Toutes les versions trouvées
  private pgRestoreVersionsCache: Map<string, PgDumpVersion[]> = new Map(); // Cache par version majeure pour pg_restore
  private allPgRestoreVersions: PgDumpVersion[] = []; // Toutes les versions de pg_restore trouvées
  private versionsDetected: boolean = false;
  private pgRestoreVersionsDetected: boolean = false;

  constructor() {
    this.backupDir = pathManager.backupsPath;
    // Les chemins seront résolus de manière asynchrone lors de la première utilisation
    // Pour l'instant, utiliser les noms de commandes (seront résolus via PATH)
    this.pgDumpPath = 'pg_dump';
    this.pgRestorePath = 'pg_restore';
    this.ensureBackupDir();

    // Initialiser les chemins de manière asynchrone (ne pas attendre)
    this.initializePaths().catch((error) => {
      logger.warn(`Failed to initialize PostgreSQL paths: ${error.message}`);
    });

    // Détecter toutes les versions disponibles au démarrage
    this.detectAllPgDumpVersions().catch((error) => {
      logger.warn(`Failed to detect all pg_dump versions: ${error.message}`);
    });

    // Détecter toutes les versions de pg_restore disponibles au démarrage
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
    } catch (error: any) {
      logger.warn(`Failed to initialize PostgreSQL paths: ${error.message}`);
    }
  }

  /**
   * Détecte toutes les versions de pg_dump disponibles sur le système
   */
  private async detectAllPgDumpVersions(): Promise<void> {
    if (this.versionsDetected) {
      return; // Déjà détecté
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

      // Ajouter aussi la version système (dans PATH)
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
      } catch (error) {
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
    } catch (error: any) {
      logger.error(`Error detecting pg_dump versions: ${error.message}`);
    }
  }

  /**
   * Détecte toutes les versions de pg_restore disponibles sur le système
   */
  private async detectAllPgRestoreVersions(): Promise<void> {
    if (this.pgRestoreVersionsDetected) {
      return; // Déjà détecté
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

      // Ajouter aussi la version système (dans PATH)
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
      } catch (error) {
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
    } catch (error: any) {
      logger.error(`Error detecting pg_restore versions: ${error.message}`);
    }
  }

  /**
   * Détecte les versions de pg_restore dans Homebrew (macOS)
   */
  private async detectHomebrewPgRestoreVersions(versions: PgDumpVersion[]): Promise<void> {
    const homebrewPrefixes = ['/opt/homebrew', '/usr/local'];

    for (const prefix of homebrewPrefixes) {
      // Chercher dans libpq (client)
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
        } catch (error) {
          // Ignore
        }
      }

      // Chercher dans postgresql@* (serveur complet)
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
        } catch (error) {
          // Ignore
        }
      }

      // Chercher aussi dans /opt (liens symboliques)
      const optPath = `${prefix}/opt`;
      if (fs.existsSync(optPath)) {
        try {
          const dirs = fs.readdirSync(optPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const pgRestorePath = `${optPath}/${dir}/bin/pg_restore`;
            if (fs.existsSync(pgRestorePath)) {
              const version = await this.getPgRestoreVersion(pgRestorePath);
              if (version) {
                // Vérifier si on ne l'a pas déjà ajouté
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
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  /**
   * Détecte les versions de pg_restore sur Linux
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
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  /**
   * Détecte les versions dans Homebrew (macOS)
   */
  private async detectHomebrewVersions(versions: PgDumpVersion[]): Promise<void> {
    const homebrewPrefixes = ['/opt/homebrew', '/usr/local'];

    for (const prefix of homebrewPrefixes) {
      // Chercher dans libpq (client)
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
        } catch (error) {
          // Ignore
        }
      }

      // Chercher dans postgresql@* (serveur complet)
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
        } catch (error) {
          // Ignore
        }
      }

      // Chercher aussi dans /opt (liens symboliques)
      const optPath = `${prefix}/opt`;
      if (fs.existsSync(optPath)) {
        try {
          const dirs = fs.readdirSync(optPath).filter(dir => dir.startsWith('postgresql@'));
          for (const dir of dirs) {
            const pgDumpPath = `${optPath}/${dir}/bin/pg_dump`;
            if (fs.existsSync(pgDumpPath)) {
              const version = await this.getPgDumpVersion(pgDumpPath);
              if (version) {
                // Vérifier si on ne l'a pas déjà ajouté
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
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  /**
   * Détecte les versions sur Linux
   */
  private async detectLinuxVersions(versions: PgDumpVersion[]): Promise<void> {
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
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  /**
   * Obtient la version d'un pg_dump en l'exécutant
   */
  private async getPgDumpVersion(pgDumpPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${pgDumpPath}" --version 2>&1`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Obtient la version d'un pg_restore en l'exécutant
   */
  private async getPgRestoreVersion(pgRestorePath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`"${pgRestorePath}" --version 2>&1`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Détecte la version d'un fichier de backup PostgreSQL
   * Le format custom commence par "PGDMP" suivi de la version majeure et mineure
   */
  private detectBackupVersion(backupPath: string): { major: number; minor: number } | null {
    try {
      const fd = fs.openSync(backupPath, 'r');
      const buffer = Buffer.alloc(10);
      fs.readSync(fd, buffer, 0, 10, 0);
      fs.closeSync(fd);

      // Vérifier le magic number "PGDMP"
      const magic = buffer.toString('ascii', 0, 5);
      if (magic !== 'PGDMP') {
        return null; // Pas un fichier de backup custom
      }

      // Lire la version majeure et mineure (octets 5 et 6)
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

  /**
   * Nettoie la connection string en retirant les paramètres non supportés par pg_dump
   */
  private cleanConnectionString(connectionString: string): string {
    try {
      // Liste des paramètres non supportés ou problématiques avec pg_dump
      const unsupportedParams = [
        'channel_binding',
        'target_session_attrs'
      ];

      // Parser l'URL
      const url = new URL(connectionString);

      // Nettoyer les paramètres
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
    // Utiliser le module centralisé toolDetector
    const { findPostgresCommand: findCommand } = await import('./tools/toolDetector');
    return findCommand(command);
  }

  /**
   * Détecte la version du serveur PostgreSQL et trouve le pg_dump correspondant
   * Utilise le cache des versions détectées pour une recherche rapide
   */
  private async findCompatiblePgDump(db: DatabaseConfig): Promise<string> {
    logger.info(`Finding compatible pg_dump for database: ${db.name}`, db.name);

    // S'assurer que les versions sont détectées
    if (!this.versionsDetected) {
      await this.detectAllPgDumpVersions();
    }

    try {
      // Détecter la version du serveur PostgreSQL
      let serverVersion: string | null = null;
      let serverMajorVersion: string | null = null;

      try {
        const { Client } = await import('pg');
        const client = new Client({
          host: db.host,
          port: db.port,
          user: db.user,
          password: db.password || '',
          database: db.connectionString ? undefined : (db.name || 'postgres'),
          connectionString: db.connectionString,
          ssl: db.ssl,
          connectionTimeoutMillis: 5000
        });

        await client.connect();
        try {
          const result = await client.query('SELECT version()');
          const versionMatch = result.rows[0]?.version?.match(/PostgreSQL (\d+\.\d+)/);
          if (versionMatch && versionMatch[1]) {
            const detectedVersion = versionMatch[1];
            serverVersion = detectedVersion;
            serverMajorVersion = detectedVersion.split('.')[0];
            logger.info(`Detected PostgreSQL server version: ${detectedVersion}`, db.name);
          } else {
            logger.warn(`Could not parse PostgreSQL version from: ${result.rows[0]?.version || 'unknown'}`, db.name);
          }
        } finally {
          await client.end();
        }
      } catch (error: any) {
        logger.warn(`Could not detect server version: ${error.message}`, db.name);
      }

      // Si on a détecté une version, utiliser le cache pour trouver le pg_dump compatible
      if (serverMajorVersion && this.pgDumpVersionsCache.has(serverMajorVersion)) {
        const compatibleVersions = this.pgDumpVersionsCache.get(serverMajorVersion)!;

        // Préférer les versions exactes ou les plus proches
        // Trier par préférence : postgresql > libpq > system
        const sortedVersions = compatibleVersions.sort((a, b) => {
          const sourcePriority = { 'postgresql': 1, 'libpq': 2, 'system': 3 };
          return (sourcePriority[a.source] || 99) - (sourcePriority[b.source] || 99);
        });

        // Prendre la première version compatible (meilleure correspondance)
        const bestMatch = sortedVersions[0];
        logger.info(`Found compatible pg_dump ${bestMatch.version} for PostgreSQL ${serverVersion}: ${bestMatch.path} (${bestMatch.source})`, db.name);
        return bestMatch.path;
      }

      // Si pas trouvé dans le cache, essayer une recherche dynamique (fallback)
      if (serverMajorVersion) {
        logger.warn(`No cached pg_dump found for PostgreSQL ${serverVersion}, performing dynamic search...`, db.name);
        // Re-détecter les versions au cas où de nouvelles versions auraient été installées
        await this.detectAllPgDumpVersions();

        if (this.pgDumpVersionsCache.has(serverMajorVersion)) {
          const compatibleVersions = this.pgDumpVersionsCache.get(serverMajorVersion)!;
          const bestMatch = compatibleVersions[0];
          logger.info(`Found compatible pg_dump ${bestMatch.version} for PostgreSQL ${serverVersion}: ${bestMatch.path}`, db.name);
          return bestMatch.path;
        }

        logger.warn(`Could not find pg_dump for PostgreSQL ${serverVersion} (major: ${serverMajorVersion})`, db.name);
        logger.warn(`Available versions: ${Array.from(this.pgDumpVersionsCache.keys()).join(', ') || 'none'}`, db.name);
        logger.warn(`This may cause version mismatch errors. Please install pg_dump version ${serverMajorVersion}.x`, db.name);
      } else {
        logger.warn(`Server version not detected, using default pg_dump: ${this.pgDumpPath}`, db.name);
        if (this.allPgDumpVersions.length > 0) {
          logger.info(`Available pg_dump versions: ${this.allPgDumpVersions.map(v => v.version).join(', ')}`, db.name);
        }
      }
    } catch (error: any) {
      logger.error(`Error finding compatible pg_dump: ${error.message}`, db.name);
    }

    // Fallback: utiliser le pg_dump par défaut
    logger.info(`Using default pg_dump: ${this.pgDumpPath}`, db.name);
    return this.pgDumpPath;
  }

  /**
   * Trouve une version compatible de pg_restore basée sur la version du backup
   */
  private async findCompatiblePgRestore(backupPath: string): Promise<string> {
    // S'assurer que les versions sont détectées
    if (!this.pgRestoreVersionsDetected) {
      await this.detectAllPgRestoreVersions();
    }

    // Détecter la version du backup
    const backupVersion = this.detectBackupVersion(backupPath);
    if (!backupVersion) {
      logger.warn(`Could not detect backup version, using default pg_restore: ${this.pgRestorePath}`);
      return this.pgRestorePath;
    }

    logger.info(`Detected backup version: ${backupVersion.major}.${backupVersion.minor}`);

    // Chercher une version compatible de pg_restore
    // pg_restore peut lire les backups créés avec la même version majeure ou supérieure
    const backupMajorVersion = backupVersion.major.toString();

    // Chercher d'abord une version exacte ou supérieure
    const compatibleVersions: PgDumpVersion[] = [];

    // Parcourir toutes les versions majeures >= à la version du backup
    for (const [majorVersion, versions] of this.pgRestoreVersionsCache.entries()) {
      const major = parseInt(majorVersion, 10);
      if (major >= backupVersion.major) {
        compatibleVersions.push(...versions);
      }
    }

    if (compatibleVersions.length > 0) {
      // Trier par version décroissante (la plus récente d'abord)
      // pg_restore est rétro-compatible, donc la version la plus récente est toujours le meilleur choix
      compatibleVersions.sort((a, b) => {
        // Comparer les versions majeures
        const aMajor = parseInt(a.majorVersion, 10);
        const bMajor = parseInt(b.majorVersion, 10);
        if (aMajor !== bMajor) {
          return bMajor - aMajor; // Décroissant
        }

        // Si même version majeure, comparer les versions complètes (approximatif mais suffisant)
        if (a.version !== b.version) {
          return b.version.localeCompare(a.version, undefined, { numeric: true });
        }

        // Si même version, préférer postgresql > libpq > system
        const sourcePriority = { 'postgresql': 1, 'libpq': 2, 'system': 3 };
        return (sourcePriority[a.source] || 99) - (sourcePriority[b.source] || 99);
      });

      const bestMatch = compatibleVersions[0];
      logger.info(`Found compatible pg_restore ${bestMatch.version} for backup version ${backupVersion.major}.${backupVersion.minor}: ${bestMatch.path} (${bestMatch.source})`);
      return bestMatch.path;
    }

    // Si aucune version compatible trouvée, utiliser le défaut
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
      // Vérifier que le fichier existe
      if (!fs.existsSync(this.pgDumpPath)) {
        return {
          valid: false,
          error: `pg_dump not found at path: ${this.pgDumpPath}`
        };
      }

      // Vérifier que le fichier est exécutable
      try {
        fs.accessSync(this.pgDumpPath, fs.constants.X_OK);
      } catch (error) {
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
      // Résoudre le chemin absolu
      const absolutePath = path.isAbsolute(targetPath)
        ? targetPath
        : path.join(pathManager.appDataPath, targetPath);

      // Obtenir le répertoire parent si c'est un fichier
      const dirPath = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
        ? absolutePath
        : path.dirname(absolutePath);

      // Utiliser df pour obtenir l'espace disque (compatible macOS et Linux)
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
      // Utiliser psql pour obtenir la taille de la base de données
      const args = [
        '-t', // Mode tuples seulement (sans en-têtes)
        '-c', `SELECT pg_database_size('${db.name.replace(/'/g, "''")}');`
      ];

      // Si une connection string est fournie, l'utiliser
      if (db.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(db.connectionString);
        args.unshift('-d', cleanedConnectionString);
      } else {
        // Sinon, utiliser les paramètres individuels
        args.unshift('-h', db.host);
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

      // Ajouter PGPASSWORD uniquement si on n'utilise pas de connection string et si un mot de passe est fourni
      // Pour les bases locales (isLocalBbdump), le mot de passe peut être vide (authentification peer/ident)
      if (!db.connectionString && db.password && db.password.trim().length > 0) {
        env.PGPASSWORD = db.password;
      }

      const { stdout } = await execAsync(
        `"${this.findPostgresCommand('psql')}" ${args.map(arg => `"${arg}"`).join(' ')}`,
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
      // Vérifier l'espace disque disponible
      const diskSpace = await this.checkDiskSpace(outputPath);

      if (!diskSpace) {
        // Si on ne peut pas vérifier l'espace, on continue avec un warning
        logger.warn('Unable to verify disk space, proceeding with backup', db.name);
        return { valid: true };
      }

      logger.info(`Disk space available: ${this.formatBytes(diskSpace.available)} / ${this.formatBytes(diskSpace.total)}`, db.name);

      // Essayer d'estimer la taille de la base de données
      const estimatedSize = await this.estimateDatabaseSize(db);

      if (estimatedSize) {
        logger.info(`Estimated database size: ${this.formatBytes(estimatedSize)}`, db.name);

        // Calculer l'espace nécessaire avec une marge de sécurité
        // pg_dump avec compression produit généralement des fichiers entre 5% et 20% de la taille originale
        // Utiliser la même logique que executeBackup pour le niveau de compression
        const compressionLevel = db.compressionLevel ?? 6; // Par défaut niveau 6, comme dans executeBackup

        let compressionFactor: number;

        if (compressionLevel > 0) {
          // Avec compression (format custom -F c -Z N)
          // Facteur de compression observé : ~8-15% pour des données textuelles
          // On utilise 15% comme estimation conservatrice
          compressionFactor = 0.15;
        } else {
          // Sans compression explicite (niveau 0)
          // Le format custom compresse quand même légèrement
          compressionFactor = 0.35;
        }

        // Ajouter une marge de sécurité supplémentaire de 50%
        const requiredSpace = estimatedSize * compressionFactor * 1.5;

        logger.info(`Compression level: ${compressionLevel}, factor: ${compressionFactor * 100}%, required space (with 50% margin): ${this.formatBytes(requiredSpace)}`, db.name);

        if (diskSpace.available < requiredSpace) {
          return {
            valid: false,
            error: `Insufficient disk space. Available: ${this.formatBytes(diskSpace.available)}, Required: ${this.formatBytes(requiredSpace)}`
          };
        }
      } else {
        // Si on ne peut pas estimer la taille, vérifier qu'il y a au moins 1 Go disponible
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
      // En cas d'erreur, on continue avec un warning plutôt que de bloquer
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
    // Validation du port
    if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) {
      return {
        valid: false,
        error: `Invalid port number: ${db.port}. Must be between 1 and 65535`
      };
    }

    // Validation du nom de la base de données (pas de caractères dangereux)
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

    // Validation du host (bloquer les caractères suspects)
    if (dangerousChars.test(db.host)) {
      return {
        valid: false,
        error: `Host contains dangerous characters: ${db.host}`
      };
    }

    // Validation du chemin de sortie contre path traversal
    const normalizedPath = path.normalize(db.output);

    // Bloquer les tentatives de path traversal
    if (normalizedPath.includes('..')) {
      return {
        valid: false,
        error: `Output path contains path traversal attempt: ${db.output}`
      };
    }

    // Bloquer les chemins absolus suspects (sauf s'ils sont dans des répertoires autorisés)
    if (path.isAbsolute(db.output)) {
      const outputDir = path.dirname(db.output);
      const appDataPath = pathManager.appDataPath;
      const backupsPath = pathManager.backupsPath;
      const homeDir = require('os').homedir();

      // Vérifier que le chemin absolu commence par un répertoire autorisé
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

    // Vérifier que le nom de fichier ne contient pas de caractères null
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

      // Limiter le nombre de jobs à un maximum raisonnable
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

      // Limiter le timeout à 24 heures maximum
      const maxTimeout = 24 * 60 * 60 * 1000; // 24 heures
      if (db.backupTimeout > maxTimeout) {
        return {
          valid: false,
          error: `Invalid backup timeout: ${db.backupTimeout}. Must not exceed 24 hours (${maxTimeout}ms)`
        };
      }
    }

    // Validation des champs requis
    if (!db.name || db.name.trim().length === 0) {
      return {
        valid: false,
        error: 'Database name is required'
      };
    }

    if (!db.host || db.host.trim().length === 0) {
      return {
        valid: false,
        error: 'Host is required'
      };
    }

    if (!db.user || db.user.trim().length === 0) {
      return {
        valid: false,
        error: 'Username is required'
      };
    }

    // Pour les bases locales créées par bbdump, le mot de passe peut être vide
    // (connexion via ident/peer authentication)
    if (!db.isLocalBbdump && (!db.password || db.password.trim().length === 0)) {
      return {
        valid: false,
        error: 'Password is required'
      };
    }

    if (!db.output || db.output.trim().length === 0) {
      return {
        valid: false,
        error: 'Output path is required'
      };
    }

    return { valid: true };
  }

  async executeBackup(db: DatabaseConfig): Promise<BackupResult> {
    const timestamp = new Date().toISOString();
    logger.info(`Starting backup`, db.name);

    // Valider la configuration de la base de données
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

    // Vérifier que pg_dump est disponible et exécutable
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

    // Construire le chemin de sortie
    // Si db.output n'est pas défini ou vide, utiliser le chemin par défaut
    let outputPath: string;
    if (!db.output || db.output.trim() === '') {
      // Utiliser le chemin par défaut des backups
      outputPath = path.join(pathManager.backupsPath, `${db.name}.backup`);
    } else if (path.isAbsolute(db.output)) {
      // Si c'est un chemin absolu, vérifier s'il pointe vers un dossier ou un fichier
      if (db.output.endsWith('.backup') || db.output.includes('.')) {
        // C'est un fichier
        outputPath = db.output;
      } else {
        // C'est un dossier, ajouter le nom du fichier
        outputPath = path.join(db.output, `${db.name}.backup`);
      }
    } else {
      // Chemin relatif
      const fullPath = path.join(pathManager.appDataPath, db.output);
      if (db.output.endsWith('.backup') || db.output.includes('.')) {
        // C'est un fichier
        outputPath = fullPath;
      } else {
        // C'est un dossier, ajouter le nom du fichier
        outputPath = path.join(fullPath, `${db.name}.backup`);
      }
    }

    // S'assurer que le dossier parent existe
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Vérifier l'espace disque disponible
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

    // Ajouter un timestamp au nom du fichier
    const ext = path.extname(outputPath);
    const basename = path.basename(outputPath, ext);
    const dirname = path.dirname(outputPath);
    const timestampedPath = path.join(
      dirname,
      `${basename}_${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`
    );

    // Configuration par défaut
    const compressionLevel = db.compressionLevel ?? 6;
    const jobs = db.jobs ?? 1;
    const timeout = db.backupTimeout ?? 30 * 60 * 1000; // 30 minutes par défaut

    // Trouver le pg_dump compatible avec la version du serveur
    const compatiblePgDump = await this.findCompatiblePgDump(db);

    // Vérifier la version de pg_dump pour s'assurer qu'elle correspond
    try {
      const { stdout } = await execAsync(`"${compatiblePgDump}" --version`);
      const versionMatch = stdout.match(/(\d+\.\d+)/);
      if (versionMatch) {
        const pgDumpVersion = versionMatch[1];
        logger.info(`Using pg_dump version: ${pgDumpVersion}`, db.name);
      }
    } catch (error: any) {
      logger.warn(`Could not verify pg_dump version: ${error.message}`, db.name);
    }

    return new Promise((resolve) => {
      // Construire les arguments pg_dump
      const args = [
        '-F', 'c',
        '-b',
        '-v',
        '-f', timestampedPath,
      ];

      // Si une connection string est fournie, l'utiliser
      if (db.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(db.connectionString);
        args.push('-d', cleanedConnectionString);
      } else {
        // Sinon, utiliser les paramètres individuels
        args.push('-h', db.host);
        args.push('-p', db.port.toString());
        args.push('-U', db.user);
        args.push(db.name);
      }

      // Ajouter le niveau de compression si > 0
      if (compressionLevel > 0) {
        args.push('-Z', compressionLevel.toString());
      }

      // Ajouter la parallélisation si > 1
      if (jobs > 1) {
        args.push('--jobs', jobs.toString());
      }

      logger.info(`Command: ${compatiblePgDump} ${args.join(' ')}`, db.name);

      const env: NodeJS.ProcessEnv = {
        ...process.env
      };

      if (db.ssl) {
        env.PGSSLMODE = 'require';
        env.PGSSLCERT = 'disable'; // Accept self-signed certificates
      }

      // Ajouter PGPASSWORD uniquement si on n'utilise pas de connection string et si un mot de passe est fourni
      // Pour les bases locales (isLocalBbdump), le mot de passe peut être vide (authentification peer/ident)
      if (!db.connectionString && db.password && db.password.trim().length > 0) {
        env.PGPASSWORD = db.password;
      }

      const pgDump = spawn(compatiblePgDump, args, { env });

      let errorOutput = '';
      let isTimedOut = false;
      let isSignalKilled = false;

      // Gestionnaire de timeout
      const timeoutHandle = setTimeout(() => {
        if (!pgDump.killed) {
          isTimedOut = true;
          logger.warn(`Backup timeout reached (${timeout}ms), killing pg_dump...`, db.name);
          pgDump.kill('SIGTERM');

          // Si SIGTERM ne fonctionne pas après 5 secondes, utiliser SIGKILL
          setTimeout(() => {
            if (!pgDump.killed) {
              logger.warn(`SIGTERM failed, using SIGKILL...`, db.name);
              pgDump.kill('SIGKILL');
            }
          }, 5000);
        }
      }, timeout);

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

      // Écouter les signaux
      process.on('SIGTERM', signalHandler);
      process.on('SIGINT', signalHandler);

      // Fonction de nettoyage
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        process.removeListener('SIGTERM' as any, signalHandler);
        process.removeListener('SIGINT' as any, signalHandler);
      };

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

        // Vérifier si le processus a été tué par timeout ou signal
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
          // Si le chiffrement est activé, chiffrer le fichier
          if (db.encryptBackups) {
            const encryptedPath = timestampedPath + '.encrypted';

            try {
              logger.info(`Encrypting backup file...`, db.name);

              // Chiffrer le fichier
              await fileEncryptionManager.encryptFile(timestampedPath, encryptedPath);

              // Supprimer le fichier non chiffré
              try {
                fs.unlinkSync(timestampedPath);
              } catch (unlinkError) {
                logger.warn(`Failed to delete unencrypted backup: ${unlinkError}`, db.name);
                // Continue quand même pour renommer le fichier chiffré
              }

              // Renommer le fichier chiffré
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
                message: successMsg
              });
            } catch (encryptError) {
              const errorMsg = `Error during encryption: ${encryptError}`;
              logger.error(errorMsg, db.name);

              // Nettoyage des fichiers en cas d'erreur
              try {
                // Supprimer le fichier chiffré partiel s'il existe
                if (fs.existsSync(encryptedPath)) {
                  fs.unlinkSync(encryptedPath);
                  logger.info(`Cleaned up partial encrypted file: ${encryptedPath}`, db.name);
                }

                // Supprimer le fichier non chiffré également
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
              message: successMsg
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

  async restoreBackup(backupFile: string, target: { name: string; host: string; port: number; user: string; password: string; connectionString?: string }): Promise<BackupResult> {
    const timestamp = new Date().toISOString();
    logger.info(`Starting restore of ${backupFile} to ${target.name}`, target.name);

    const backupPath = path.join(pathManager.backupsPath, backupFile);

    // Vérifier que le fichier existe
    if (!fs.existsSync(backupPath)) {
      const errorMsg = `Backup file not found: ${backupFile}`;
      logger.error(errorMsg, target.name);
      return {
        success: false,
        database: target.name,
        timestamp,
        error: errorMsg
      };
    }

    // Vérifier si le fichier est chiffré et le déchiffrer si nécessaire
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

        // Nettoyer le fichier temporaire partiel si nécessaire
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

    return new Promise(async (resolve) => {
      // Fonction de nettoyage centralisée pour le fichier temporaire
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
      const args = [
        '-v',
        '--no-owner', // Ne pas restaurer les propriétaires (évite les erreurs de permissions)
        '--no-acl', // Ne pas restaurer les ACLs (évite les erreurs de permissions)
        '--no-tablespaces', // Ne pas restaurer les tablespaces (évite les tablespaces n'existent pas)
        // Ne pas utiliser --exit-on-error car cela arrête la restauration dès la première erreur non critique
      ];

      // Si une connection string est fournie, l'utiliser
      if (target.connectionString) {
        const cleanedConnectionString = this.cleanConnectionString(target.connectionString);
        args.push('-d', cleanedConnectionString);
      } else {
        // Sinon, utiliser les paramètres individuels
        args.push('-h', target.host);
        args.push('-p', target.port.toString());
        args.push('-U', target.user);
        args.push('-d', target.name);
      }

      // Ajouter le fichier de backup à la fin
      args.push(actualBackupPath);

      // Trouver la version compatible de pg_restore basée sur la version du backup
      const compatiblePgRestorePath = await this.findCompatiblePgRestore(actualBackupPath);

      logger.info(`Command: ${compatiblePgRestorePath} ${args.join(' ')}`, target.name);

      const env: NodeJS.ProcessEnv = {
        ...process.env
      };

      // Support SSL avec certificats auto-signés
      if (target.connectionString && target.connectionString.includes('sslmode=require')) {
        env.PGSSLMODE = 'require';
        env.PGSSLCERT = 'disable'; // Accept self-signed certificates
      }

      // Ajouter PGPASSWORD uniquement si on n'utilise pas de connection string et si un mot de passe est fourni
      if (!target.connectionString && target.password && target.password.trim().length > 0) {
        env.PGPASSWORD = target.password;
      }

      const pgRestore = spawn(compatiblePgRestorePath, args, { env });

      let errorOutput = '';
      let stdoutOutput = '';

      pgRestore.stderr.on('data', (data) => {
        const message = data.toString();
        errorOutput += message;
        logger.info(message.trim(), target.name);
      });

      pgRestore.stdout.on('data', (data) => {
        const message = data.toString();
        stdoutOutput += message;
        logger.info(message.trim(), target.name);
      });

      pgRestore.on('error', (error) => {
        // Nettoyer le fichier temporaire en cas d'erreur de lancement
        cleanupTempFile();

        const errorMsg = `Error launching pg_restore: ${error.message}`;
        logger.error(errorMsg, target.name);
        resolve({
          success: false,
          database: target.name,
          timestamp,
          error: errorMsg
        });
      });

      pgRestore.on('close', (code) => {
        // Toujours nettoyer le fichier temporaire déchiffré
        cleanupTempFile();

        const combinedOutput = stdoutOutput + errorOutput;

        // Liste des erreurs non critiques à ignorer (spécifiques à certains providers comme Neon)
        const nonCriticalErrorPatterns = [
          /unrecognized configuration parameter/i,
          /transaction_timeout/i,
          /does not exist/i,
          /already exists/i,
          /permission denied/i,
          /role.*does not exist/i
        ];

        // Vérifier si l'erreur est critique
        const hasCriticalError = errorOutput.includes('FATAL') ||
          (errorOutput.includes('ERROR') &&
            !nonCriticalErrorPatterns.some(pattern => pattern.test(errorOutput)));

        // Vérifier si des données ont été restaurées (indicateurs de succès)
        const hasRestoreActivity = combinedOutput.includes('CREATE TABLE') ||
          combinedOutput.includes('CREATE INDEX') ||
          combinedOutput.includes('CREATE SEQUENCE') ||
          combinedOutput.includes('CREATE FUNCTION') ||
          combinedOutput.includes('processing data for table') ||
          combinedOutput.includes('COPY ') ||
          combinedOutput.includes('INSERT INTO') ||
          combinedOutput.includes('ALTER TABLE');

        // Vérifier si pg_restore indique explicitement que les erreurs ont été ignorées
        const errorsIgnored = combinedOutput.includes('errors ignored on restore');

        // pg_restore peut retourner 1 avec des warnings mais réussir quand même
        // Code 0 = succès complet
        // Code 1 = warnings mais peut être un succès si des données ont été restaurées OU si les erreurs ont été ignorées
        // Code > 1 = erreur critique
        if (code === 0) {
          // Succès complet
          const successMsg = `Restore successful from ${backupFile} to ${target.name}`;
          logger.info(successMsg, target.name);
          resolve({
            success: true,
            database: target.name,
            timestamp,
            message: successMsg,
            output: combinedOutput
          });
        } else if (code === 1 && (hasRestoreActivity || errorsIgnored) && !hasCriticalError) {
          // Code 1 avec activité de restauration OU erreurs ignorées = succès malgré les warnings
          const successMsg = `Restore completed${errorsIgnored ? ' (some errors were ignored)' : ' with warnings'} from ${backupFile} to ${target.name}`;
          logger.info(successMsg, target.name);
          if (errorOutput && !hasCriticalError) {
            logger.warn(`Non-critical warnings during restore (ignored): ${errorOutput.substring(0, 500)}`, target.name);
          }
          resolve({
            success: true,
            database: target.name,
            timestamp,
            message: successMsg,
            output: combinedOutput
          });
        } else {
          // Échec réel
          const errorMsg = `pg_restore failed with code ${code}${hasRestoreActivity ? ' (partial restore)' : ''}\n${errorOutput}`;
          logger.error(errorMsg, target.name);
          resolve({
            success: false,
            database: target.name,
            timestamp,
            error: errorMsg,
            output: combinedOutput
          });
        }
      });
    });
  }
}

export const backupManager = new BackupManager();

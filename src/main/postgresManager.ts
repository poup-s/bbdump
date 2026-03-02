import { exec, spawn } from 'child_process';
import { getErrorMessage } from './utils';
import { promisify } from 'util';
import * as os from 'os';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface PostgresStatus {
  installed: boolean;
  running: boolean;
  port?: number;
  version?: string;
  error?: string;
}

export interface InstallationProgress {
  step: string;
  message: string;
  progress: number; // 0-100
}

/**
 * Détecte l'OS
 * Utilise le module centralisé osDetector
 */
function getOS(): 'macos' | 'linux' | 'windows' {
  // Import dynamique pour éviter les dépendances circulaires
  const { getOSType } = require('./os/osDetector');
  const osType = getOSType();
  return osType;
}

/**
 * Try to connect to PostgreSQL, handling Linux peer auth via Unix socket.
 * On Linux, SCRAM auth rejects empty passwords over TCP, so we try Unix socket first (peer auth).
 * On macOS, trust auth works fine with password: '' over TCP.
 */
export async function tryPgConnect(port: number, user: string): Promise<void> {
  const { Client } = await import('pg');
  const osType = getOS();

  if (osType === 'linux') {
    // On Linux, try Unix socket paths first (peer auth, no password needed)
    const socketPaths = ['/var/run/postgresql', '/tmp'];
    for (const socketPath of socketPaths) {
      try {
        const client = new Client({
          host: socketPath,
          port: port,
          user: user,
          password: '',
          database: 'postgres',
          connectionTimeoutMillis: 5000
        });
        await client.connect();
        await client.end();
        return;
      } catch {
        // Try next socket path
      }
    }
    // Fallback: TCP with empty password (must be a string to avoid SCRAM crash)
    const client = new Client({
      host: 'localhost',
      port: port,
      user: user,
      password: '',
      database: 'postgres',
      connectionTimeoutMillis: 5000
    });
    await client.connect();
    await client.end();
  } else {
    // macOS: trust auth works with empty password over TCP
    const client = new Client({
      host: 'localhost',
      port: port,
      user: user,
      password: '',
      database: 'postgres',
      connectionTimeoutMillis: 5000
    });
    await client.connect();
    await client.end();
  }
}

/**
 * Connect to PostgreSQL and return a connected Client instance.
 * Same logic as tryPgConnect but returns the client for query use.
 */
export async function getPgClient(port: number, user: string): Promise<import('pg').Client> {
  const { Client } = await import('pg');
  const osType = getOS();

  if (osType === 'linux') {
    const socketPaths = ['/var/run/postgresql', '/tmp'];
    for (const socketPath of socketPaths) {
      try {
        const client = new Client({
          host: socketPath,
          port: port,
          user: user,
          password: '',
          database: 'postgres',
          connectionTimeoutMillis: 5000
        });
        await client.connect();
        return client;
      } catch {
        // Try next socket path
      }
    }
    // Fallback: TCP with empty password (must be a string to avoid SCRAM crash)
    const client = new Client({
      host: 'localhost',
      port: port,
      user: user,
      password: '',
      database: 'postgres',
      connectionTimeoutMillis: 5000
    });
    await client.connect();
    return client;
  } else {
    const client = new Client({
      host: 'localhost',
      port: port,
      user: user,
      password: '',
      database: 'postgres',
      connectionTimeoutMillis: 5000
    });
    await client.connect();
    return client;
  }
}

/**
 * Trouve le chemin de Homebrew de manière robuste
 */
async function findBrewPath(): Promise<string | null> {
  try {
    // Essayer d'abord avec la détection robuste
    const { detectHomebrew } = await import('./tools/toolDetector');
    const homebrewCheck = await detectHomebrew();
    if (homebrewCheck.installed && homebrewCheck.path) {
      return homebrewCheck.path;
    }

    // Fallback: essayer avec which
    try {
      const { stdout } = await execAsync('which brew 2>/dev/null || echo ""');
      if (stdout.trim()) {
        return stdout.trim();
      }
    } catch {
      // Ignore
    }

    // Dernier fallback: essayer les chemins standards
    const possiblePaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
    for (const path of possiblePaths) {
      try {
        await execAsync(`"${path}" --version`);
        return path;
      } catch {
        // Continue
      }
    }

    return null;
  } catch (error) {
    logger.warn(`Error finding Homebrew path: ${getErrorMessage(error)}`);
    return null;
  }
}

/**
 * Vérifie si PostgreSQL est installé
 */
export async function checkPostgresInstalled(): Promise<{ installed: boolean; version?: string; path?: string; method?: 'brew' | 'system' | 'unknown'; hasServer?: boolean }> {
  try {
    const { stdout } = await execAsync('psql --version');
    const versionMatch = stdout.match(/(\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : undefined;

    // Trouver le chemin de psql
    let path: string | undefined;
    let method: 'brew' | 'system' | 'unknown' = 'unknown';
    let hasServer = false;

    try {
      const { stdout: whichOutput } = await execAsync('which psql');
      path = whichOutput.trim();

      // Déterminer la méthode d'installation
      if (path.includes('/opt/homebrew') || path.includes('/usr/local/opt')) {
        method = 'brew';
      } else if (path.includes('/usr/bin') || path.includes('/usr/local/bin')) {
        method = 'system';
      }
    } catch {
      // Ignore
    }

    // Vérifier si PostgreSQL SERVER est installé
    const osType = getOS();

    if (osType === 'linux') {
      // On Linux, check for the postgres binary in standard paths
      const linuxPostgresPaths = [
        '/usr/bin/postgres',
        '/usr/local/bin/postgres',
        '/usr/lib/postgresql/*/bin/postgres'
      ];
      for (const p of linuxPostgresPaths) {
        try {
          const { stdout: found } = await execAsync(`ls ${p} 2>/dev/null | head -1 || echo ""`);
          if (found.trim()) {
            hasServer = true;
            method = 'system';
            logger.info(`PostgreSQL server binary found on Linux at: ${found.trim()}`);
            break;
          }
        } catch {
          // Ignore
        }
      }

      // Fallback: check if postgresql service exists via systemctl or dpkg/rpm
      if (!hasServer) {
        try {
          await execAsync('systemctl list-unit-files postgresql*.service 2>/dev/null | grep -q postgresql');
          hasServer = true;
          method = 'system';
          logger.info('PostgreSQL server detected via systemctl service');
        } catch {
          // Ignore
        }
      }
      if (!hasServer) {
        try {
          await execAsync('dpkg -l postgresql 2>/dev/null | grep -q "^ii" || rpm -q postgresql-server 2>/dev/null');
          hasServer = true;
          method = 'system';
          logger.info('PostgreSQL server detected via package manager');
        } catch {
          // Ignore
        }
      }
    } else {
      // macOS: check via Homebrew
      try {
        const brewPath = await findBrewPath();
        if (brewPath) {
          const { stdout: brewList } = await execAsync(`"${brewPath}" list 2>/dev/null | grep "^postgresql@" || echo ""`);
          if (brewList.trim()) {
            method = 'brew';
            hasServer = true;
            logger.info(`PostgreSQL server found via Homebrew: ${brewList.trim()}`);
          } else {
            // Vérifier si seulement libpq est installé
            const { stdout: libpqCheck } = await execAsync(`"${brewPath}" list 2>/dev/null | grep "^libpq" || echo ""`);
            if (libpqCheck.trim()) {
              method = 'brew';
              hasServer = false;
              logger.warn(`Only libpq (client) found via Homebrew, not PostgreSQL server: ${libpqCheck.trim()}`);
            }
          }
        }
      } catch {
        // Ignore
      }

      // Vérifier si le serveur postgres existe dans les chemins Homebrew
      if (!hasServer && method === 'brew') {
        try {
          const { stdout: postgresPath } = await execAsync('find /opt/homebrew/opt/postgresql* /usr/local/opt/postgresql* -name postgres -type f 2>/dev/null | head -1 || echo ""');
          if (postgresPath.trim()) {
            hasServer = true;
            logger.info(`PostgreSQL server binary found at: ${postgresPath.trim()}`);
          }
        } catch {
          // Ignore
        }
      }
    }

    return { installed: true, version, path, method, hasServer };
  } catch {
    // Vérifier quand même si PostgreSQL est installé via brew mais pas dans le PATH
    try {
      const brewPath = await findBrewPath();
      if (brewPath) {
        const { stdout: brewList } = await execAsync(`"${brewPath}" list 2>/dev/null | grep "^postgresql@" || echo ""`);
        if (brewList.trim()) {
          logger.info(`PostgreSQL server found via Homebrew (not in PATH): ${brewList.trim()}`);
          return { installed: true, method: 'brew', hasServer: true };
        }
      }
    } catch {
      // Ignore
    }

    return { installed: false };
  }
}

/**
 * Vérifie si PostgreSQL est en cours d'exécution
 */
export async function checkPostgresRunning(port: number = 5432): Promise<{ running: boolean; port?: number; details?: string }> {
  const osType = getOS();

  try {
    if (osType === 'macos') {
      // Vérifier avec lsof d'abord (plus fiable)
      try {
        const { stdout } = await execAsync(`lsof -i :${port} 2>/dev/null | grep LISTEN`);
        if (stdout.includes('postgres')) {
          logger.info(`PostgreSQL is running on port ${port} (detected via lsof)`);
          return { running: true, port, details: 'detected via lsof' };
        }
      } catch {
        // Port libre ou pas de PostgreSQL
      }

      // Vérifier avec brew services
      try {
        const { stdout } = await execAsync('brew services list 2>/dev/null | grep postgresql');
        if (stdout.includes('started')) {
          logger.info(`PostgreSQL service is started (detected via brew services)`);
          return { running: true, port, details: 'detected via brew services' };
        }
      } catch {
        // Ignore si brew n'est pas disponible ou si PostgreSQL n'est pas géré par brew
      }

      // Vérifier avec ps pour les processus postgres
      try {
        const { stdout } = await execAsync('ps aux | grep "[p]ostgres"');
        if (stdout.includes('postgres')) {
          logger.info(`PostgreSQL process found (detected via ps)`);
          // Mais vérifier si le port est bien en écoute
          try {
            const { stdout: lsofOut } = await execAsync(`lsof -i :${port} 2>/dev/null | grep LISTEN`);
            if (lsofOut.includes('postgres')) {
              return { running: true, port, details: 'detected via ps and lsof' };
            }
          } catch {
            // Processus existe mais port pas en écoute
          }
        }
      } catch {
        // Pas de processus postgres
      }
    } else if (osType === 'linux') {
      // Vérifier avec lsof d'abord
      try {
        const { stdout } = await execAsync(`lsof -i :${port} 2>/dev/null | grep LISTEN`);
        if (stdout.includes('postgres')) {
          return { running: true, port, details: 'detected via lsof' };
        }
      } catch {
        // lsof may not be installed
      }

      // Fallback: ss (available on all modern Linux)
      try {
        const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep ':${port} '`);
        if (stdout.includes('postgres')) {
          return { running: true, port, details: 'detected via ss' };
        }
      } catch {
        // Ignore
      }

      // Vérifier avec systemctl (try versioned service names too)
      try {
        const serviceNames = await detectLinuxServiceName();
        for (const svc of serviceNames) {
          try {
            const { stdout } = await execAsync(`systemctl is-active ${svc} 2>/dev/null`);
            if (stdout.trim() === 'active') {
              return { running: true, port, details: `detected via systemctl (${svc})` };
            }
          } catch {
            // Try next
          }
        }
      } catch {
        // Ignore
      }
    } else if (osType === 'windows') {
      // Vérifier avec sc query
      try {
        const { stdout } = await execAsync('sc query postgresql-x64-* 2>/dev/null');
        if (stdout.includes('RUNNING')) {
          return { running: true, port, details: 'detected via sc query' };
        }
      } catch {
        // Ignore
      }
    }

    return { running: false };
  } catch (error) {
    logger.error(`Error checking PostgreSQL status: ${getErrorMessage(error)}`);
    return { running: false };
  }
}

/**
 * Installe PostgreSQL sur macOS avec Homebrew
 */
async function installPostgresMacOS(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    // Vérifier si Homebrew est installé en utilisant la détection robuste
    onProgress({ step: 'checking', message: 'Checking Homebrew installation...', progress: 10 });

    const brewPath = await findBrewPath();

    if (!brewPath) {
      return {
        success: false,
        error: 'Homebrew is not installed or not found in PATH. Please install Homebrew first: https://brew.sh'
      };
    }

    logger.info(`Homebrew found at: ${brewPath}`);

    // Installer PostgreSQL
    onProgress({ step: 'installing', message: 'Installing PostgreSQL via Homebrew...', progress: 30 });
    logger.info(`Installing PostgreSQL via Homebrew (using: ${brewPath || 'brew'})...`);

    return new Promise((resolve) => {
      // Utiliser le chemin complet de brew si trouvé, sinon utiliser 'brew' (sera résolu via PATH)
      const brewCommand = brewPath || 'brew';
      const brewProcess = spawn(brewCommand, ['install', 'postgresql@16'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      brewProcess.stdout?.on('data', (data) => {
        output += data.toString();
        logger.info(`Homebrew: ${data.toString().trim()}`);
      });

      brewProcess.stderr?.on('data', (data) => {
        output += data.toString();
        logger.warn(`Homebrew: ${data.toString().trim()}`);
      });

      brewProcess.on('close', async (code) => {
        if (code === 0) {
          onProgress({ step: 'installing', message: 'PostgreSQL installed successfully', progress: 80 });

          // Créer le répertoire de données (Homebrew le fait généralement automatiquement)
          onProgress({ step: 'initdb', message: 'Initializing PostgreSQL database...', progress: 85 });
          try {
            // Essayer différents chemins possibles pour initdb
            const possiblePaths = [
              '/usr/local/opt/postgresql@16/bin/initdb',
              '/opt/homebrew/opt/postgresql@16/bin/initdb',
              '/usr/local/bin/initdb',
              'initdb'
            ];

            const dataDirs = [
              '/usr/local/var/postgresql@16',
              '/opt/homebrew/var/postgresql@16',
              '/usr/local/var/postgres'
            ];

            let initdbPath = '';
            for (const path of possiblePaths) {
              try {
                await execAsync(`which ${path} || test -x ${path}`);
                initdbPath = path;
                break;
              } catch {
                continue;
              }
            }

            if (initdbPath) {
              for (const dataDir of dataDirs) {
                try {
                  await execAsync(`${initdbPath} ${dataDir}`);
                  logger.info(`Database initialized at ${dataDir}`);
                  break;
                } catch (error) {
                  // Ignore si déjà initialisé ou si le répertoire n'existe pas
                  logger.info(`Initdb skipped for ${dataDir}: ${getErrorMessage(error)}`);
                }
              }
            }
          } catch {
            // Ignore si déjà initialisé
            logger.info('Database may already be initialized or initialization skipped');
          }

          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: `Homebrew installation failed: ${output}`
          });
        }
      });
    });
  } catch (error) {
    return {
      success: false,
      error: `Failed to install PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Installe PostgreSQL sur Linux
 */
async function installPostgresLinux(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    // Détecter le gestionnaire de paquets
    onProgress({ step: 'checking', message: 'Detecting package manager...', progress: 10 });

    let installCommand: string[];
    let updateCommand: string[];

    try {
      await execAsync('which apt-get');
      // Debian/Ubuntu
      updateCommand = ['apt-get', 'update'];
      installCommand = ['apt-get', 'install', '-y', 'postgresql', 'postgresql-contrib'];
    } catch {
      try {
        await execAsync('which yum');
        // RHEL/CentOS
        installCommand = ['yum', 'install', '-y', 'postgresql-server', 'postgresql-contrib'];
        updateCommand = [];
      } catch {
        return {
          success: false,
          error: 'Unsupported Linux distribution. Please install PostgreSQL manually.'
        };
      }
    }

    // Mettre à jour les paquets si nécessaire
    if (updateCommand.length > 0) {
      onProgress({ step: 'updating', message: 'Updating package list...', progress: 20 });
      await execAsync(updateCommand.join(' '));
    }

    // Installer PostgreSQL
    onProgress({ step: 'installing', message: 'Installing PostgreSQL...', progress: 40 });
    logger.info(`Installing PostgreSQL with: ${installCommand.join(' ')}`);
    await execAsync(installCommand.join(' '));

    // Initialiser la base de données
    onProgress({ step: 'initdb', message: 'Initializing PostgreSQL database...', progress: 80 });
    try {
      await execAsync('postgresql-setup --initdb || /usr/pgsql-*/bin/postgresql-setup --initdb');
    } catch (error) {
      logger.warn(`Initdb may have failed or already done: ${getErrorMessage(error)}`);
    }

    onProgress({ step: 'installing', message: 'PostgreSQL installed successfully', progress: 100 });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to install PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Installe PostgreSQL (gère tous les OS)
 */
export async function installPostgreSQL(
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  const osType = getOS();
  logger.info(`Installing PostgreSQL on ${osType}`);

  if (osType === 'macos') {
    return installPostgresMacOS(onProgress);
  } else if (osType === 'linux') {
    return installPostgresLinux(onProgress);
  } else {
    return {
      success: false,
      error: 'Windows installation not yet supported. Please install PostgreSQL manually from https://www.postgresql.org/download/windows/'
    };
  }
}

/**
 * Finds the PostgreSQL data directory
 */
async function findPostgresDataDir(): Promise<string | null> {
  const osType = getOS();

  // On Linux (Debian/Ubuntu), try pg_lsclusters first (most reliable)
  if (osType === 'linux') {
    try {
      const { stdout } = await execAsync('pg_lsclusters -h 2>/dev/null | head -1 || echo ""');
      if (stdout.trim()) {
        // Format: version cluster port status owner data_directory log_file
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 6) {
          const dataDir = parts[5];
          try {
            await execAsync(`test -d "${dataDir}"`);
            logger.info(`Found PostgreSQL data directory via pg_lsclusters: ${dataDir}`);
            return dataDir;
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore - pg_lsclusters may not exist (RHEL/CentOS)
    }

    // Linux-specific data directory paths
    const linuxDataDirs = [
      '/var/lib/postgresql/17/main',
      '/var/lib/postgresql/16/main',
      '/var/lib/postgresql/15/main',
      '/var/lib/postgresql/14/main',
      '/var/lib/pgsql/17/data',
      '/var/lib/pgsql/16/data',
      '/var/lib/pgsql/15/data',
      '/var/lib/pgsql/14/data',
      '/var/lib/pgsql/data',
      '/usr/local/pgsql/data'
    ];

    for (const dataDir of linuxDataDirs) {
      try {
        // On Debian/Ubuntu, postgresql.conf may be in /etc/postgresql/<ver>/main/
        // so just check that the data directory exists and has PG_VERSION
        await execAsync(`test -d "${dataDir}" && (test -f "${dataDir}/postgresql.conf" || test -f "${dataDir}/PG_VERSION")`);
        logger.info(`Found PostgreSQL data directory on Linux: ${dataDir}`);
        return dataDir;
      } catch {
        continue;
      }
    }

    // Glob fallback for versioned paths
    try {
      const { stdout: found } = await execAsync('ls -d /var/lib/postgresql/*/main 2>/dev/null | sort -rV | head -1 || echo ""');
      if (found.trim()) {
        logger.info(`Found PostgreSQL data directory via glob: ${found.trim()}`);
        return found.trim();
      }
    } catch {
      // Ignore
    }
    try {
      const { stdout: found } = await execAsync('ls -d /var/lib/pgsql/*/data 2>/dev/null | sort -rV | head -1 || echo ""');
      if (found.trim()) {
        logger.info(`Found PostgreSQL data directory via glob: ${found.trim()}`);
        return found.trim();
      }
    } catch {
      // Ignore
    }
  }

  // macOS: try pg_config
  try {
    const { stdout: pgConfigData } = await execAsync('pg_config --sysconfdir 2>/dev/null || echo ""');
    if (pgConfigData.trim()) {
      const sysconfdir = pgConfigData.trim();
      const possibleDirs = [
        sysconfdir.replace('/etc', '/var/postgres'),
        sysconfdir.replace('/etc', '/var/postgresql@17'),
        sysconfdir.replace('/etc', '/var/postgresql@16'),
        sysconfdir.replace('/etc', '/var/postgresql@15'),
        sysconfdir.replace('/etc', '/var/postgresql@14')
      ];

      for (const dir of possibleDirs) {
        try {
          await execAsync(`test -d "${dir}" && test -f "${dir}/postgresql.conf"`);
          logger.info(`Found PostgreSQL data directory via pg_config: ${dir}`);
          return dir;
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Ignore
  }

  // macOS Homebrew paths
  const possibleDataDirs = [
    '/usr/local/var/postgresql@17',
    '/opt/homebrew/var/postgresql@17',
    '/usr/local/var/postgresql@16',
    '/opt/homebrew/var/postgresql@16',
    '/usr/local/var/postgres',
    '/opt/homebrew/var/postgres',
    '/usr/local/var/postgresql@15',
    '/opt/homebrew/var/postgresql@15',
    '/usr/local/var/postgresql@14',
    '/opt/homebrew/var/postgresql@14',
    '/usr/local/pgsql/data',
    '/Library/PostgreSQL/*/data'
  ];

  for (const dataDir of possibleDataDirs) {
    try {
      await execAsync(`test -d "${dataDir}" && test -f "${dataDir}/postgresql.conf"`);
      logger.info(`Found PostgreSQL data directory: ${dataDir}`);
      return dataDir;
    } catch {
      continue;
    }
  }

  // Fallback: find via running process
  try {
    const { stdout: psOutput } = await execAsync('ps aux | grep "[p]ostgres" | grep -o "\\-D [^ ]*" | head -1 || echo ""');
    if (psOutput.trim()) {
      const dataDir = psOutput.trim().replace('-D ', '').trim();
      try {
        await execAsync(`test -d "${dataDir}"`);
        logger.info(`Found PostgreSQL data directory via process: ${dataDir}`);
        return dataDir;
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Finds a PostgreSQL data directory to create (even if it doesn't exist yet)
 */
async function findPostgresDataDirToCreate(): Promise<string | null> {
  // First check existing directories
  const existing = await findPostgresDataDir();
  if (existing) {
    return existing;
  }

  const osType = getOS();

  try {
    const installed = await checkPostgresInstalled();
    let majorVersion = '17';

    if (installed.version) {
      const versionMatch = installed.version.match(/(\d+)\./);
      majorVersion = versionMatch ? versionMatch[1] : '17';
    }

    logger.info(`Detected PostgreSQL major version ${majorVersion}`);

    if (osType === 'linux') {
      // Linux: Debian/Ubuntu layout
      const linuxDirs = [
        `/var/lib/postgresql/${majorVersion}/main`,
        `/var/lib/pgsql/${majorVersion}/data`,
        `/var/lib/pgsql/data`
      ];

      for (const dir of linuxDirs) {
        try {
          const parentDir = dir.substring(0, dir.lastIndexOf('/'));
          await execAsync(`test -d "${parentDir}"`);
          logger.info(`Will create PostgreSQL data directory at: ${dir}`);
          return dir;
        } catch {
          continue;
        }
      }

      return `/var/lib/postgresql/${majorVersion}/main`;
    }

    // macOS: Homebrew paths
    const brewService = await findBrewPostgresService();
    if (brewService) {
      const serviceVersionMatch = brewService.match(/postgresql@?(\d+)/);
      if (serviceVersionMatch) {
        majorVersion = serviceVersionMatch[1];
      }
    }

    const possibleDirs = [
      `/opt/homebrew/var/postgresql@${majorVersion}`,
      `/usr/local/var/postgresql@${majorVersion}`,
      `/opt/homebrew/var/postgres`,
      `/usr/local/var/postgres`,
      `/opt/homebrew/var/postgresql`,
      `/usr/local/var/postgresql`
    ];

    for (const dir of possibleDirs) {
      try {
        const parentDir = dir.substring(0, dir.lastIndexOf('/'));
        await execAsync(`test -d "${parentDir}"`);
        logger.info(`Will create PostgreSQL data directory at: ${dir}`);
        return dir;
      } catch {
        continue;
      }
    }

    const defaultDir = `/opt/homebrew/var/postgresql@${majorVersion}`;
    logger.info(`Using default PostgreSQL data directory: ${defaultDir}`);
    return defaultDir;
  } catch (error) {
    logger.warn(`Failed to determine PostgreSQL data directory: ${getErrorMessage(error)}`);
  }

  if (osType === 'linux') {
    return '/var/lib/postgresql/17/main';
  }
  return '/opt/homebrew/var/postgresql@17';
}

/**
 * Initializes the PostgreSQL data directory
 */
async function initPostgresDatabase(
  dataDir: string,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    const osType = getOS();
    onProgress({ step: 'initdb', message: `Initializing PostgreSQL database at ${dataDir}...`, progress: 80 });
    logger.info(`Initializing PostgreSQL database at ${dataDir}`);

    // Create parent directory if needed
    const parentDir = dataDir.substring(0, dataDir.lastIndexOf('/'));
    try {
      await execAsync(`mkdir -p "${parentDir}"`);
    } catch (error) {
      logger.warn(`Failed to create parent directory: ${getErrorMessage(error)}`);
    }

    // Find initdb
    let initdbPath = '';
    const installed = await checkPostgresInstalled();
    let majorVersion = '17';
    if (installed.version) {
      const versionMatch = installed.version.match(/(\d+)\./);
      majorVersion = versionMatch ? versionMatch[1] : '17';
    }

    logger.info(`Looking for initdb for PostgreSQL ${majorVersion}`);

    // Validate that initdb is real (not from libpq)
    const isValidInitdb = async (path: string): Promise<boolean> => {
      try {
        const dir = path.substring(0, path.lastIndexOf('/'));
        const postgresPath = `${dir}/postgres`;
        await execAsync(`test -x "${postgresPath}"`);
        logger.info(`Verified initdb at ${path} is valid (postgres found in same directory)`);
        return true;
      } catch {
        logger.warn(`initdb at ${path} may be from libpq (postgres not found in same directory)`);
        return false;
      }
    };

    if (osType === 'linux') {
      // Linux: check standard paths first
      const linuxInitdbPaths = [
        `/usr/lib/postgresql/${majorVersion}/bin/initdb`,
        '/usr/lib/postgresql/17/bin/initdb',
        '/usr/lib/postgresql/16/bin/initdb',
        '/usr/lib/postgresql/15/bin/initdb',
        '/usr/lib/postgresql/14/bin/initdb',
        '/usr/bin/initdb',
        '/usr/local/bin/initdb'
      ];

      // Also try which
      try {
        const { stdout } = await execAsync('which initdb 2>/dev/null');
        if (stdout.trim()) {
          linuxInitdbPaths.unshift(stdout.trim());
        }
      } catch {
        // Ignore
      }

      // Glob fallback
      try {
        const { stdout: found } = await execAsync('ls /usr/lib/postgresql/*/bin/initdb 2>/dev/null | sort -rV | head -1 || echo ""');
        if (found.trim()) {
          linuxInitdbPaths.unshift(found.trim());
        }
      } catch {
        // Ignore
      }

      for (const p of linuxInitdbPaths) {
        try {
          await execAsync(`test -x "${p}"`);
          initdbPath = p;
          logger.info(`Found initdb on Linux at: ${initdbPath}`);
          break;
        } catch {
          continue;
        }
      }

      if (!initdbPath) {
        logger.error('Could not find initdb on Linux');
        return {
          success: false,
          error: `Could not find initdb on this system.\n\nPlease install PostgreSQL server:\n  sudo apt install postgresql\n  or: sudo dnf install postgresql-server\n\nThen retry.`
        };
      }
    } else {
      // macOS: Homebrew-based search
      try {
        const { stdout: brewList } = await execAsync('brew list 2>/dev/null | grep "^postgresql@" || echo ""');
        if (brewList.trim()) {
          const packages = brewList.trim().split('\n');
          for (const pkg of packages) {
            const versionMatch = pkg.match(/postgresql@(\d+)/);
            if (versionMatch) {
              const pkgVersion = versionMatch[1];
              const possiblePath = `/opt/homebrew/opt/postgresql@${pkgVersion}/bin/initdb`;
              try {
                await execAsync(`test -x "${possiblePath}"`);
                if (await isValidInitdb(possiblePath)) {
                  initdbPath = possiblePath;
                  logger.info(`Found initdb via brew list: ${initdbPath}`);
                  break;
                }
              } catch {
                continue;
              }
            }
          }
        }
      } catch {
        // Ignore
      }

      if (!initdbPath) {
        const possibleInitdbPaths = [
          `/opt/homebrew/opt/postgresql@${majorVersion}/bin/initdb`,
          `/usr/local/opt/postgresql@${majorVersion}/bin/initdb`,
          '/opt/homebrew/opt/postgresql@17/bin/initdb',
          '/usr/local/opt/postgresql@17/bin/initdb',
          '/opt/homebrew/opt/postgresql@16/bin/initdb',
          '/usr/local/opt/postgresql@16/bin/initdb',
          '/opt/homebrew/opt/postgresql/bin/initdb',
          '/usr/local/opt/postgresql/bin/initdb'
        ];

        for (const path of possibleInitdbPaths) {
          try {
            await execAsync(`test -x "${path}"`);
            if (await isValidInitdb(path)) {
              initdbPath = path;
              logger.info(`Found valid PostgreSQL initdb at: ${initdbPath}`);
              break;
            } else if (!initdbPath) {
              initdbPath = path;
              logger.warn(`Found initdb at ${path} but may be from libpq, continuing search...`);
            }
          } catch {
            continue;
          }
        }
      }

      // Reject libpq initdb
      if (initdbPath && (initdbPath.includes('libpq') || initdbPath.includes('Cellar/libpq'))) {
        logger.error(`Found initdb from libpq at ${initdbPath}, this won't work.`);
        return {
          success: false,
          error: `Found initdb from libpq (client library) at ${initdbPath}, but need full PostgreSQL server.\n\nPlease install PostgreSQL server:\nbrew install postgresql@${majorVersion}`
        };
      }

      if (!initdbPath) {
        logger.error('Could not find valid PostgreSQL initdb command');
        return {
          success: false,
          error: `Could not find initdb from PostgreSQL server installation.\n\nPlease install PostgreSQL server:\nbrew install postgresql@${majorVersion}`
        };
      }
    }

    // Initialiser la base de données
    logger.info(`Running: ${initdbPath} -D "${dataDir}"`);
    try {
      const { stdout, stderr } = await execAsync(`${initdbPath} -D "${dataDir}" 2>&1`);
      logger.info(`initdb output: ${stdout}`);
      if (stderr) {
        logger.warn(`initdb stderr: ${stderr}`);
      }

      // Vérifier que le répertoire existe maintenant
      try {
        await execAsync(`test -d "${dataDir}" && test -f "${dataDir}/postgresql.conf"`);
        logger.info(`PostgreSQL database initialized successfully at ${dataDir}`);
        return { success: true };
      } catch {
        return {
          success: false,
          error: `initdb completed but data directory not found at ${dataDir}. Output: ${stdout}${stderr ? `\nErrors: ${stderr}` : ''}`
        };
      }
    } catch (error) {
      logger.error(`initdb failed: ${getErrorMessage(error)}`);
      const spawnError = error as { stdout?: string; stderr?: string };
      const errorOutput = spawnError.stdout || spawnError.stderr || getErrorMessage(error);
      return {
        success: false,
        error: `Failed to initialize PostgreSQL database: ${errorOutput}\n\nCommand: ${initdbPath} -D "${dataDir}"`
      };
    }
  } catch (error) {
    logger.error(`Failed to initialize PostgreSQL database: ${getErrorMessage(error)}`);
    return {
      success: false,
      error: `Failed to initialize PostgreSQL database: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Trouve le nom du service PostgreSQL avec brew
 */
async function findBrewPostgresService(): Promise<string | null> {
  try {
    const brewPath = await findBrewPath();
    if (!brewPath) {
      return null;
    }

    const { stdout } = await execAsync(`"${brewPath}" services list`);
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (line.includes('postgresql')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 1) {
          const service = parts[0];
          logger.info(`Found PostgreSQL service: ${service}`);
          return service;
        }
      }
    }
  } catch (error) {
    logger.warn(`Failed to list brew services: ${getErrorMessage(error)}`);
  }

  // Si aucun service n'est trouvé dans brew services, essayer de trouver via brew list
  try {
    const brewPath = await findBrewPath();
    if (!brewPath) {
      return null;
    }

    const { stdout: brewList } = await execAsync(`"${brewPath}" list 2>/dev/null | grep postgresql || echo ""`);
    if (brewList.trim()) {
      // Extraire le nom du package PostgreSQL installé
      const packages = brewList.trim().split('\n').filter(p => p.includes('postgresql'));
      if (packages.length > 0) {
        const packageName = packages[0].trim();
        logger.info(`Found PostgreSQL package: ${packageName}`);
        // Retourner le nom du package comme service potentiel
        return packageName;
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Detects the actual PostgreSQL systemd service name on Linux.
 * Varies by distro: "postgresql" (Arch), "postgresql@14-main" (Debian), etc.
 */
async function detectLinuxServiceName(): Promise<string[]> {
  const names: string[] = [];

  try {
    // List all postgresql service unit files
    const { stdout } = await execAsync('systemctl list-unit-files "postgresql*" --no-legend 2>/dev/null || echo ""');
    for (const line of stdout.trim().split('\n')) {
      const match = line.trim().match(/^(postgresql\S*\.service)/);
      if (match) {
        names.push(match[1]);
      }
    }
  } catch {
    // Ignore
  }

  // Also try listing active/inactive units (catches enabled but masked units)
  try {
    const { stdout } = await execAsync('systemctl list-units "postgresql*" --all --no-legend 2>/dev/null || echo ""');
    for (const line of stdout.trim().split('\n')) {
      const match = line.trim().match(/^(postgresql\S*\.service)/);
      if (match && !names.includes(match[1])) {
        names.push(match[1]);
      }
    }
  } catch {
    // Ignore
  }

  if (names.length === 0) {
    // Fallback: try common names
    names.push('postgresql', 'postgresql.service');
  }

  logger.info(`Detected Linux PostgreSQL service names: ${names.join(', ')}`);
  return names;
}

/**
 * Démarre PostgreSQL
 */
export async function startPostgreSQL(
  port: number = 5432,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  const osType = getOS();
  logger.info(`Starting PostgreSQL on ${osType}, port ${port}`);

  try {
    if (osType === 'macos') {
      // Vérifier d'abord si PostgreSQL est déjà en cours d'exécution
      const alreadyRunning = await checkPostgresRunning(port);
      if (alreadyRunning.running) {
        logger.info('PostgreSQL is already running');
        return { success: true };
      }

      onProgress({ step: 'starting', message: 'Checking PostgreSQL services...', progress: 50 });

      // Trouver le service PostgreSQL installé
      const brewService = await findBrewPostgresService();

      if (brewService) {
        onProgress({ step: 'starting', message: `Starting PostgreSQL service (${brewService})...`, progress: 60 });

        try {
          const brewPath = await findBrewPath();
          if (!brewPath) {
            throw new Error('Homebrew not found');
          }

          logger.info(`Starting PostgreSQL service: ${brewService}`);
          await execAsync(`"${brewPath}" services start ${brewService}`);

          // Attendre et vérifier plusieurs fois (jusqu'à 10 secondes)
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const running = await checkPostgresRunning(port);
            if (running.running) {
              logger.info(`PostgreSQL started successfully via brew services (${brewService})`);
              return { success: true };
            }
            logger.info(`Waiting for PostgreSQL to start... (attempt ${i + 1}/5)`);
          }
        } catch (error) {
          logger.warn(`Brew services start failed: ${getErrorMessage(error)}`);
        }
      } else {
        // Essayer les services PostgreSQL courants en fonction de la version installée
        onProgress({ step: 'starting', message: 'Starting PostgreSQL service...', progress: 60 });

        // Déterminer la version installée
        const installed = await checkPostgresInstalled();
        let majorVersion = '16';
        if (installed.version) {
          const versionMatch = installed.version.match(/(\d+)\./);
          majorVersion = versionMatch ? versionMatch[1] : '16';
        }

        // Construire la liste des services à essayer selon la version
        const servicesToTry = [
          `postgresql@${majorVersion}`, // Version exacte détectée
          'postgresql@17', // PostgreSQL 17
          'postgresql@16', // PostgreSQL 16
          'postgresql@15', // PostgreSQL 15
          'postgresql@14', // PostgreSQL 14
          'postgresql' // Version générique
        ];

        const brewPath = await findBrewPath();
        if (brewPath) {
          for (const service of servicesToTry) {
            try {
              logger.info(`Trying to start service: ${service}`);
              const { stdout, stderr } = await execAsync(`"${brewPath}" services start ${service} 2>&1`);
              logger.info(`Service ${service} output: ${stdout}${stderr ? ` Error: ${stderr}` : ''}`);

              await new Promise(resolve => setTimeout(resolve, 3000));

              const running = await checkPostgresRunning(port);
              if (running.running) {
                logger.info(`PostgreSQL started successfully via brew services (${service})`);
                return { success: true };
              }
            } catch (error) {
              logger.info(`Service ${service} not available or failed: ${getErrorMessage(error)}`);
              continue;
            }
          }
        }
      }

      // Essayer de démarrer manuellement avec pg_ctl
      onProgress({ step: 'starting', message: 'Trying manual start...', progress: 70 });
      let dataDir = await findPostgresDataDir();

      // Si le répertoire n'existe pas, essayer de l'initialiser
      if (!dataDir) {
        onProgress({ step: 'initdb', message: 'PostgreSQL data directory not found. Initializing...', progress: 75 });
        const dataDirToCreate = await findPostgresDataDirToCreate();

        if (dataDirToCreate) {
          const initResult = await initPostgresDatabase(dataDirToCreate, onProgress);
          if (initResult.success) {
            dataDir = dataDirToCreate;
            logger.info(`PostgreSQL database initialized at ${dataDir}`);
          } else {
            logger.warn(`Failed to initialize database: ${initResult.error}`);
          }
        }
      }

      if (dataDir) {
        try {
          logger.info(`Attempting manual start with pg_ctl at ${dataDir}`);

          // Vérifier d'abord si PostgreSQL n'est pas déjà en cours d'exécution
          const alreadyRunning = await checkPostgresRunning(port);
          if (alreadyRunning.running) {
            logger.info('PostgreSQL is already running');
            return { success: true };
          }

          // Démarrer PostgreSQL
          const { stdout, stderr } = await execAsync(`pg_ctl -D "${dataDir}" start 2>&1`);
          logger.info(`pg_ctl start output: ${stdout}${stderr ? `\nstderr: ${stderr}` : ''}`);

          // Attendre et vérifier plusieurs fois
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Vérifier avec checkPostgresRunning
            const running = await checkPostgresRunning(port);
            if (running.running) {
              logger.info(`PostgreSQL started successfully manually at ${dataDir} (verified after ${i + 1} attempts)`);

              // Vérifier aussi avec une connexion directe
              try {
                const currentUser = os.userInfo().username;
                await tryPgConnect(port, currentUser);
                logger.info('PostgreSQL connection test successful');
                return { success: true };
              } catch (connError) {
                logger.warn(`PostgreSQL process detected but connection test failed: ${getErrorMessage(connError)}`);
                // Continuer à attendre
              }
            }

            logger.info(`Waiting for PostgreSQL to be ready... (attempt ${i + 1}/10)`);
          }

          // Dernière vérification
          const finalRunning = await checkPostgresRunning(port);
          if (finalRunning.running) {
            logger.info('PostgreSQL is running (final check)');
            return { success: true };
          }

          logger.error('PostgreSQL start command succeeded but server is not accessible');
        } catch (error) {
          logger.error(`Manual start failed: ${getErrorMessage(error)}`);
          const spawnError = error as { stdout?: string; stderr?: string };
          const errorOutput = spawnError.stdout || spawnError.stderr || getErrorMessage(error);
          logger.error(`pg_ctl error details: ${errorOutput}`);
        }
      } else {
        logger.warn('Could not find or create PostgreSQL data directory');
      }

      // Dernière tentative : vérifier si PostgreSQL est maintenant en cours d'exécution
      const finalCheck = await checkPostgresRunning(port);
      if (finalCheck.running) {
        logger.info('PostgreSQL is now running');
        return { success: true };
      }

      // Note: L'initialisation est maintenant gérée avant cette étape

      // Vérifier les erreurs de démarrage possibles
      try {
        // Essayer de voir les logs de PostgreSQL
        const logFile = `${dataDir}/log/postgresql-*.log`;
        try {
          const { stdout: logContent } = await execAsync(`tail -20 ${logFile} 2>/dev/null || echo "No log file found"`);
          logger.warn(`PostgreSQL log (last 20 lines): ${logContent}`);
        } catch {
          // Ignore
        }
      } catch {
        // Ignore
      }

      // Construire un message d'erreur détaillé avec diagnostic
      let errorMsg = 'Failed to start PostgreSQL automatically.\n\n';
      errorMsg += 'Diagnostic information:\n';

      // Vérifier l'installation
      const installedCheck = await checkPostgresInstalled();
      if (installedCheck.installed) {
        errorMsg += `- PostgreSQL ${installedCheck.version || 'unknown version'} is installed`;
        if (installedCheck.method) {
          errorMsg += ` (via ${installedCheck.method})`;
        }
        errorMsg += '\n';
      } else {
        errorMsg += '- PostgreSQL is NOT installed\n';
      }

      if (brewService) {
        errorMsg += `- Found service: ${brewService}\n`;
      } else {
        errorMsg += '- No PostgreSQL service found in brew services\n';
      }

      if (dataDir) {
        errorMsg += `- Data directory: ${dataDir}\n`;
      } else {
        errorMsg += '- Data directory: Not found\n';
      }

      // Vérifier si PostgreSQL est peut-être déjà en cours d'exécution
      const finalRunningCheck = await checkPostgresRunning(port);
      if (finalRunningCheck.running) {
        errorMsg += `- PostgreSQL appears to be running on port ${port}\n`;
      }

      errorMsg += '\nPlease try manually:\n';

      // Déterminer la version pour les instructions (une seule fois)
      let versionForInstructions = '17'; // Par défaut PostgreSQL 17
      if (installedCheck.version) {
        const versionMatch = installedCheck.version.match(/(\d+)\./);
        versionForInstructions = versionMatch ? versionMatch[1] : '17';
      }
      const dataDirPath = os.platform() === 'darwin' && process.arch === 'arm64'
        ? `/opt/homebrew/var/postgresql@${versionForInstructions}`
        : `/usr/local/var/postgresql@${versionForInstructions}`;

      if (!installedCheck.installed) {
        errorMsg += `1. Install PostgreSQL: brew install postgresql@${versionForInstructions}\n`;
        errorMsg += `2. Initialize database: initdb ${dataDirPath}\n`;
        errorMsg += `3. Start service: brew services start postgresql@${versionForInstructions}\n`;
      } else if (brewService) {
        errorMsg += `1. brew services start ${brewService}\n`;
        errorMsg += `2. Check status: brew services list | grep ${brewService}\n`;
        if (!dataDir) {
          errorMsg += `3. If database not initialized: initdb ${dataDirPath}\n`;
        }
      } else {
        errorMsg += '1. Check installed services: brew services list | grep postgresql\n';
        if (!dataDir) {
          errorMsg += `2. Initialize database: initdb ${dataDirPath}\n`;
          errorMsg += `3. Start manually: pg_ctl -D ${dataDirPath} start\n`;
        } else {
          errorMsg += '2. Start manually: pg_ctl -D ' + dataDir + ' start\n';
        }
      }

      if (finalRunningCheck.running) {
        errorMsg += '\nNote: PostgreSQL appears to be running. You can proceed with database creation.';
      } else {
        errorMsg += '\nIf PostgreSQL is already running, you can ignore this error.';
      }

      return {
        success: false,
        error: errorMsg
      };
    } else if (osType === 'linux') {
      // Check if already running
      const alreadyRunning = await checkPostgresRunning(port);
      if (alreadyRunning.running) {
        logger.info('PostgreSQL is already running on Linux');
        return { success: true };
      }

      onProgress({ step: 'starting', message: 'Starting PostgreSQL service...', progress: 50 });

      // Detect the actual service name (varies by distro: postgresql, postgresql@14-main, etc.)
      const serviceNames = await detectLinuxServiceName();

      // Build start commands for each detected service name
      const startCommands: string[] = [];
      for (const svc of serviceNames) {
        startCommands.push(
          `systemctl start ${svc}`,
          `pkexec systemctl start ${svc}`,
          `sudo -n systemctl start ${svc}`,
        );
      }
      // Fallback: try generic service command
      startCommands.push('pkexec service postgresql start');

      let started = false;
      let lastError = '';

      for (const cmd of startCommands) {
        try {
          logger.info(`Trying to start PostgreSQL on Linux: ${cmd}`);
          await execAsync(cmd, { timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 2000));

          const running = await checkPostgresRunning(port);
          if (running.running) {
            logger.info(`PostgreSQL started on Linux via: ${cmd}`);
            started = true;
            break;
          }
        } catch (error) {
          lastError = getErrorMessage(error);
          logger.info(`Start command failed: ${cmd} — ${getErrorMessage(error)}`);
          continue;
        }
      }

      if (!started) {
        // Final check — maybe it started but detection was slow
        await new Promise(resolve => setTimeout(resolve, 3000));
        const finalCheck = await checkPostgresRunning(port);
        if (finalCheck.running) {
          started = true;
        }
      }

      if (started) {
        // After starting, create a role for the current OS user if it doesn't exist
        await createLinuxUserRole(onProgress);
        return { success: true };
      }

      return {
        success: false,
        error: `Failed to start PostgreSQL on Linux.\n\nLast error: ${lastError}\n\nPlease start it manually:\n  sudo systemctl start postgresql\n  sudo systemctl enable postgresql`
      };
    } else {
      return {
        success: false,
        error: 'Windows start not yet supported'
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to start PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}

/**
 * Creates a PostgreSQL role for the current OS user on Linux.
 * On a fresh Linux install, only the 'postgres' role exists.
 * Peer auth requires the OS user to match the PG role, so we need to create one.
 */
async function createLinuxUserRole(
  onProgress?: (progress: InstallationProgress) => void
): Promise<void> {
  const currentUser = os.userInfo().username;
  if (!currentUser || currentUser === 'postgres') return;

  // Check if role already exists by trying to connect via socket
  try {
    await tryPgConnect(5432, currentUser);
    logger.info(`PostgreSQL role "${currentUser}" already exists`);
    return;
  } catch {
    // Role doesn't exist, proceed to create it
  }

  if (onProgress) {
    onProgress({ step: 'creating_user', message: `Creating PostgreSQL role for "${currentUser}"...`, progress: 55 });
  }

  // Try multiple methods to create the role
  const createCommands = [
    // 1. sudo -n -u postgres: works when user has NOPASSWD sudo or active sudo session
    `sudo -n -u postgres createuser -s "${currentUser}"`,
    // 2. pkexec runs as root, then su to postgres (pkexec shows graphical auth dialog)
    `pkexec su - postgres -c 'createuser -s "${currentUser}"'`,
    // 3. sudo with password prompt (works if user has sudo access and TTY)
    `sudo -u postgres createuser -s "${currentUser}"`,
    // 4. Fallback: try psql directly via sudo
    `sudo -n -u postgres psql -c "CREATE ROLE \\"${currentUser}\\" WITH SUPERUSER LOGIN;"`,
  ];

  for (const cmd of createCommands) {
    try {
      logger.info(`Trying to create PG role: ${cmd}`);
      await execAsync(cmd, { timeout: 30000 });
      logger.info(`Successfully created PostgreSQL role "${currentUser}"`);
      return;
    } catch (error) {
      // "already exists" is fine
      if (getErrorMessage(error)?.includes('already exists') || (error as { stderr?: string }).stderr?.includes('already exists')) {
        logger.info(`PostgreSQL role "${currentUser}" already exists`);
        return;
      }
      logger.info(`Create role command failed: ${cmd} — ${getErrorMessage(error)}`);
      continue;
    }
  }

  logger.warn(`Could not create PostgreSQL role "${currentUser}" automatically. User may need to run: sudo -u postgres createuser -s ${currentUser}`);
}

/**
 * Vérifie et prépare PostgreSQL (installe et démarre si nécessaire)
 */
export async function ensurePostgreSQL(
  port: number = 5432,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string; status?: PostgresStatus }> {
  try {
    // Vérifier si installé
    onProgress({ step: 'checking', message: 'Checking PostgreSQL installation...', progress: 5 });
    const installed = await checkPostgresInstalled();

    if (!installed.installed) {
      onProgress({ step: 'installing', message: 'PostgreSQL not found. Installing...', progress: 10 });
      const installResult = await installPostgreSQL(onProgress);
      if (!installResult.success) {
        return installResult;
      }
    } else {
      logger.info(`PostgreSQL ${installed.version || 'unknown version'} is installed${installed.method ? ` (via ${installed.method})` : ''}${installed.hasServer === false ? ' (client only, no server)' : ''}`);

      // Vérifier si seulement le client est installé (libpq) mais pas le serveur
      if (installed.hasServer === false) {
        logger.warn('Only PostgreSQL client (libpq) is installed, not the server. Installing PostgreSQL server...');
        onProgress({ step: 'installing', message: 'Installing PostgreSQL server (only client found)...', progress: 10 });
        const installResult = await installPostgreSQL(onProgress);
        if (!installResult.success) {
          const installHint = getOS() === 'linux'
            ? 'sudo apt install postgresql\nor: sudo dnf install postgresql-server'
            : 'brew install postgresql@17';
          return {
            success: false,
            error: `Only PostgreSQL client (libpq) is installed, but server is required.\n\n${installResult.error}\n\nPlease install PostgreSQL server manually:\n${installHint}`
          };
        }
        // Re-vérifier après installation
        const reinstalled = await checkPostgresInstalled();
        if (reinstalled.hasServer === false) {
          return {
            success: false,
            error: 'PostgreSQL server installation completed but server still not detected. Please restart the application.'
          };
        }
      }

      // Si PostgreSQL est installé mais pas via brew, on peut quand même essayer de le démarrer
      if (installed.method !== 'brew') {
        logger.info('PostgreSQL is installed but not via Homebrew. Will try to start it directly.');
      }
    }

    // Vérifier si le répertoire de données existe, sinon l'initialiser
    onProgress({ step: 'checking', message: 'Checking PostgreSQL data directory...', progress: 70 });
    let dataDir = await findPostgresDataDir();

    if (!dataDir) {
      onProgress({ step: 'initdb', message: 'PostgreSQL data directory not found. Initializing...', progress: 75 });
      logger.info('PostgreSQL data directory not found, attempting to initialize...');

      const dataDirToCreate = await findPostgresDataDirToCreate();
      if (dataDirToCreate) {
        logger.info(`Attempting to initialize PostgreSQL database at: ${dataDirToCreate}`);
        const initResult = await initPostgresDatabase(dataDirToCreate, onProgress);

        if (initResult.success) {
          // Vérifier que le répertoire existe maintenant
          await new Promise(resolve => setTimeout(resolve, 1000)); // Attendre un peu
          const verifyDir = await findPostgresDataDir();
          if (verifyDir) {
            dataDir = verifyDir;
            logger.info(`PostgreSQL database initialized successfully at ${dataDir}`);
          } else {
            // Le répertoire devrait exister maintenant, utiliser celui qu'on a créé
            dataDir = dataDirToCreate;
            logger.info(`PostgreSQL database initialized at ${dataDir} (verification pending)`);
          }
        } else {
          logger.error(`Failed to initialize database: ${initResult.error}`);
          // Retourner l'erreur d'initialisation plutôt que de continuer
          return {
            success: false,
            error: `Failed to initialize PostgreSQL database: ${initResult.error}\n\nPlease try manually:\n1. initdb ${dataDirToCreate}\n2. ${getOS() === 'linux' ? 'sudo systemctl start postgresql' : 'brew services start postgresql@17'}`
          };
        }
      } else {
        logger.error('Could not determine where to create PostgreSQL data directory');
        return {
          success: false,
          error: getOS() === 'linux'
            ? 'Could not determine where to create PostgreSQL data directory. Please install PostgreSQL:\nsudo apt install postgresql\nor: sudo dnf install postgresql-server'
            : 'Could not determine where to create PostgreSQL data directory. Please initialize manually:\n1. initdb /opt/homebrew/var/postgresql@17\n2. brew services start postgresql@17'
        };
      }
    } else {
      logger.info(`PostgreSQL data directory found: ${dataDir}`);
    }

    // Vérifier si en cours d'exécution
    onProgress({ step: 'checking', message: 'Checking if PostgreSQL is running...', progress: 90 });
    let running = await checkPostgresRunning(port);

    if (!running.running) {
      onProgress({ step: 'starting', message: 'PostgreSQL is not running. Starting...', progress: 95 });

      // Si on a un répertoire de données, passer cette information à startPostgreSQL
      const startResult = await startPostgreSQL(port, onProgress);

      // Attendre un peu pour que PostgreSQL démarre
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Vérifier plusieurs fois si PostgreSQL est maintenant en cours d'exécution
      for (let i = 0; i < 5; i++) {
        running = await checkPostgresRunning(port);
        if (running.running) {
          logger.info(`PostgreSQL is now running on port ${port} (detected after ${i + 1} attempts)`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        logger.info(`Waiting for PostgreSQL to start... (attempt ${i + 1}/5)`);
      }

      // Si toujours pas en cours d'exécution, essayer de se connecter directement avec différents utilisateurs
      if (!running.running) {
        logger.warn('PostgreSQL start may have failed, trying direct connection with different users...');
        const currentUser = os.userInfo().username;
        const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];

        for (const user of usersToTry) {
          if (!user) continue;

          try {
            await tryPgConnect(port, user);

            logger.info(`PostgreSQL is actually accessible with user ${user}`);
            running = { running: true, port };
            break;
          } catch (error) {
            logger.info(`Connection failed with user ${user}: ${getErrorMessage(error)}`);
            continue;
          }
        }

        if (!running.running) {
          // PostgreSQL n'est vraiment pas accessible
          logger.error(`PostgreSQL connection test failed with all users`);
          return {
            success: false,
            error: startResult.error || (getOS() === 'linux'
              ? `PostgreSQL is not running on port ${port} and could not be started automatically.\n\nPlease try manually:\nsudo systemctl start postgresql`
              : `PostgreSQL is not running on port ${port} and could not be started automatically.\n\nPlease try manually:\n1. brew services start postgresql@17\n2. Or: pg_ctl -D /opt/homebrew/var/postgresql@17 start`)
          };
        }
      }
    }

    if (running.running) {
      logger.info(`PostgreSQL is running on port ${port}${running.details ? ` (${running.details})` : ''}`);
    } else {
      return {
        success: false,
        error: getOS() === 'linux'
          ? `PostgreSQL is not running on port ${port}.\n\nPlease start it manually:\nsudo systemctl start postgresql`
          : `PostgreSQL is not running on port ${port}.\n\nPlease start it manually:\n1. brew services start postgresql@17\n2. Or: pg_ctl -D /opt/homebrew/var/postgresql@17 start`
      };
    }

    // Vérification finale : s'assurer que PostgreSQL est vraiment accessible
    onProgress({ step: 'verifying', message: 'Verifying PostgreSQL connection...', progress: 98 });

    // On Linux, ensure the current OS user has a PostgreSQL role (peer auth requires it)
    if (getOS() === 'linux') {
      await createLinuxUserRole(onProgress);
    }

    // Détecter l'utilisateur PostgreSQL à utiliser
    let postgresUser = 'postgres';
    const currentUser = os.userInfo().username;

    // Sur macOS avec Homebrew, l'utilisateur par défaut est souvent l'utilisateur système
    // Essayer d'abord avec l'utilisateur système actuel
    const usersToTry = [currentUser, 'postgres', process.env.USER || '', process.env.USERNAME || ''];

    let connected = false;
    let connectionError: string = '';

    for (const user of usersToTry) {
      if (!user) continue;

      try {
        await tryPgConnect(port, user);
        postgresUser = user;
        connected = true;
        logger.info(`PostgreSQL connection verified successfully on port ${port} with user: ${user}`);
        break;
      } catch (error) {
        connectionError = getErrorMessage(error);
        logger.info(`Connection failed with user ${user}: ${getErrorMessage(error)}`);
        continue;
      }
    }

    // Si la connexion a échoué avec "postgres" mais réussit avec l'utilisateur système, créer postgres
    if (!connected && (connectionError.includes('does not exist') || connectionError.includes('role'))) {
      logger.info('PostgreSQL user "postgres" does not exist, attempting to create it...');
      onProgress({ step: 'creating_user', message: 'Creating PostgreSQL user "postgres"...', progress: 99 });

      // Essayer de se connecter avec l'utilisateur système pour créer postgres
      try {
        const adminClient = await getPgClient(port, currentUser);
        logger.info(`Connected as ${currentUser}, creating postgres user...`);

        // Créer l'utilisateur postgres s'il n'existe pas
        try {
          await adminClient.query(`CREATE ROLE postgres WITH SUPERUSER LOGIN;`);
          logger.info('Successfully created PostgreSQL user "postgres"');

          // Tester la connexion avec postgres
          await adminClient.end();

          try {
            await tryPgConnect(port, 'postgres');
            postgresUser = 'postgres';
            connected = true;
            logger.info('PostgreSQL connection verified with newly created postgres user');
          } catch {
            postgresUser = currentUser;
            connected = true;
            logger.info(`Will use system user ${currentUser} for PostgreSQL connections`);
          }
        } catch (createError) {
          // L'utilisateur existe peut-être déjà ou erreur de permissions
          if (getErrorMessage(createError).includes('already exists')) {
            logger.info('PostgreSQL user "postgres" already exists');
            await adminClient.end();
            try {
              await tryPgConnect(port, 'postgres');
              postgresUser = 'postgres';
              connected = true;
              logger.info('PostgreSQL connection verified with existing postgres user');
            } catch {
              // Utiliser l'utilisateur système
              postgresUser = currentUser;
              connected = true;
              logger.info(`Will use system user ${currentUser} for PostgreSQL connections`);
            }
          } else {
            logger.warn(`Could not create postgres user: ${getErrorMessage(createError)}, will use system user`);
            await adminClient.end();
            postgresUser = currentUser;
            connected = true;
          }
        }
      } catch (adminError) {
        logger.warn(`Could not connect as ${currentUser} to create postgres user: ${getErrorMessage(adminError)}`);
        // Si on ne peut pas créer postgres, utiliser l'utilisateur système
        postgresUser = currentUser;
        connected = true;
        logger.info(`Will use system user ${currentUser} for PostgreSQL connections`);
      }
    }

    if (!connected) {
      logger.error(`PostgreSQL connection verification failed: ${connectionError}`);

      const isLinux = getOS() === 'linux';
      const hint = isLinux
        ? `\n\nPlease try:\n  sudo -u postgres createuser -s ${currentUser}\n  sudo systemctl restart postgresql`
        : `\n\nThe system will try to use your system user (${currentUser}) for connections.`;

      return {
        success: false,
        error: `PostgreSQL appears to be running but is not accessible.\n\nError: ${connectionError}${hint}`
      };
    }

    // Stocker l'utilisateur à utiliser pour les futures connexions
    logger.info(`PostgreSQL ready, will use user: ${postgresUser}`);

    onProgress({ step: 'complete', message: 'PostgreSQL is ready', progress: 100 });

    return {
      success: true,
      status: {
        installed: true,
        running: true,
        port,
        version: installed.version
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to ensure PostgreSQL: ${getErrorMessage(error)}`
    };
  }
}
/**
 * Redémarre le service PostgreSQL
 */
export async function restartPostgresService(): Promise<{ success: boolean; error?: string }> {
  try {
    const osType = getOS();
    logger.info(`Restarting PostgreSQL on ${osType}`);

    if (osType === 'macos') {
      const brewService = await findBrewPostgresService();
      const brewPath = await findBrewPath();

      if (brewService && brewPath) {
        logger.info(`Restarting service ${brewService} via brew...`);
        await execAsync(`"${brewPath}" services restart ${brewService}`);
        return { success: true };
      } else {
        // Fallback: essayer pg_ctl si possible
        logger.warn('No brew service found for PostgreSQL restart fallback to pg_ctl');
        // On ne va pas implémenter un pg_ctl complexe ici car brew est le cas nominal sur macOS bbdump
        return { success: false, error: 'Could not find a PostgreSQL service to restart' };
      }
    } else if (osType === 'linux') {
      const serviceNames = await detectLinuxServiceName();
      for (const svc of serviceNames) {
        try {
          await execAsync(`systemctl restart ${svc} 2>/dev/null || pkexec systemctl restart ${svc} 2>/dev/null || sudo -n systemctl restart ${svc}`);
          return { success: true };
        } catch {
          continue;
        }
      }
      return { success: false, error: 'Failed to restart PostgreSQL. Try: sudo systemctl restart postgresql' };
    } else if (osType === 'windows') {
      try {
        // Tenter de trouver le nom du service
        const { stdout } = await execAsync('sc query type= service state= all | findstr /i "postgresql"');
        const match = stdout.match(/SERVICE_NAME: (postgresql-x64-\d+)/i);
        const serviceName = match ? match[1] : 'postgresql-x64-16'; // Fallback

        await execAsync(`net stop ${serviceName} && net start ${serviceName}`);
        return { success: true };
      } catch (error) {
        return { success: false, error: `Failed to restart on Windows: ${getErrorMessage(error)}` };
      }
    }

    return { success: false, error: 'OS not supported for auto-restart' };
  } catch (error) {
    logger.error(`Error restarting PostgreSQL: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  }
}
/**
 * Met à jour le fichier postgresql.conf pour ajouter/supprimer une bibliothèque dans shared_preload_libraries
 */
export async function updateSharedPreloadLibraries(libName: string, action: 'add' | 'remove'): Promise<{ success: boolean; error?: string }> {
  try {
    const dataDir = await findPostgresDataDir();
    if (!dataDir) {
      logger.warn('Could not find PostgreSQL data directory for automatic config update');
      return { success: false, error: 'Could not find PostgreSQL data directory' };
    }

    const fs = await import('fs/promises');
    const path = await import('path');
    const configPath = path.join(dataDir, 'postgresql.conf');

    let content = '';
    try {
      content = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
      logger.error(`Error reading ${configPath}: ${getErrorMessage(error)}`);
      return { success: false, error: `Permission denied or file not found: ${configPath}` };
    }

    const lines = content.split('\n');
    let found = false;
    let modified = false;

    // Pattern pour trouver shared_preload_libraries, même commenté
    const regex = /^\s*#?\s*shared_preload_libraries\s*=\s*'([^']*)'/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        found = true;
        let libs = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0);

        if (action === 'add') {
          if (!libs.includes(libName)) {
            libs.push(libName);
            modified = true;
          }
        } else {
          if (libs.includes(libName)) {
            libs = libs.filter(l => l !== libName);
            modified = true;
          }
        }

        if (modified) {
          lines[i] = `shared_preload_libraries = '${libs.join(', ')}'`;
        }
        break;
      }
    }

    if (!found && action === 'add') {
      // Rechercher un endroit pour ajouter la ligne
      lines.push('');
      lines.push('# Added by bbdump');
      lines.push(`shared_preload_libraries = '${libName}'`);
      modified = true;
    }

    if (modified) {
      await fs.writeFile(configPath, lines.join('\n'), 'utf-8');
      logger.info(`Updated shared_preload_libraries in ${configPath}: ${action} ${libName}`);
      return { success: true };
    }

    return { success: true }; // No modification needed
  } catch (error) {
    logger.error(`Error updating shared_preload_libraries: ${getErrorMessage(error)}`);
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Vérifie si une bibliothèque est présente dans shared_preload_libraries
 */
export async function checkSharedPreloadLibraries(libName: string): Promise<{ success: boolean; isPresent: boolean; error?: string }> {
  try {
    const dataDir = await findPostgresDataDir();
    if (!dataDir) return { success: false, isPresent: false, error: 'Data directory not found' };

    const fs = await import('fs/promises');
    const path = await import('path');
    const configPath = path.join(dataDir, 'postgresql.conf');

    const content = await fs.readFile(configPath, 'utf-8');
    // Regex multiline pour trouver la ligne active (non commentée)
    const regex = /^\s*shared_preload_libraries\s*=\s*'([^']*)'/m;
    const match = content.match(regex);

    if (match) {
      const libs = match[1].split(',').map(s => s.trim());
      return { success: true, isPresent: libs.includes(libName) };
    }

    return { success: true, isPresent: false };
  } catch (error) {
    return { success: false, isPresent: false, error: getErrorMessage(error) };
  }
}

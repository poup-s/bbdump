import { exec, spawn } from 'child_process';
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

    // Vérifier si PostgreSQL SERVER est installé via brew (pas seulement libpq)
    try {
      const { stdout: brewList } = await execAsync('brew list 2>/dev/null | grep "^postgresql@" || echo ""');
      if (brewList.trim()) {
        method = 'brew';
        hasServer = true;
        logger.info(`PostgreSQL server found via Homebrew: ${brewList.trim()}`);
      } else {
        // Vérifier si seulement libpq est installé
        const { stdout: libpqCheck } = await execAsync('brew list 2>/dev/null | grep "^libpq" || echo ""');
        if (libpqCheck.trim()) {
          method = 'brew';
          hasServer = false;
          logger.warn(`Only libpq (client) found via Homebrew, not PostgreSQL server: ${libpqCheck.trim()}`);
        }
      }
    } catch {
      // Ignore
    }
    
    // Vérifier si le serveur postgres existe
    if (!hasServer && method === 'brew') {
      try {
        // Chercher postgres dans les chemins Homebrew
        const { stdout: postgresPath } = await execAsync('find /opt/homebrew/opt/postgresql* /usr/local/opt/postgresql* -name postgres -type f 2>/dev/null | head -1 || echo ""');
        if (postgresPath.trim()) {
          hasServer = true;
          logger.info(`PostgreSQL server binary found at: ${postgresPath.trim()}`);
        }
      } catch {
        // Ignore
      }
    }

    return { installed: true, version, path, method, hasServer };
  } catch {
    // Vérifier quand même si PostgreSQL est installé via brew mais pas dans le PATH
    try {
      const { stdout: brewList } = await execAsync('brew list 2>/dev/null | grep "^postgresql@" || echo ""');
      if (brewList.trim()) {
        logger.info(`PostgreSQL server found via Homebrew (not in PATH): ${brewList.trim()}`);
        return { installed: true, method: 'brew', hasServer: true };
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
        // Port libre
      }
      
      // Vérifier avec systemctl
      try {
        const { stdout } = await execAsync('systemctl is-active postgresql 2>/dev/null');
        if (stdout.trim() === 'active') {
          return { running: true, port, details: 'detected via systemctl' };
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
  } catch (error: any) {
    logger.error(`Error checking PostgreSQL status: ${error.message}`);
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
    // Vérifier si Homebrew est installé
    onProgress({ step: 'checking', message: 'Checking Homebrew installation...', progress: 10 });
    try {
      await execAsync('brew --version');
    } catch {
      return {
        success: false,
        error: 'Homebrew is not installed. Please install Homebrew first: https://brew.sh'
      };
    }

    // Installer PostgreSQL
    onProgress({ step: 'installing', message: 'Installing PostgreSQL via Homebrew...', progress: 30 });
    logger.info('Installing PostgreSQL via Homebrew...');
    
    return new Promise((resolve) => {
      const brewProcess = spawn('brew', ['install', 'postgresql@16'], {
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
                } catch (error: any) {
                  // Ignore si déjà initialisé ou si le répertoire n'existe pas
                  logger.info(`Initdb skipped for ${dataDir}: ${error.message}`);
                }
              }
            }
          } catch (error: any) {
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
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to install PostgreSQL: ${error.message}`
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
    } catch (error: any) {
      logger.warn(`Initdb may have failed or already done: ${error.message}`);
    }

    onProgress({ step: 'installing', message: 'PostgreSQL installed successfully', progress: 100 });
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to install PostgreSQL: ${error.message}`
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
 * Trouve le répertoire de données PostgreSQL sur macOS
 */
async function findPostgresDataDir(): Promise<string | null> {
  // D'abord, essayer de trouver via pg_config si disponible
  try {
    const { stdout: pgConfigData } = await execAsync('pg_config --sysconfdir 2>/dev/null || echo ""');
    if (pgConfigData.trim()) {
      const sysconfdir = pgConfigData.trim();
      // Le répertoire de données est généralement dans ../var/postgres ou ../var/postgresql@version
      const possibleDirs = [
        sysconfdir.replace('/etc', '/var/postgres'),
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
  
  // Ensuite, essayer les chemins standards (inclure PostgreSQL 17)
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
    // Chemins système standards
    '/usr/local/pgsql/data',
    '/var/lib/postgresql',
    '/Library/PostgreSQL/*/data'
  ];
  
  for (const dataDir of possibleDataDirs) {
    try {
      // Vérifier si le répertoire existe et contient les fichiers PostgreSQL
      await execAsync(`test -d "${dataDir}" && test -f "${dataDir}/postgresql.conf"`);
      logger.info(`Found PostgreSQL data directory: ${dataDir}`);
      return dataDir;
    } catch {
      continue;
    }
  }
  
  // Essayer de trouver via ps aux
  try {
    const { stdout: psOutput } = await execAsync('ps aux | grep "[p]ostgres" | grep -o "\\-D [^ ]*" | head -1 || echo ""');
    if (psOutput.trim()) {
      const dataDir = psOutput.trim().replace('-D ', '').trim();
      try {
        await execAsync(`test -d "${dataDir}" && test -f "${dataDir}/postgresql.conf"`);
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
 * Trouve le répertoire de données PostgreSQL à créer (même s'il n'existe pas encore)
 */
async function findPostgresDataDirToCreate(): Promise<string | null> {
  // D'abord vérifier les répertoires existants
  const existing = await findPostgresDataDir();
  if (existing) {
    return existing;
  }
  
  // Sinon, essayer de trouver où Homebrew installe PostgreSQL
  try {
    // Vérifier quelle version de PostgreSQL est installée
    const installed = await checkPostgresInstalled();
    let majorVersion = '16';
    let fullVersion = '';
    
    if (installed.version) {
      fullVersion = installed.version;
      const versionMatch = installed.version.match(/(\d+)\./);
      majorVersion = versionMatch ? versionMatch[1] : '16';
    }
    
    // Trouver le service PostgreSQL installé via brew
    const brewService = await findBrewPostgresService();
    if (brewService) {
      // Extraire la version du nom du service
      const serviceVersionMatch = brewService.match(/postgresql@?(\d+)/);
      if (serviceVersionMatch) {
        majorVersion = serviceVersionMatch[1];
      }
    }
    
    logger.info(`Detected PostgreSQL version ${fullVersion || majorVersion}, using major version ${majorVersion}`);
    
    // Essayer les chemins possibles selon l'architecture et la version
    const possibleDirs = [
      `/opt/homebrew/var/postgresql@${majorVersion}`, // Apple Silicon avec version
      `/usr/local/var/postgresql@${majorVersion}`, // Intel avec version
      `/opt/homebrew/var/postgres`, // Apple Silicon (version générique)
      `/usr/local/var/postgres`, // Intel (version générique)
      // Essayer aussi sans @ pour les versions récentes
      `/opt/homebrew/var/postgresql`,
      `/usr/local/var/postgresql`
    ];
    
    // Retourner le premier répertoire parent qui existe
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
    
    // Si aucun parent n'existe, retourner le chemin le plus probable selon l'architecture
    const defaultDir = `/opt/homebrew/var/postgresql@${majorVersion}`;
    logger.info(`Using default PostgreSQL data directory: ${defaultDir}`);
    return defaultDir;
  } catch (error: any) {
    logger.warn(`Failed to determine PostgreSQL data directory: ${error.message}`);
  }
  
  // Par défaut, essayer les chemins les plus courants
  return '/opt/homebrew/var/postgresql@17';
}

/**
 * Initialise le répertoire de données PostgreSQL
 */
async function initPostgresDatabase(
  dataDir: string,
  onProgress: (progress: InstallationProgress) => void
): Promise<{ success: boolean; error?: string }> {
  try {
    onProgress({ step: 'initdb', message: `Initializing PostgreSQL database at ${dataDir}...`, progress: 80 });
    logger.info(`Initializing PostgreSQL database at ${dataDir}`);
    
    // Créer le répertoire parent si nécessaire
    const parentDir = dataDir.substring(0, dataDir.lastIndexOf('/'));
    try {
      await execAsync(`mkdir -p "${parentDir}"`);
    } catch (error: any) {
      logger.warn(`Failed to create parent directory: ${error.message}`);
    }
    
    // Trouver initdb en fonction de la version installée
    let initdbPath = '';
    const installed = await checkPostgresInstalled();
    let majorVersion = '17'; // Par défaut PostgreSQL 17
    if (installed.version) {
      const versionMatch = installed.version.match(/(\d+)\./);
      majorVersion = versionMatch ? versionMatch[1] : '17';
    }
    
    logger.info(`Looking for initdb for PostgreSQL ${majorVersion}`);
    
    // Fonction pour vérifier si c'est le bon initdb (celui de PostgreSQL, pas libpq)
    const isValidInitdb = async (path: string): Promise<boolean> => {
      try {
        // Vérifier que le répertoire parent contient aussi "postgres"
        const dir = path.substring(0, path.lastIndexOf('/'));
        const postgresPath = `${dir}/postgres`;
        await execAsync(`test -x "${postgresPath}"`);
        logger.info(`Verified initdb at ${path} is valid (postgres found in same directory)`);
        return true;
      } catch {
        // Si postgres n'est pas dans le même répertoire, c'est probablement libpq
        logger.warn(`initdb at ${path} may be from libpq (postgres not found in same directory)`);
        return false;
      }
    };
    
    // D'abord, essayer de trouver PostgreSQL via brew list
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
    
    // Chercher d'abord dans les chemins spécifiques à PostgreSQL (pas libpq)
    // L'ordre est important : on veut éviter libpq qui est dans /opt/homebrew/bin
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
        let foundPath = '';
        
        // Essayer de vérifier si le fichier existe et est exécutable
        try {
          await execAsync(`test -x "${path}"`);
          foundPath = path;
        } catch {
          // Essayer which
          try {
            const { stdout } = await execAsync(`which ${path} 2>/dev/null`);
            if (stdout.trim()) {
              foundPath = stdout.trim();
            }
          } catch {
            continue;
          }
        }
        
        if (foundPath) {
          // Vérifier que c'est le bon initdb (pas celui de libpq)
          if (await isValidInitdb(foundPath)) {
            initdbPath = foundPath;
            logger.info(`Found valid PostgreSQL initdb at: ${initdbPath}`);
            break;
          } else if (!initdbPath) {
            // Garder en mémoire au cas où on ne trouve rien d'autre
            initdbPath = foundPath;
            logger.warn(`Found initdb at ${foundPath} but may be from libpq, continuing search...`);
          }
        }
      } catch {
        continue;
      }
    }
    
    // Si on n'a trouvé que celui de libpq, rejeter immédiatement
    if (initdbPath && (initdbPath.includes('libpq') || initdbPath.includes('Cellar/libpq'))) {
      logger.error(`Found initdb from libpq at ${initdbPath}, this won't work. Need full PostgreSQL installation.`);
      return {
        success: false,
        error: `Found initdb from libpq (client library) at ${initdbPath}, but need full PostgreSQL server installation.\n\nThe libpq package only provides client tools, not the server.\n\nPlease install PostgreSQL server:\nbrew install postgresql@${majorVersion}\n\nThis will install both the server and client tools including the correct initdb.`
      };
    }
    
    if (!initdbPath) {
      logger.error('Could not find valid PostgreSQL initdb command');
      return {
        success: false,
        error: `Could not find initdb from PostgreSQL server installation.\n\nYou may have libpq (client library) installed but not the full PostgreSQL server.\n\nPlease install PostgreSQL server:\nbrew install postgresql@${majorVersion}\n\nOr find initdb manually:\nfind /opt/homebrew/opt/postgresql* /usr/local/opt/postgresql* -name initdb 2>/dev/null`
      };
    }
    
    // Vérification finale : s'assurer que ce n'est pas libpq (double vérification)
    if (initdbPath && (initdbPath.includes('libpq') || initdbPath.includes('Cellar/libpq'))) {
      logger.error(`Found initdb from libpq at ${initdbPath}, this won't work`);
      return {
        success: false,
        error: `Found initdb from libpq (client library) at ${initdbPath}, but need full PostgreSQL server installation.\n\nThe libpq package only provides client tools, not the server.\n\nPlease install PostgreSQL server:\nbrew install postgresql@${majorVersion}\n\nThis will install both the server and client tools including the correct initdb.`
      };
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
    } catch (error: any) {
      logger.error(`initdb failed: ${error.message}`);
      const errorOutput = error.stdout || error.stderr || error.message;
      return {
        success: false,
        error: `Failed to initialize PostgreSQL database: ${errorOutput}\n\nCommand: ${initdbPath} -D "${dataDir}"`
      };
    }
  } catch (error: any) {
    logger.error(`Failed to initialize PostgreSQL database: ${error.message}`);
    return {
      success: false,
      error: `Failed to initialize PostgreSQL database: ${error.message}`
    };
  }
}

/**
 * Trouve le nom du service PostgreSQL avec brew
 */
async function findBrewPostgresService(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('brew services list');
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
  } catch (error: any) {
    logger.warn(`Failed to list brew services: ${error.message}`);
  }
  
  // Si aucun service n'est trouvé dans brew services, essayer de trouver via brew list
  try {
    const { stdout: brewList } = await execAsync('brew list 2>/dev/null | grep postgresql || echo ""');
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
          logger.info(`Starting PostgreSQL service: ${brewService}`);
          await execAsync(`brew services start ${brewService}`);
          
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
        } catch (error: any) {
          logger.warn(`Brew services start failed: ${error.message}`);
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
        
        for (const service of servicesToTry) {
          try {
            logger.info(`Trying to start service: ${service}`);
            const { stdout, stderr } = await execAsync(`brew services start ${service} 2>&1`);
            logger.info(`Service ${service} output: ${stdout}${stderr ? ` Error: ${stderr}` : ''}`);
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const running = await checkPostgresRunning(port);
            if (running.running) {
              logger.info(`PostgreSQL started successfully via brew services (${service})`);
              return { success: true };
            }
          } catch (error: any) {
            logger.info(`Service ${service} not available or failed: ${error.message}`);
            continue;
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
                const { Client } = await import('pg');
                const testClient = new Client({
                  host: 'localhost',
                  port: port,
                  user: 'postgres',
                  password: '',
                  database: 'postgres',
                  connectionTimeoutMillis: 5000
                });
                await testClient.connect();
                await testClient.end();
                logger.info('PostgreSQL connection test successful');
                return { success: true };
              } catch (connError: any) {
                logger.warn(`PostgreSQL process detected but connection test failed: ${connError.message}`);
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
        } catch (error: any) {
          logger.error(`Manual start failed: ${error.message}`);
          const errorOutput = error.stdout || error.stderr || error.message;
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
      onProgress({ step: 'starting', message: 'Starting PostgreSQL service...', progress: 50 });
      
      try {
        await execAsync('sudo systemctl start postgresql || sudo service postgresql start');
        await new Promise(resolve => setTimeout(resolve, 2000));
        return { success: true };
      } catch (error: any) {
        return {
          success: false,
          error: `Failed to start PostgreSQL: ${error.message}. You may need to run with sudo.`
        };
      }
    } else {
      return {
        success: false,
        error: 'Windows start not yet supported'
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to start PostgreSQL: ${error.message}`
    };
  }
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
          return {
            success: false,
            error: `Only PostgreSQL client (libpq) is installed, but server is required.\n\n${installResult.error}\n\nPlease install PostgreSQL server manually:\nbrew install postgresql@17`
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
            error: `Failed to initialize PostgreSQL database: ${initResult.error}\n\nPlease try manually:\n1. initdb ${dataDirToCreate}\n2. brew services start postgresql@17`
          };
        }
      } else {
        logger.error('Could not determine where to create PostgreSQL data directory');
        return {
          success: false,
          error: 'Could not determine where to create PostgreSQL data directory. Please initialize manually:\n1. initdb /opt/homebrew/var/postgresql@17\n2. brew services start postgresql@17'
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
            const { Client } = await import('pg');
            const testClient = new Client({
              host: 'localhost',
              port: port,
              user: user,
              password: '',
              database: 'postgres',
              connectionTimeoutMillis: 5000
            });
            
            await testClient.connect();
            await testClient.end();
            
            logger.info(`PostgreSQL is actually accessible with user ${user}`);
            running = { running: true, port };
            break;
          } catch (error: any) {
            logger.info(`Connection failed with user ${user}: ${error.message}`);
            continue;
          }
        }
        
        if (!running.running) {
          // PostgreSQL n'est vraiment pas accessible
          logger.error(`PostgreSQL connection test failed with all users`);
          return {
            success: false,
            error: startResult.error || `PostgreSQL is not running on port ${port} and could not be started automatically.\n\nPlease try manually:\n1. brew services start postgresql@17\n2. Or: pg_ctl -D /opt/homebrew/var/postgresql@17 start`
          };
        }
      }
    }
    
    if (running.running) {
      logger.info(`PostgreSQL is running on port ${port}${running.details ? ` (${running.details})` : ''}`);
    } else {
      return {
        success: false,
        error: `PostgreSQL is not running on port ${port}.\n\nPlease start it manually:\n1. brew services start postgresql@17\n2. Or: pg_ctl -D /opt/homebrew/var/postgresql@17 start`
      };
    }

    // Vérification finale : s'assurer que PostgreSQL est vraiment accessible
    onProgress({ step: 'verifying', message: 'Verifying PostgreSQL connection...', progress: 98 });
    
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
        const { Client } = await import('pg');
        const verifyClient = new Client({
          host: 'localhost',
          port: port,
          user: user,
          password: '',
          database: 'postgres',
          connectionTimeoutMillis: 5000
        });
        
        await verifyClient.connect();
        await verifyClient.end();
        postgresUser = user;
        connected = true;
        logger.info(`PostgreSQL connection verified successfully on port ${port} with user: ${user}`);
        break;
      } catch (error: any) {
        connectionError = error.message;
        logger.info(`Connection failed with user ${user}: ${error.message}`);
        continue;
      }
    }
    
    // Si la connexion a échoué avec "postgres" mais réussit avec l'utilisateur système, créer postgres
    if (!connected && (connectionError.includes('does not exist') || connectionError.includes('role'))) {
      logger.info('PostgreSQL user "postgres" does not exist, attempting to create it...');
      onProgress({ step: 'creating_user', message: 'Creating PostgreSQL user "postgres"...', progress: 99 });
      
      // Essayer de se connecter avec l'utilisateur système pour créer postgres
      try {
        const { Client } = await import('pg');
        const adminClient = new Client({
          host: 'localhost',
          port: port,
          user: currentUser,
          password: '',
          database: 'postgres',
          connectionTimeoutMillis: 5000
        });
        
        await adminClient.connect();
        logger.info(`Connected as ${currentUser}, creating postgres user...`);
        
        // Créer l'utilisateur postgres s'il n'existe pas
        try {
          await adminClient.query(`CREATE ROLE postgres WITH SUPERUSER LOGIN;`);
          logger.info('Successfully created PostgreSQL user "postgres"');
          
          // Tester la connexion avec postgres
          await adminClient.end();
          
          const { Client: PostgresClient } = await import('pg');
          const testClient = new PostgresClient({
            host: 'localhost',
            port: port,
            user: 'postgres',
            password: '',
            database: 'postgres',
            connectionTimeoutMillis: 5000
          });
          await testClient.connect();
          await testClient.end();
          postgresUser = 'postgres';
          connected = true;
          logger.info('PostgreSQL connection verified with newly created postgres user');
        } catch (createError: any) {
          // L'utilisateur existe peut-être déjà ou erreur de permissions
          if (createError.message.includes('already exists')) {
            logger.info('PostgreSQL user "postgres" already exists');
            // Réessayer la connexion avec postgres
            await adminClient.end();
            try {
              const { Client: PostgresClient } = await import('pg');
              const testClient = new PostgresClient({
                host: 'localhost',
                port: port,
                user: 'postgres',
                password: '',
                database: 'postgres',
                connectionTimeoutMillis: 5000
              });
              await testClient.connect();
              await testClient.end();
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
            logger.warn(`Could not create postgres user: ${createError.message}, will use system user`);
            await adminClient.end();
            postgresUser = currentUser;
            connected = true;
          }
        }
      } catch (adminError: any) {
        logger.warn(`Could not connect as ${currentUser} to create postgres user: ${adminError.message}`);
        // Si on ne peut pas créer postgres, utiliser l'utilisateur système
        postgresUser = currentUser;
        connected = true;
        logger.info(`Will use system user ${currentUser} for PostgreSQL connections`);
      }
    }
    
    if (!connected) {
      logger.error(`PostgreSQL connection verification failed: ${connectionError}`);
      return {
        success: false,
        error: `PostgreSQL appears to be running but is not accessible.\n\nError: ${connectionError}\n\nThe system will try to use your system user (${currentUser}) for connections.`
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
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to ensure PostgreSQL: ${error.message}`
    };
  }
}


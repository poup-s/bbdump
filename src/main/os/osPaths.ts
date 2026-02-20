import { OSType, Architecture } from './osDetector';

export interface ToolPaths {
  pgDump: string[];
  psql: string[];
  pgRestore: string[];
  pgConfig: string[];
  initdb: string[];
  postgres: string[];
  pg_ctl?: string[];
  brew?: string[]; // macOS uniquement
}

/**
 * Retourne les chemins standards pour chaque outil selon l'OS et l'architecture
 */
export function getToolPaths(os: OSType, arch?: Architecture): ToolPaths {
  if (os === 'macos') {
    const isAppleSilicon = arch === 'arm64';
    const homebrewPrefix = isAppleSilicon ? '/opt/homebrew' : '/usr/local';
    
    // Versions PostgreSQL courantes à vérifier
    const postgresVersions = ['17', '16', '15', '14'];
    
    // Chemins génériques (dans PATH après installation)
    const genericPaths = [
      `${homebrewPrefix}/bin`,
      '/usr/local/bin',
      '/usr/bin'
    ];
    
    // Chemins spécifiques par version PostgreSQL
    const versionSpecificPaths: string[] = [];
    for (const version of postgresVersions) {
      versionSpecificPaths.push(
        `${homebrewPrefix}/opt/postgresql@${version}/bin`,
        `/usr/local/opt/postgresql@${version}/bin`
      );
    }
    
    // Chemins pour EnterpriseDB et Postgres.app
    const otherPaths = [
      '/Library/PostgreSQL/*/bin',
      '/Applications/Postgres.app/Contents/Versions/*/bin'
    ];
    
    // Construire les chemins pour chaque outil
    const buildPaths = (tool: string): string[] => {
      const paths: string[] = [];
      
      // D'abord les chemins spécifiques par version
      for (const versionPath of versionSpecificPaths) {
        paths.push(`${versionPath}/${tool}`);
      }
      
      // Ensuite les chemins génériques
      for (const genericPath of genericPaths) {
        paths.push(`${genericPath}/${tool}`);
      }
      
      // Enfin les autres chemins (avec wildcard)
      for (const otherPath of otherPaths) {
        paths.push(`${otherPath}/${tool}`);
      }
      
      return paths;
    };
    
    return {
      pgDump: buildPaths('pg_dump'),
      psql: buildPaths('psql'),
      pgRestore: buildPaths('pg_restore'),
      pgConfig: buildPaths('pg_config'),
      initdb: buildPaths('initdb'),
      postgres: buildPaths('postgres'),
      pg_ctl: buildPaths('pg_ctl'),
      brew: [
        `${homebrewPrefix}/bin/brew`,
        '/usr/local/bin/brew'
      ]
    };
  } else if (os === 'linux') {
    // Linux: version-specific paths FIRST (higher version preferred),
    // then generic paths as fallback. This avoids using an old system
    // pg_dump (e.g. v14 from apt) when a newer version is available.
    const buildLinuxPaths = (tool: string): string[] => [
      // Version-specific paths (wildcard resolves to highest version)
      `/usr/lib/postgresql/*/bin/${tool}`,
      `/opt/postgresql/*/bin/${tool}`,
      `/usr/local/lib/postgresql/*/bin/${tool}`,
      // RHEL/Fedora paths
      `/usr/pgsql-*/bin/${tool}`,
      // Generic system paths (may be older version from apt/dnf)
      `/usr/local/bin/${tool}`,
      `/usr/bin/${tool}`,
    ];

    return {
      pgDump: buildLinuxPaths('pg_dump'),
      psql: buildLinuxPaths('psql'),
      pgRestore: buildLinuxPaths('pg_restore'),
      pgConfig: buildLinuxPaths('pg_config'),
      initdb: buildLinuxPaths('initdb'),
      postgres: buildLinuxPaths('postgres'),
      pg_ctl: buildLinuxPaths('pg_ctl'),
    };
  } else {
    // Windows
    return {
      pgDump: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\pg_dump.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\pg_dump.exe'
      ],
      psql: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\psql.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\psql.exe'
      ],
      pgRestore: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\pg_restore.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\pg_restore.exe'
      ],
      pgConfig: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\pg_config.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\pg_config.exe'
      ],
      initdb: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\initdb.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\initdb.exe'
      ],
      postgres: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\postgres.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\postgres.exe'
      ],
      pg_ctl: [
        'C:\\Program Files\\PostgreSQL\\*\\bin\\pg_ctl.exe',
        'C:\\Program Files (x86)\\PostgreSQL\\*\\bin\\pg_ctl.exe'
      ]
    };
  }
}

/**
 * Retourne les répertoires de données PostgreSQL possibles selon l'OS et la version
 */
export function getPostgresDataDirs(os: OSType, version?: string, arch?: Architecture): string[] {
  if (os === 'macos') {
    const isAppleSilicon = arch === 'arm64';
    const homebrewPrefix = isAppleSilicon ? '/opt/homebrew' : '/usr/local';
    const majorVersion = version ? version.split('.')[0] : '17';
    
    return [
      `${homebrewPrefix}/var/postgresql@${majorVersion}`,
      `${homebrewPrefix}/var/postgres`,
      `/usr/local/var/postgresql@${majorVersion}`,
      `/usr/local/var/postgres`,
      '/usr/local/pgsql/data',
      '/Library/PostgreSQL/*/data'
    ];
  } else if (os === 'linux') {
    return [
      '/var/lib/postgresql/*/main',
      '/usr/local/pgsql/data',
      '/opt/postgresql/*/data'
    ];
  } else {
    // Windows
    return [
      'C:\\Program Files\\PostgreSQL\\*\\data',
      'C:\\ProgramData\\PostgreSQL\\*\\data'
    ];
  }
}

/**
 * Retourne les noms de services PostgreSQL possibles selon l'OS et la version
 */
export function getPostgresServiceNames(os: OSType, version?: string): string[] {
  const majorVersion = version ? version.split('.')[0] : '17';
  
  if (os === 'macos') {
    return [
      `postgresql@${majorVersion}`,
      'postgresql@17',
      'postgresql@16',
      'postgresql@15',
      'postgresql@14',
      'postgresql'
    ];
  } else if (os === 'linux') {
    return [
      `postgresql@${majorVersion}`,
      'postgresql',
      'postgresql.service'
    ];
  } else {
    // Windows
    return [
      `postgresql-x64-${majorVersion}`,
      'postgresql-x64-16',
      'postgresql-x64-15',
      'postgresql-x64-14'
    ];
  }
}





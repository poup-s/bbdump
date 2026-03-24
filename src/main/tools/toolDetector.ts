import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { detectOS, getOSType } from '../os/osDetector';
import { getToolPaths } from '../os/osPaths';
import { logger } from '../logger';

const execAsync = promisify(exec);

export interface ToolDetectionResult {
  installed: boolean;
  path?: string;
  method?: 'which' | 'standard_path' | 'unknown';
  version?: string;
  error?: string;
}

/**
 * Resolves a wildcard path by searching for matching files
 */
async function resolveWildcardPath(wildcardPath: string): Promise<string[]> {
  if (!wildcardPath.includes('*')) {
    return [wildcardPath];
  }

  const resolved: string[] = [];

  try {
    // Extract the parent directory and pattern
    const parts = wildcardPath.split('*');
    const baseDir = parts[0].substring(0, parts[0].lastIndexOf('/'));
    const suffix = parts[parts.length - 1];

    if (fs.existsSync(baseDir)) {
      const entries = fs.readdirSync(baseDir);
      // Sort entries by version number descending (e.g., 17 before 16 before 14)
      // so that the highest version is found first
      entries.sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, '')) || 0;
        const numB = parseInt(b.replace(/\D/g, '')) || 0;
        return numB - numA;
      });
      for (const entry of entries) {
        const fullPath = path.join(baseDir, entry, suffix);
        if (fs.existsSync(fullPath)) {
          resolved.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore resolution errors
  }

  return resolved;
}

/**
 * Detects a tool using which first, then standard paths
 */
export async function detectTool(
  toolName: string,
  possiblePaths?: string[]
): Promise<ToolDetectionResult> {
  const isLinux = getOSType() === 'linux';

  // On Linux, check version-specific paths FIRST (before `which`) because `which`
  // returns the system package version (e.g. pg_dump v14 from apt) while a newer
  // version (v17) may be installed at /usr/lib/postgresql/17/bin/pg_dump.
  // On macOS, `which` is fine because Homebrew manages PATH correctly.
  if (!isLinux) {
    // Step 1 (macOS/Windows): Try which
    try {
      const { stdout } = await execAsync(`which ${toolName} 2>/dev/null || echo ""`);
      const whichPath = stdout.trim();

      if (whichPath && !whichPath.includes('not found') && fs.existsSync(whichPath)) {
        let version: string | undefined;
        try {
          const { stdout: versionOutput } = await execAsync(`${whichPath} --version 2>/dev/null || echo ""`);
          const versionMatch = versionOutput.match(/(\d+\.\d+)/);
          version = versionMatch ? versionMatch[1] : undefined;
        } catch {
          // Ignore
        }

        return {
          installed: true,
          path: whichPath,
          method: 'which',
          version
        };
      }
    } catch {
      // Continue with standard paths
    }
  }

  // Step 2: Check the provided standard paths (version-specific first on Linux)
  if (possiblePaths && possiblePaths.length > 0) {
    for (const testPath of possiblePaths) {
      // Resolve wildcards
      const resolvedPaths = await resolveWildcardPath(testPath);
      
      for (const resolvedPath of resolvedPaths) {
        if (fs.existsSync(resolvedPath)) {
          // Check that it's executable (or at least a file)
          try {
            await execAsync(`test -x "${resolvedPath}" || test -f "${resolvedPath}"`);
            
            // Check the version if possible
            let version: string | undefined;
            try {
              const { stdout: versionOutput } = await execAsync(`${resolvedPath} --version 2>/dev/null || echo ""`);
              const versionMatch = versionOutput.match(/(\d+\.\d+)/);
              version = versionMatch ? versionMatch[1] : undefined;
            } catch {
              // Ignore version errors
            }
            
            return {
              installed: true,
              path: resolvedPath,
              method: 'standard_path',
              version
            };
          } catch {
            // Continue with the next path
            continue;
          }
        }
      }
    }
  }
  
  // On Linux, try `which` as last resort (after version-specific paths)
  if (isLinux) {
    try {
      const { stdout } = await execAsync(`which ${toolName} 2>/dev/null || echo ""`);
      const whichPath = stdout.trim();

      if (whichPath && !whichPath.includes('not found') && fs.existsSync(whichPath)) {
        let version: string | undefined;
        try {
          const { stdout: versionOutput } = await execAsync(`${whichPath} --version 2>/dev/null || echo ""`);
          const versionMatch = versionOutput.match(/(\d+\.\d+)/);
          version = versionMatch ? versionMatch[1] : undefined;
        } catch {
          // Ignore
        }

        return {
          installed: true,
          path: whichPath,
          method: 'which',
          version
        };
      }
    } catch {
      // Ignore
    }
  }

  // If nothing is found
  return {
    installed: false,
    error: `${toolName} not found`
  };
}

/**
 * Detects all PostgreSQL tools
 */
export async function detectPostgresTools(): Promise<{
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  pgRestore: ToolDetectionResult;
  postgres: ToolDetectionResult;
  pgConfig?: ToolDetectionResult;
}> {
  const os = detectOS();
  const toolPaths = getToolPaths(os.type, os.architecture);
  
  const [pgDump, psql, pgRestore, postgres, pgConfig] = await Promise.all([
    detectTool('pg_dump', toolPaths.pgDump),
    detectTool('psql', toolPaths.psql),
    detectTool('pg_restore', toolPaths.pgRestore),
    detectTool('postgres', toolPaths.postgres),
    detectTool('pg_config', toolPaths.pgConfig).catch(() => ({
      installed: false,
      error: 'pg_config not found'
    }))
  ]);
  
  return {
    pgDump,
    psql,
    pgRestore,
    postgres,
    pgConfig: pgConfig as ToolDetectionResult
  };
}

/**
 * Detects Homebrew (macOS only)
 */
export async function detectHomebrew(): Promise<ToolDetectionResult> {
  const os = getOSType();
  
  if (os !== 'macos') {
    return {
      installed: true, // Not required on Linux/Windows
      method: 'unknown'
    };
  }
  
  const osInfo = detectOS();
  const toolPaths = getToolPaths('macos', osInfo.architecture);
  
  return detectTool('brew', toolPaths.brew);
}

/**
 * Finds the path of a PostgreSQL tool (for compatibility with backup.ts)
 */
export async function findPostgresCommand(command: string): Promise<string> {
  const os = detectOS();
  const toolPaths = getToolPaths(os.type, os.architecture);
  
  let paths: string[] = [];
  
  switch (command) {
    case 'pg_dump':
      paths = toolPaths.pgDump;
      break;
    case 'psql':
      paths = toolPaths.psql;
      break;
    case 'pg_restore':
      paths = toolPaths.pgRestore;
      break;
    case 'postgres':
      paths = toolPaths.postgres;
      break;
    case 'pg_config':
      paths = toolPaths.pgConfig || [];
      break;
    case 'initdb':
      paths = toolPaths.initdb;
      break;
    case 'pg_ctl':
      paths = toolPaths.pg_ctl || [];
      break;
    default:
      paths = [];
  }
  
  const result = await detectTool(command, paths);
  
  if (result.installed && result.path) {
    return result.path;
  }
  
  // Fallback: return the command name to use the system PATH
  logger.warn(`${command} not found in standard locations, using system PATH`);
  return command;
}





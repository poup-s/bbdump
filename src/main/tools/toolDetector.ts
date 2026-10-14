import * as fs from 'fs';
import * as path from 'path';
import { detectOS, getOSType } from '../os/osDetector';
import { getToolPaths } from '../os/osPaths';
import { logger } from '../logger';
import { defaultWhich, run } from '../platform/probe';


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
    // Folders end with \ on Windows, / elsewhere
    const baseDir = parts[0].substring(0, Math.max(parts[0].lastIndexOf('/'), parts[0].lastIndexOf('\\')));
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

/** Version printed by `<tool> --version`, run without a shell (and without a console window on Windows) */
async function toolVersion(toolPath: string): Promise<string | undefined> {
  const result = await run(toolPath, ['--version'], 10000);
  const match = `${result.stdout}${result.stderr}`.match(/(\d+\.\d+)/);
  return match ? match[1] : undefined;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Detects a tool: PATH first (macOS, Windows), or the version-specific folders first (Linux,
 * where PATH gives the distribution's older version). No shell, so the same everywhere.
 */
export async function detectTool(
  toolName: string,
  possiblePaths?: string[]
): Promise<ToolDetectionResult> {
  const isLinux = getOSType() === 'linux';
  const fromPath = async (): Promise<ToolDetectionResult | null> => {
    const found = await defaultWhich(toolName);
    return found ? { installed: true, path: found, method: 'which', version: await toolVersion(found) } : null;
  };

  if (!isLinux) {
    const found = await fromPath();
    if (found) return found;
  }

  for (const testPath of possiblePaths ?? []) {
    for (const resolvedPath of await resolveWildcardPath(testPath)) {
      if (isFile(resolvedPath)) {
        return { installed: true, path: resolvedPath, method: 'standard_path', version: await toolVersion(resolvedPath) };
      }
    }
  }

  if (isLinux) {
    const found = await fromPath();
    if (found) return found;
  }

  return { installed: false, error: `${toolName} not found` };
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





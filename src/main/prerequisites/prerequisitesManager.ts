import { detectOS, getOSType } from '../os/osDetector';
import { getErrorMessage } from '../utils';
import { detectPostgresTools, detectHomebrew, ToolDetectionResult } from '../tools/toolDetector';
import { getToolPaths } from '../os/osPaths';
import { checkPostgresInstalled } from '../postgresManager';
import { logger } from '../logger';

export interface PrerequisitesResult {
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  homebrew?: ToolDetectionResult; // macOS only
  postgresServer: {
    installed: boolean;
    version?: string;
    hasServer?: boolean;
    error?: string;
  };
}

/**
 * Checks all prerequisites needed to use the application
 */
export async function checkPrerequisites(): Promise<PrerequisitesResult> {
  const os = detectOS();
  const _toolPaths = getToolPaths(os.type, os.architecture);
  
  logger.info(`Checking prerequisites on ${os.type} (${os.architecture})`);
  
  // Detect PostgreSQL tools
  const postgresTools = await detectPostgresTools();
  
  // Detect Homebrew (macOS only)
  let homebrew: ToolDetectionResult | undefined;
  if (os.type === 'macos') {
    homebrew = await detectHomebrew();
  }
  
  // Check PostgreSQL Server
  let postgresServer: PrerequisitesResult['postgresServer'] = {
    installed: false
  };
  
  try {
    const postgresCheck = await checkPostgresInstalled();
    if (postgresCheck.installed) {
      postgresServer = {
        installed: true,
        version: postgresCheck.version,
        hasServer: postgresCheck.hasServer
      };
    } else {
      postgresServer.error = 'PostgreSQL server not found';
    }
  } catch (error) {
    postgresServer.error = getErrorMessage(error) || 'PostgreSQL verification failed';
  }
  
  return {
    pgDump: postgresTools.pgDump,
    psql: postgresTools.psql,
    homebrew,
    postgresServer
  };
}

/**
 * Checks if all required prerequisites are installed
 */
export function areRequiredPrerequisitesInstalled(prerequisites: PrerequisitesResult): boolean {
  // pg_dump et psql sont requis
  if (!prerequisites.pgDump.installed || !prerequisites.psql.installed) {
    return false;
  }
  
  // On macOS, if we want to create local DBs, Homebrew and PostgreSQL Server are required
  // But for now, we consider them optional
  // (the user can still connect to remote DBs)
  
  return true;
}

/**
 * Returns the list of missing tools
 */
export function getMissingPrerequisites(prerequisites: PrerequisitesResult): string[] {
  const missing: string[] = [];
  
  if (!prerequisites.pgDump.installed) {
    missing.push('pg_dump');
  }
  
  if (!prerequisites.psql.installed) {
    missing.push('psql');
  }
  
  if (getOSType() === 'macos') {
    if (!prerequisites.homebrew?.installed) {
      missing.push('Homebrew');
    }
    
    if (!prerequisites.postgresServer.installed) {
      missing.push('PostgreSQL Server');
    }
  }
  
  return missing;
}





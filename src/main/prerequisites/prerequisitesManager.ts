import { detectOS } from '../os/osDetector';
import { getErrorMessage } from '../utils';
import { detectPostgresTools, detectHomebrew, ToolDetectionResult } from '../tools/toolDetector';
import { getToolPaths } from '../os/osPaths';
import { checkPostgresInstalled } from '../postgresManager';
import { logger } from '../logger';

export interface PrerequisitesResult {
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  pgRestore: ToolDetectionResult;
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
    pgRestore: postgresTools.pgRestore,
    homebrew,
    postgresServer
  };
}

/**
 * Checks if all required prerequisites are installed
 */
export function areRequiredPrerequisitesInstalled(prerequisites: PrerequisitesResult): boolean {
  // The client tools are required; Homebrew and a local PostgreSQL server are optional
  // (only needed to create/manage local databases — remote-only use works without them)
  return getMissingPrerequisites(prerequisites).length === 0;
}

/**
 * Returns the list of missing required tools
 */
export function getMissingPrerequisites(prerequisites: PrerequisitesResult): string[] {
  const missing: string[] = [];

  if (!prerequisites.pgDump.installed) {
    missing.push('pg_dump');
  }

  if (!prerequisites.psql.installed) {
    missing.push('psql');
  }

  if (!prerequisites.pgRestore.installed) {
    missing.push('pg_restore');
  }

  return missing;
}





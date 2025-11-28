import { detectOS, getOSType } from '../os/osDetector';
import { detectTool, detectPostgresTools, detectHomebrew, ToolDetectionResult } from '../tools/toolDetector';
import { getToolPaths } from '../os/osPaths';
import { checkPostgresInstalled } from '../postgresManager';
import { logger } from '../logger';

export interface PrerequisitesResult {
  pgDump: ToolDetectionResult;
  psql: ToolDetectionResult;
  homebrew?: ToolDetectionResult; // macOS uniquement
  postgresServer: {
    installed: boolean;
    version?: string;
    hasServer?: boolean;
    error?: string;
  };
}

/**
 * Vérifie tous les prérequis nécessaires pour utiliser l'application
 */
export async function checkPrerequisites(): Promise<PrerequisitesResult> {
  const os = detectOS();
  const toolPaths = getToolPaths(os.type, os.architecture);
  
  logger.info(`Vérification des prérequis sur ${os.type} (${os.architecture})`);
  
  // Détecter les outils PostgreSQL
  const postgresTools = await detectPostgresTools();
  
  // Détecter Homebrew (macOS uniquement)
  let homebrew: ToolDetectionResult | undefined;
  if (os.type === 'macos') {
    homebrew = await detectHomebrew();
  }
  
  // Vérifier PostgreSQL Server
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
      postgresServer.error = 'Serveur PostgreSQL non trouvé';
    }
  } catch (error: any) {
    postgresServer.error = error.message || 'Échec de la vérification de PostgreSQL';
  }
  
  return {
    pgDump: postgresTools.pgDump,
    psql: postgresTools.psql,
    homebrew,
    postgresServer
  };
}

/**
 * Vérifie si tous les prérequis requis sont installés
 */
export function areRequiredPrerequisitesInstalled(prerequisites: PrerequisitesResult): boolean {
  // pg_dump et psql sont requis
  if (!prerequisites.pgDump.installed || !prerequisites.psql.installed) {
    return false;
  }
  
  // Sur macOS, si on veut créer des DB locales, Homebrew et PostgreSQL Server sont requis
  // Mais pour l'instant, on considère qu'ils sont optionnels
  // (l'utilisateur peut toujours se connecter à des DB distantes)
  
  return true;
}

/**
 * Retourne la liste des outils manquants
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


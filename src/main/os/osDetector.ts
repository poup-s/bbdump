import * as os from 'os';

export type OSType = 'macos' | 'linux' | 'windows';
export type Architecture = 'arm64' | 'x64' | 'ia32';

export interface OSInfo {
  type: OSType;
  platform: string; // 'darwin', 'linux', 'win32'
  architecture: Architecture;
  isAppleSilicon: boolean; // Pour macOS uniquement
}

/**
 * Détecte le type d'OS à partir de process.platform
 */
export function detectOS(): OSInfo {
  const platform = os.platform();
  const arch = os.arch();
  
  let type: OSType;
  if (platform === 'darwin') {
    type = 'macos';
  } else if (platform === 'win32') {
    type = 'windows';
  } else {
    type = 'linux';
  }
  
  // Déterminer l'architecture
  let architecture: Architecture;
  if (arch === 'arm64' || arch === 'aarch64') {
    architecture = 'arm64';
  } else if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') {
    architecture = 'x64';
  } else {
    architecture = 'ia32';
  }
  
  // Pour macOS, vérifier si c'est Apple Silicon
  const isAppleSilicon = type === 'macos' && architecture === 'arm64';
  
  return {
    type,
    platform,
    architecture,
    isAppleSilicon
  };
}

/**
 * Vérifie si l'OS actuel est macOS
 */
export function isMacOS(): boolean {
  return detectOS().type === 'macos';
}

/**
 * Vérifie si l'OS actuel est Linux
 */
export function isLinux(): boolean {
  return detectOS().type === 'linux';
}

/**
 * Vérifie si l'OS actuel est Windows
 */
export function isWindows(): boolean {
  return detectOS().type === 'windows';
}

/**
 * Retourne le type d'OS actuel
 */
export function getOSType(): OSType {
  return detectOS().type;
}



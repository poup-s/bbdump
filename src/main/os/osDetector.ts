import * as os from 'os';

export type OSType = 'macos' | 'linux' | 'windows';
export type Architecture = 'arm64' | 'x64' | 'ia32';

export interface OSInfo {
  type: OSType;
  platform: string; // 'darwin', 'linux', 'win32'
  architecture: Architecture;
  isAppleSilicon: boolean; // For macOS only
}

/**
 * Detects the OS type from process.platform
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
  
  // Determine the architecture
  let architecture: Architecture;
  if (arch === 'arm64' || arch === 'aarch64') {
    architecture = 'arm64';
  } else if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') {
    architecture = 'x64';
  } else {
    architecture = 'ia32';
  }
  
  // For macOS, check if it's Apple Silicon
  const isAppleSilicon = type === 'macos' && architecture === 'arm64';
  
  return {
    type,
    platform,
    architecture,
    isAppleSilicon
  };
}

/**
 * Checks if the current OS is macOS
 */
export function isMacOS(): boolean {
  return detectOS().type === 'macos';
}

/**
 * Checks if the current OS is Linux
 */
export function isLinux(): boolean {
  return detectOS().type === 'linux';
}

/**
 * Checks if the current OS is Windows
 */
export function isWindows(): boolean {
  return detectOS().type === 'windows';
}

/**
 * Returns the current OS type
 */
export function getOSType(): OSType {
  return detectOS().type;
}





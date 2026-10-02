/**
 * Windows adapter, prepared but not enabled (SetupEnvironment.supported is false):
 * it only describes what to run. Nothing here executes anything.
 */
import type { SetupComponent } from '../../types/setup';

export const WINDOWS_SUPPORTED = false;

/** winget package for the EDB installer (server + command line tools). */
export const WINGET_POSTGRES_ID = 'PostgreSQL.PostgreSQL.17';

/** Where the EDB installer puts the binaries (wildcard = major version). */
export const WINDOWS_PG_BIN_DIRS = [
  'C:\\Program Files\\PostgreSQL\\*\\bin',
  'C:\\Program Files (x86)\\PostgreSQL\\*\\bin',
];

/** Candidate winget locations (it lives in WindowsApps, reachable through PATH). */
export function wingetCandidates(localAppData = process.env.LOCALAPPDATA || ''): string[] {
  return localAppData ? [`${localAppData}\\Microsoft\\WindowsApps\\winget.exe`] : [];
}

export function windowsCommand(component: SetupComponent): string {
  switch (component) {
    case 'homebrew':
      return '';
    case 'client-tools':
      // The EDB installer has no client-only package on winget: it installs everything,
      // the server service can be left stopped
      return `winget install -e --id ${WINGET_POSTGRES_ID} --accept-package-agreements --accept-source-agreements`;
    case 'server':
      return `winget install -e --id ${WINGET_POSTGRES_ID} --accept-package-agreements --accept-source-agreements`;
  }
}

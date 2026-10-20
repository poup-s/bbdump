/**
 * Windows adapter (beta). winget runs the EDB installer: its command line tools only, or the
 * server too (a Windows service started with the computer, "postgres" superuser with a
 * password bbdump generates and keeps encrypted). This module describes the commands,
 * install.ts runs them.
 */
import type { SetupComponent } from '../../types/setup';

export const WINDOWS_SUPPORTED = true;

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
      // The EDB installer through winget, asked for its command line tools only (no server,
      // pgAdmin or Stack Builder); bbdump finds them in Program Files\PostgreSQL\<v>\bin
      return `winget ${wingetClientToolsArgs(WINGET_CLIENT_MAJORS[WINGET_CLIENT_MAJORS.length - 1]).map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
    case 'server':
      // By hand, the EDB installer's own window asks for the password: bbdump asks for it after
      return `winget install -e --id ${WINGET_POSTGRES_ID} --accept-package-agreements --accept-source-agreements`;
  }
}

/** PostgreSQL versions tried with winget, newest first (a version winget lacks is skipped) */
export const WINGET_CLIENT_MAJORS = ['18', '17'];

/** EDB installer options: its command line tools only, no window to answer */
const CLIENT_ONLY_OVERRIDE = '--mode unattended --unattendedmodeui minimal --enable-components commandlinetools --disable-components server,pgAdmin,stackbuilder';

/** winget arguments installing PostgreSQL <major>'s client tools (run without a shell) */
export function wingetClientToolsArgs(major: string): string[] {
  return [
    'install', '-e', '--id', `PostgreSQL.PostgreSQL.${major}`,
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
    '--override', CLIENT_ONLY_OVERRIDE,
  ];
}

/** What a winget run means for bbdump, from its exit code and output */
export function wingetOutcome(code: number | null, output: string): 'installed' | 'not-found' | 'cancelled' | 'failed' {
  const text = output.toLowerCase();
  if (code === 0 || /already installed|déjà installé/.test(text)) return 'installed';
  // 0x8A150014: no package matches the id
  if (code === -1978335212 || code === 2316632084 || /no package found|aucun package/.test(text)) return 'not-found';
  // 1223 / 0x800704C7: the administrator prompt was refused
  if (code === 1223 || code === -2147023673 || /cancel|annul/.test(text)) return 'cancelled';
  return 'failed';
}

/** The Windows service the EDB installer creates for PostgreSQL <major> */
export function windowsServiceName(major: string): string {
  return `postgresql-x64-${major}`;
}

/**
 * EDB installer option file for the server (one option=value per line), so the password
 * never appears on a command line. The service starts with Windows.
 */
export function serverOptionFile(password: string, port = 5432): string {
  return [
    'mode=unattended',
    'unattendedmodeui=minimal',
    `superpassword=${password}`,
    `serverport=${port}`,
    'enable-components=server,commandlinetools',
    'disable-components=pgAdmin,stackbuilder',
    '',
  ].join('\r\n');
}

/**
 * winget arguments installing PostgreSQL <major>'s server with an option file. --force runs
 * the installer again when winget already installed this version's client tools.
 */
export function wingetServerArgs(major: string, optionFile: string): string[] {
  return [
    'install', '-e', '--id', `PostgreSQL.PostgreSQL.${major}`, '--force',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
    '--override', `--optionfile "${optionFile}"`,
  ];
}

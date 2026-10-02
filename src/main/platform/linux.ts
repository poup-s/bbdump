/**
 * Linux adapter: distro detection from /etc/os-release, and one bash script per
 * component, run as root through a single `pkexec` (one graphical password prompt).
 * Electron-free so it can be tested with plain node.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LinuxFamily, PackageManagerId, SetupComponent } from '../../types/setup';

export type LinuxComponent = Extract<SetupComponent, 'client-tools' | 'server'>;

export interface LinuxDistro {
  id: string;
  name: string;
  family: LinuxFamily;
  version?: string;
}

// ─── os-release ─────────────────────────────────────────────────────────────

/** Parses os-release(5) text (KEY=value, optionally quoted) into a map. */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\`$])/g, '$1');
    }
    fields[key] = value;
  }
  return fields;
}

const DEBIAN_IDS = ['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'raspbian', 'kali', 'zorin',
  'neon', 'deepin', 'mx', 'devuan', 'pureos', 'parrot', 'kubuntu', 'xubuntu', 'lubuntu', 'tuxedo'];
const FEDORA_IDS = ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol', 'amzn', 'nobara',
  'ultramarine', 'circle', 'eurolinux', 'scientific'];
const ARCH_IDS = ['arch', 'manjaro', 'endeavouros', 'garuda', 'artix', 'cachyos', 'arcolinux', 'archarm'];

/** Groups a distro by packaging family, from ID then ID_LIKE. */
export function linuxFamily(fields: Record<string, string>): LinuxFamily {
  const id = (fields.ID || '').toLowerCase();
  const like = (fields.ID_LIKE || '').toLowerCase().split(/\s+/).filter(Boolean);

  const fromId = (value: string): LinuxFamily => {
    if (DEBIAN_IDS.includes(value)) return 'debian';
    if (FEDORA_IDS.includes(value)) return 'fedora';
    if (ARCH_IDS.includes(value)) return 'arch';
    if (value.startsWith('opensuse') || value === 'sles' || value === 'sled' || value === 'suse') return 'suse';
    return 'unknown';
  };

  const direct = fromId(id);
  if (direct !== 'unknown') return direct;
  for (const value of like) {
    const family = fromId(value);
    if (family !== 'unknown') return family;
  }
  return 'unknown';
}

export function parseDistro(osReleaseText: string): LinuxDistro {
  const fields = parseOsRelease(osReleaseText);
  return {
    id: fields.ID || 'linux',
    name: fields.PRETTY_NAME || fields.NAME || 'Linux',
    family: linuxFamily(fields),
    version: fields.VERSION_ID || undefined,
  };
}

/** Reads /etc/os-release (or /usr/lib/os-release). Empty string when unreadable. */
export function readOsRelease(): string {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      // Try the next one
    }
  }
  return '';
}

/** Package managers to look for, in order, for a family. */
export function packageManagersFor(family: LinuxFamily): Exclude<PackageManagerId, 'brew' | 'winget'>[] {
  switch (family) {
    case 'debian': return ['apt'];
    case 'fedora': return ['dnf', 'yum'];
    case 'arch': return ['pacman'];
    case 'suse': return ['zypper'];
    default: return ['apt', 'dnf', 'yum', 'pacman', 'zypper'];
  }
}

/** Binary name for a package manager id ("apt" is driven through apt-get). */
export function packageManagerBinary(id: PackageManagerId): string {
  return id === 'apt' ? 'apt-get' : id;
}

/** Family implied by a package manager, for distros os-release does not identify. */
export function familyFromPackageManager(id: PackageManagerId | undefined): LinuxFamily {
  switch (id) {
    case 'apt': return 'debian';
    case 'dnf':
    case 'yum': return 'fedora';
    case 'pacman': return 'arch';
    case 'zypper': return 'suse';
    default: return 'unknown';
  }
}

// ─── Scripts ────────────────────────────────────────────────────────────────

/** POSIX-ish user names (useradd's default rule). Anything else is never embedded. */
const USERNAME_RE = /^[a-z_][a-z0-9_-]*[$]?$/i;

export function isValidUsername(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 32 && USERNAME_RE.test(name);
}

/** Package names per family and component. */
export function linuxPackages(family: LinuxFamily, component: LinuxComponent): string[] {
  const table: Record<Exclude<LinuxFamily, 'unknown'>, Record<LinuxComponent, string[]>> = {
    debian: { 'client-tools': ['postgresql-client'], server: ['postgresql', 'postgresql-contrib'] },
    fedora: { 'client-tools': ['postgresql'], server: ['postgresql-server', 'postgresql-contrib'] },
    // Arch ships client and server in one package; installing it does not init a cluster
    arch: { 'client-tools': ['postgresql'], server: ['postgresql'] },
    suse: { 'client-tools': ['postgresql'], server: ['postgresql-server', 'postgresql-contrib'] },
  };
  if (family === 'unknown') return [];
  return table[family][component];
}

function installLines(family: Exclude<LinuxFamily, 'unknown'>, packages: string[]): string[] {
  const list = packages.join(' ');
  switch (family) {
    case 'debian':
      return [
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get -o DPkg::Lock::Timeout=120 update -q || echo "apt-get update reported errors, trying the install anyway"',
        `apt-get -o DPkg::Lock::Timeout=120 install -y -q ${list}`,
      ];
    case 'fedora':
      return [
        'if command -v dnf >/dev/null 2>&1; then PM=dnf; else PM=yum; fi',
        `"$PM" install -y ${list}`,
      ];
    case 'arch':
      // A stale package database gives 404s: retry with a full sync (Arch does not
      // support partial upgrades, so -Sy alone is not an option)
      return [`pacman -S --noconfirm --needed ${list} || pacman -Syu --noconfirm --needed ${list}`];
    case 'suse':
      return [`zypper --non-interactive install ${list}`];
  }
}

function initLines(family: Exclude<LinuxFamily, 'unknown'>): string[] {
  switch (family) {
    case 'fedora':
      return [
        'if [ ! -s /var/lib/pgsql/data/PG_VERSION ]; then',
        '  postgresql-setup --initdb',
        'fi',
      ];
    case 'arch':
      return [
        'if [ ! -s /var/lib/postgres/data/PG_VERSION ]; then',
        '  install -d -o postgres -g postgres -m 700 /var/lib/postgres/data',
        '  su - postgres -c "initdb -D /var/lib/postgres/data --locale=C.UTF-8 --encoding=UTF8"',
        'fi',
      ];
    // Debian creates and starts a cluster on install; openSUSE's service inits on first start
    default:
      return [];
  }
}

/**
 * Builds the root script for a component. Throws on an unknown family or an invalid
 * user name: the user name is the only value embedded, and only once validated.
 */
export function buildLinuxScript(component: LinuxComponent, family: LinuxFamily, user: string): string {
  if (family === 'unknown') throw new Error('Unsupported Linux distribution');
  if (component === 'server' && !isValidUsername(user)) {
    throw new Error(`Invalid user name: ${JSON.stringify(user)}`);
  }
  const packages = linuxPackages(family, component);
  const lines: string[] = [
    '#!/bin/bash',
    `# bbdump setup: ${component} (${family})`,
    'set -euo pipefail',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'step() { echo "==> [$1%] $2"; }',
    '',
    `step 10 "Installing ${packages.join(', ')}"`,
    ...installLines(family, packages),
  ];

  if (component === 'client-tools') {
    lines.push('', 'step 100 "Client tools installed"');
    return lines.join('\n') + '\n';
  }

  lines.push(
    '',
    'step 50 "Initializing the database cluster"',
    ...initLines(family),
    '',
    'step 60 "Starting PostgreSQL and enabling it at boot"',
    'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then',
    '  systemctl enable --now postgresql',
    'else',
    '  service postgresql start',
    'fi',
    '',
    'step 75 "Waiting for PostgreSQL to accept connections"',
    'READY=0',
    'for _ in $(seq 1 30); do',
    '  if pg_isready -q >/dev/null 2>&1 || pg_isready -q -h localhost >/dev/null 2>&1; then READY=1; break; fi',
    '  sleep 1',
    'done',
    'if [ "$READY" != "1" ]; then',
    '  echo "PostgreSQL did not become ready within 30 seconds" >&2',
    '  exit 1',
    'fi',
  );

  if (user !== 'postgres') {
    lines.push(
      '',
      `step 90 "Creating a PostgreSQL superuser role for ${user}"`,
      `ROLE_EXISTS=$(su - postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='${user}'\\"" || true)`,
      'if [ "$ROLE_EXISTS" != "1" ]; then',
      `  su - postgres -c "createuser -s ${user}"`,
      'fi',
    );
  }

  lines.push('', 'step 100 "PostgreSQL server ready"');
  return lines.join('\n') + '\n';
}

/** The same script as one command to paste into a terminal. */
export function sudoCommand(script: string): string {
  return `sudo bash -c "$(cat <<'BBDUMP_SETUP'\n${script.replace(/\n$/, '')}\nBBDUMP_SETUP\n)"`;
}

/** Parses a "==> [NN%] message" progress line printed by the scripts. */
export function parseStepLine(line: string): { percent: number; message: string } | null {
  const match = line.match(/^==> \[(\d{1,3})%\] (.*)$/);
  return match ? { percent: Math.min(100, Number(match[1])), message: match[2] } : null;
}

export interface PkexecResult {
  code: number | null;
  output: string;
  /** The password dialog was dismissed or authentication failed */
  cancelled: boolean;
}

/**
 * Runs a script as root with ONE pkexec prompt. The script goes to a 0700 file in a
 * private temp directory, removed afterwards.
 */
export async function runScriptWithPkexec(
  script: string,
  pkexecPath: string,
  onLine: (line: string) => void,
): Promise<PkexecResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-setup-'));
  const file = path.join(dir, 'setup.sh');
  try {
    fs.writeFileSync(file, script, { mode: 0o700 });
    const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
    return await new Promise<PkexecResult>((resolve) => {
      let output = '';
      let started = false;
      const child = spawn(pkexecPath, [bash, file], { stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        for (const line of text.split(/\r?\n/)) {
          if (parseStepLine(line)) started = true;
          if (line.trim()) onLine(line);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (error) => resolve({ code: null, output: output + String(error), cancelled: false }));
      // pkexec: 126 = dialog dismissed / not authorized, 127 = authentication failed.
      // The script itself can also exit 127 (command not found): only count it as a
      // cancellation when the script never printed its first step.
      child.on('close', (code) => resolve({ code, output, cancelled: !started && (code === 126 || code === 127) }));
    });
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: it lives in the user's temp directory
    }
  }
}

/**
 * Describes this machine for the onboarding: OS, package manager, PostgreSQL client
 * tools, local server, Docker. Every probe has a timeout and never throws: a failure
 * just reads as "not installed".
 *
 * Modules that pull in Electron (logger, tool detector, postgresManager) are imported
 * lazily inside detectEnvironment(), so the pure helpers here load in plain node.
 */
import * as fs from 'fs';
import * as os from 'os';
import type { LinuxFamily, PackageManagerId, SetupEnvironment, SetupOs, SetupTool } from '../../types/setup';
import {
  familyFromPackageManager, packageManagerBinary, packageManagersFor, parseDistro, readOsRelease,
  type LinuxDistro,
} from './linux';
import { WINDOWS_SUPPORTED, wingetCandidates } from './windows';
import { defaultWhich, firstExisting, isPortOpen, parseVersion, run, withTimeout, type WhichFn } from './probe';

export interface DetectOptions {
  /** Defaults to process.platform */
  platform?: NodeJS.Platform;
  /** Defaults to os.arch() */
  arch?: string;
  /** os-release content (Linux); defaults to /etc/os-release */
  osReleaseText?: string;
  which?: WhichFn;
  /** Local server port, 5432 by default */
  port?: number;
}

const NOT_INSTALLED: SetupTool = { installed: false };

export function toSetupOs(platform: NodeJS.Platform): SetupOs {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

export function toSetupArch(arch: string): SetupEnvironment['arch'] {
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64';
  if (arch === 'x64' || arch === 'x86_64' || arch === 'amd64') return 'x64';
  return 'ia32';
}

/** Finds the package manager bbdump would use, with its absolute path. */
export async function detectPackageManager(
  setupOs: SetupOs,
  family: LinuxFamily,
  which: WhichFn = defaultWhich,
): Promise<SetupEnvironment['packageManager']> {
  if (setupOs === 'macos') {
    const brew = (await which('brew')) || firstExisting(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
    return brew ? { id: 'brew', path: brew } : null;
  }
  if (setupOs === 'windows') {
    const winget = (await which('winget')) || firstExisting(wingetCandidates());
    return winget ? { id: 'winget', path: winget } : null;
  }
  for (const id of packageManagersFor(family)) {
    const found = await which(packageManagerBinary(id));
    if (found) return { id, path: found };
  }
  return null;
}

/** Family whose scripts apply: os-release first, else the package manager found. */
export function installFamily(env: Pick<SetupEnvironment, 'distro' | 'packageManager'>): LinuxFamily {
  const family = env.distro?.family || 'unknown';
  if (family !== 'unknown') return family;
  return familyFromPackageManager(env.packageManager?.id as PackageManagerId | undefined);
}

/**
 * macOS: Homebrew present. Linux: pkexec (graphical sudo) plus a package manager of a
 * known family. Windows: not yet.
 */
export function computeCanAutoInstall(
  setupOs: SetupOs,
  packageManager: SetupEnvironment['packageManager'],
  family: LinuxFamily,
  hasPkexec: boolean,
): boolean {
  if (setupOs === 'macos') return packageManager?.id === 'brew';
  if (setupOs === 'linux') return hasPkexec && !!packageManager && family !== 'unknown';
  return false;
}

async function macosLabel(): Promise<string> {
  const result = await run('/usr/bin/sw_vers', ['-productVersion'], 3000);
  const version = result.stdout.trim();
  return version ? `macOS ${version}` : 'macOS';
}

async function toolVersion(file: string, args: string[] = ['--version']): Promise<string | undefined> {
  const result = await run(file, args, 5000);
  return parseVersion(result.stdout || result.stderr);
}

/** Parses `brew services list`: the running postgresql formula first, else any. */
export function parseBrewServices(output: string): string | undefined {
  const rows = output.split('\n').map((line) => line.trim().split(/\s+/)).filter((cols) => /^postgresql(@\d+)?$/.test(cols[0] || ''));
  const started = rows.find((cols) => cols[1] === 'started');
  return (started || rows[0])?.[0];
}

/** Parses `systemctl list-unit-files`: "postgresql" when present, else the first unit. */
export function parseSystemdUnits(output: string): string | undefined {
  const names = output.split('\n')
    .map((line) => line.trim().split(/\s+/)[0] || '')
    .filter((name) => /^postgresql[\w@.-]*\.service$/.test(name))
    .map((name) => name.replace(/\.service$/, ''));
  if (names.includes('postgresql')) return 'postgresql';
  return names.find((name) => !name.endsWith('@')) || names[0];
}

async function detectServiceName(setupOs: SetupOs, brewPath: string | undefined, which: WhichFn): Promise<string | undefined> {
  if (setupOs === 'macos' && brewPath) {
    const result = await run(brewPath, ['services', 'list'], 8000, { ...process.env, HOMEBREW_NO_ENV_HINTS: '1' });
    return parseBrewServices(result.stdout) || undefined;
  }
  if (setupOs === 'linux') {
    const systemctl = await which('systemctl');
    if (!systemctl) return undefined;
    const result = await run(systemctl, ['list-unit-files', '--type=service', '--no-legend', '--no-pager', 'postgresql*'], 3000);
    return parseSystemdUnits(result.stdout);
  }
  return undefined;
}

async function detectDocker(setupOs: SetupOs, which: WhichFn): Promise<SetupEnvironment['docker']> {
  const candidates = setupOs === 'macos'
    ? ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker']
    : ['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker'];
  const docker = (await which('docker')) || firstExisting(candidates);
  // Presence only: no Docker mode is offered yet (docs/ROADMAP.md), and `docker info`
  // could add up to 3s to the machine check. `running` is left false until it is needed.
  return { installed: !!docker, running: false };
}

function linuxSocketExists(port: number): boolean {
  return ['/var/run/postgresql', '/run/postgresql', '/tmp']
    .some((dir) => fs.existsSync(`${dir}/.s.PGSQL.${port}`));
}

function toSetupTool(result: { installed: boolean; path?: string; version?: string } | undefined): SetupTool {
  if (!result?.installed) return { installed: false };
  return { installed: true, path: result.path, version: result.version };
}

export async function detectEnvironment(options: DetectOptions = {}): Promise<SetupEnvironment> {
  const platform = options.platform || process.platform;
  const setupOs = toSetupOs(platform);
  const arch = toSetupArch(options.arch || os.arch());
  const which = options.which || defaultWhich;
  const port = options.port || 5432;

  // ── OS and packaging ──
  let distro: LinuxDistro | undefined;
  let osLabel: string;
  if (setupOs === 'linux') {
    distro = parseDistro(options.osReleaseText ?? readOsRelease());
    osLabel = distro.name;
  } else if (setupOs === 'macos') {
    osLabel = await withTimeout(macosLabel(), 3500, 'macOS');
  } else {
    osLabel = `Windows ${os.release()}`;
  }

  const packageManager = await withTimeout(detectPackageManager(setupOs, distro?.family || 'unknown', which), 3000, null);
  const hasPkexec = setupOs === 'linux' ? !!(await withTimeout(which('pkexec'), 2000, null)) : false;
  const family = installFamily({ distro, packageManager });
  const canAutoInstall = computeCanAutoInstall(setupOs, packageManager, family, hasPkexec);

  let homebrew: SetupTool | undefined;
  if (setupOs === 'macos') {
    homebrew = packageManager?.path
      ? { installed: true, path: packageManager.path, version: await withTimeout(toolVersion(packageManager.path), 6000, undefined) }
      : { installed: false };
  }

  // ── Client tools and server binaries (reuses the app's tool detector) ──
  const toolTimeout = 8000;
  const [clientTools, postgresBinary] = await withTimeout((async () => {
    const { detectTool } = await import('../tools/toolDetector');
    const { getToolPaths } = await import('../os/osPaths');
    const paths = getToolPaths(setupOs, arch);
    const [pgDump, psql, pgRestore, postgres] = await Promise.all([
      detectTool('pg_dump', paths.pgDump),
      detectTool('psql', paths.psql),
      detectTool('pg_restore', paths.pgRestore),
      detectTool('postgres', paths.postgres),
    ]);
    return [{ pgDump: toSetupTool(pgDump), psql: toSetupTool(psql), pgRestore: toSetupTool(pgRestore) }, toSetupTool(postgres)] as const;
  })(), toolTimeout, [{ pgDump: NOT_INSTALLED, psql: NOT_INSTALLED, pgRestore: NOT_INSTALLED }, NOT_INSTALLED] as const);

  // ── Local server ──
  const [installedInfo, portOpen, docker] = await Promise.all([
    withTimeout((async () => {
      const { checkPostgresInstalled } = await import('../postgresManager');
      return checkPostgresInstalled();
    })(), 10000, { installed: false, hasServer: false } as { installed: boolean; hasServer?: boolean }),
    isPortOpen(port, 'localhost', 1500),
    withTimeout(detectDocker(setupOs, which), 4000, { installed: false, running: false }),
  ]);
  const running = portOpen || (setupOs === 'linux' && linuxSocketExists(port));

  const localRole = running
    ? await withTimeout((async () => {
      const { findLocalRole } = await import('../localPgUser');
      return findLocalRole(port);
    })(), 8000, null)
    : null;

  const serverInstalled = !!installedInfo.hasServer || postgresBinary.installed;
  const serviceName = serverInstalled || running
    ? await withTimeout(detectServiceName(setupOs, homebrew?.path, which), 9000, undefined)
    : undefined;

  const clientReady = clientTools.pgDump.installed && clientTools.psql.installed && clientTools.pgRestore.installed;

  return {
    os: setupOs,
    arch,
    osLabel,
    supported: setupOs === 'windows' ? WINDOWS_SUPPORTED : true,
    ...(distro ? { distro: { id: distro.id, name: distro.name, family: distro.family, version: distro.version } } : {}),
    packageManager,
    canAutoInstall,
    ...(homebrew ? { homebrew } : {}),
    clientTools: { ...clientTools, ready: clientReady },
    server: {
      installed: serverInstalled,
      running,
      version: localRole?.serverVersion || postgresBinary.version,
      port,
      canConnect: !!localRole,
      role: localRole?.role,
      serviceName,
    },
    docker,
  };
}

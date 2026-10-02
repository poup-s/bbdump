/**
 * Contract between the main-process platform layer (src/main/platform) and the
 * renderer onboarding / settings. Types only: imported by both sides.
 */

/**
 * How bbdump is used on this machine.
 * - local:  a PostgreSQL server on this computer (plus any remote databases)
 * - remote: remote databases only: client tools, no local server features
 * - docker: PostgreSQL in Docker containers (planned, not selectable yet)
 */
export type UsageMode = 'local' | 'remote' | 'docker';

export type SetupOs = 'macos' | 'linux' | 'windows';

/** Linux distributions grouped by packaging (package names and service setup differ). */
export type LinuxFamily = 'debian' | 'fedora' | 'arch' | 'suse' | 'unknown';

export type PackageManagerId = 'brew' | 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'winget';

export interface SetupTool {
  installed: boolean;
  path?: string;
  /** e.g. "17.10" */
  version?: string;
}

export interface SetupEnvironment {
  os: SetupOs;
  arch: 'arm64' | 'x64' | 'ia32';
  /** e.g. "macOS 15.4", "Ubuntu 24.04 LTS" */
  osLabel: string;
  /** false on platforms bbdump cannot set up yet (Windows for now) */
  supported: boolean;
  distro?: { id: string; name: string; family: LinuxFamily; version?: string };
  packageManager: { id: PackageManagerId; path?: string } | null;
  /**
   * Whether bbdump can install things itself: Homebrew present (macOS), or pkexec
   * plus a known package manager (Linux, one graphical password prompt).
   */
  canAutoInstall: boolean;
  /** Homebrew itself (macOS only) */
  homebrew?: SetupTool;
  clientTools: {
    pgDump: SetupTool;
    psql: SetupTool;
    pgRestore: SetupTool;
    /** true when all three are installed */
    ready: boolean;
  };
  server: {
    installed: boolean;
    running: boolean;
    version?: string;
    port: number;
    /** The current OS user can connect (a role exists for it, or "postgres" works) */
    canConnect: boolean;
    /** Role bbdump will use for local databases */
    role?: string;
    /** e.g. "postgresql@17" (brew) or "postgresql" (systemd) */
    serviceName?: string;
  };
  /** Planned Docker mode: detected only, not used yet */
  docker: { installed: boolean; running: boolean };
}

/** What can be installed / fixed from the onboarding. */
export type SetupComponent =
  | 'homebrew'        // macOS: Homebrew itself
  | 'client-tools'    // pg_dump, psql, pg_restore only
  | 'server';         // PostgreSQL server: install, init, start at boot, role for the OS user

export interface SetupInstallPlan {
  component: SetupComponent;
  /** Can bbdump run it itself on this machine */
  automatic: boolean;
  /** Exact command(s) to run in a terminal, for copy / manual install */
  command: string;
}

export interface SetupInstallResult {
  success: boolean;
  error?: string;
  /** Present when automatic install is impossible or failed: what to run by hand */
  manualCommand?: string;
  /** Fresh environment after the attempt */
  environment?: SetupEnvironment;
}

/** Named install stages, translated by the renderer (the message stays the raw detail). */
export type SetupStage =
  | 'password' | 'packages' | 'initdb' | 'service' | 'waitReady' | 'role'
  | 'terminal' | 'checking' | 'done';

/** Progress events sent on the 'setup-progress' channel during an install. */
export interface SetupProgress {
  component: SetupComponent;
  /** 0-100, or -1 when indeterminate */
  percent: number;
  /** Raw detail in English (script step, package manager output) */
  message: string;
  /** Current stage, when known: shown translated above the raw detail */
  stage?: SetupStage;
}

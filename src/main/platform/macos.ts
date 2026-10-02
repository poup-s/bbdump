/**
 * macOS adapter: everything goes through Homebrew, called by its absolute path (a GUI
 * app does not get Homebrew in its PATH). Homebrew runs as the user, no password.
 */
import { spawn } from 'child_process';
import * as path from 'path';

/** PostgreSQL major version installed as a server. */
export const MACOS_SERVER_FORMULA = 'postgresql@17';

export const HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Default brew location for the architecture (used in copyable commands). */
export function defaultBrewPath(arch: string): string {
  return arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew';
}

/**
 * Commands per component. libpq is keg-only (not linked into bin/): detection looks in
 * <prefix>/opt/libpq/bin. Homebrew's postgresql@17 creates a superuser role named after
 * the OS user, so there is no role step.
 */
export function macosSteps(component: 'client-tools' | 'server', brew: string): string[][] {
  if (component === 'client-tools') return [[brew, 'install', 'libpq']];
  return [
    [brew, 'install', MACOS_SERVER_FORMULA],
    [brew, 'services', 'start', MACOS_SERVER_FORMULA],
  ];
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function macosCommand(component: 'homebrew' | 'client-tools' | 'server', brew: string): string {
  if (component === 'homebrew') return HOMEBREW_INSTALL_COMMAND;
  return macosSteps(component, brew).map((step) => step.map(shellQuote).join(' ')).join(' && ');
}

export interface BrewRunResult {
  code: number | null;
  output: string;
}

/** Runs one brew command, streaming each output line. */
export function runBrew(argv: string[], onLine: (line: string) => void): Promise<BrewRunResult> {
  const [brew, ...args] = argv;
  const brewBin = path.dirname(brew);
  const env = {
    ...process.env,
    PATH: `${brewBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    HOMEBREW_NO_ENV_HINTS: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    NONINTERACTIVE: '1',
  };
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(brew, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => resolve({ code: null, output: output + String(error) }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

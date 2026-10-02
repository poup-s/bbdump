/**
 * Small, Electron-free helpers for the platform probes: every call has a timeout and
 * never throws, so a missing or hanging tool just reads as "not installed".
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/** Looks an executable up by name; returns its absolute path or null. */
export type WhichFn = (name: string) => Promise<string | null>;

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Directories searched in addition to PATH: a GUI app launched from Finder or a
 * desktop menu gets a minimal PATH that misses Homebrew and the sbin directories. */
const EXTRA_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
];

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default which(): PATH plus the usual system and Homebrew directories. No shell. */
export const defaultWhich: WhichFn = async (name) => {
  if (path.isAbsolute(name)) return isExecutable(name) ? name : null;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...EXTRA_DIRS].filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of [...new Set(dirs)]) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
};

/** Returns the first existing executable among absolute candidate paths. */
export function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return null;
}

/** Runs a program without a shell. Resolves (never rejects) within `timeoutMs`. */
export function run(file: string, args: string[], timeoutMs = 5000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, env: env || process.env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        // Non-zero exit: error.code is the exit code; spawn failure: a string like ENOENT
        const rawCode: unknown = error ? (error as { code?: unknown }).code : 0;
        const code = typeof rawCode === 'number' ? rawCode : null;
        resolve({ ok: !error, code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error) });
    }
  });
}

/** Resolves to `fallback` if `promise` rejects or takes longer than `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** True when something accepts TCP connections on host:port. */
export function isPortOpen(port: number, host = 'localhost', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Extracts "17.10" from "pg_dump (PostgreSQL) 17.10 (Homebrew)". */
export function parseVersion(output: string): string | undefined {
  // Anchored first: wrapper noise (openSUSE pg_alts errors with line numbers) must not win
  const anchored = output.match(/\(PostgreSQL\)\s+(\d+(?:\.\d+){0,2})/);
  if (anchored) return anchored[1];
  const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : undefined;
}

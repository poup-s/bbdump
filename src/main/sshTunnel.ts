/**
 * SSH tunnels to databases on a server (a VPS whose PostgreSQL is not exposed):
 * `ssh -N -L 127.0.0.1:<port>:<db host>:<db port> <alias>`, opened when a database
 * needs it, shared by everything that uses it, closed after a while without use.
 *
 * - Scoped uses (a backup, a restore) count as users: the tunnel stays up meanwhile.
 * - Long-lived uses (a project proxy, the MCP server) hold it by name.
 * - A tunnel that drops is reopened on the same local port when something holds it, so
 *   pools and proxies keep working with the address they already have.
 */
import { spawn, execFile, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { logger } from './logger';
import { pathManager } from './paths';
import type { DatabaseConfig, SshSettings } from '../types/config';
import {
  SshErrorCode, SshRunOptions, SshTarget, baseSshOptions, classifySshError, isSafePort, isSafeSshValue, normalizeSshPorts,
  ENV_SEARCH_SCRIPT, EnvFileMatch, parseEnvLine, parseEnvSearch, parseSshConfigHosts, parseSshConfigIncludes, parseSshG, readEnvCommand, tunnelArgs,
} from './sshConfig';

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const OPEN_TIMEOUT_MS = 20000;

export class SshError extends Error {
  constructor(message: string, readonly code: SshErrorCode, readonly stderr = '') {
    super(message);
  }
}

const binary = (name: string) => (process.platform !== 'win32' && fs.existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : name);

/** The dev app can use another ssh config (tests against a container) */
function runOptions(extra: SshRunOptions = {}): SshRunOptions {
  const configFile = !app.isPackaged && process.env.BBDUMP_SSH_CONFIG ? process.env.BBDUMP_SSH_CONFIG : undefined;
  return { configFile, ...extra };
}

export function validateSsh(ssh: SshSettings | undefined): asserts ssh is SshSettings {
  if (!ssh) throw new SshError('No SSH settings', 'other');
  Object.assign(ssh, normalizeSshPorts(ssh));
  if (!isSafeSshValue(ssh.host)) throw new SshError('Invalid SSH host', 'other');
  if (ssh.user !== undefined && !isSafeSshValue(ssh.user)) throw new SshError('Invalid SSH user', 'other');
  if (ssh.port !== undefined && !isSafePort(ssh.port)) throw new SshError('Invalid SSH port', 'other');
  if (!isSafeSshValue(ssh.remoteHost)) throw new SshError('Invalid database host on the server', 'other');
  if (!isSafePort(ssh.remotePort)) throw new SshError('Invalid database port on the server', 'other');
}

const targetOf = (ssh: SshSettings): SshTarget => ({ host: ssh.host, user: ssh.user, port: ssh.port });

// --- One-off ssh commands --------------------------------------------------------------

interface RunResult { code: number; stdout: string; stderr: string }

function run(command: string, args: string[], input?: string, timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const exit = error ? (error as { code?: unknown }).code : 0;
      const code = typeof exit === 'number' ? exit : error ? 255 : 0;
      const killed = !!error && (error as { killed?: boolean }).killed;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (killed ? 'Connection timed out' : error ? error.message : '') });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Runs a command on the server; throws an SshError when ssh itself fails */
export async function runOnServer(ssh: SshSettings, command: string, extra: SshRunOptions = {}): Promise<RunResult> {
  validateSsh(ssh);
  const result = await run(binary('ssh'), [...baseSshOptions(targetOf(ssh), runOptions(extra)), '--', ssh.host, command]);
  // 255 is ssh's own failure; other codes come from the remote command
  if (result.code === 255) throw new SshError(result.stderr.trim() || 'ssh failed', classifySshError(result.stderr), result.stderr);
  return result;
}

/** What the alias resolves to (`ssh -G`): the real host name, port and user */
export async function resolveTarget(ssh: SshSettings): Promise<{ hostname: string; port: number; user?: string }> {
  validateSsh(ssh);
  const opts = runOptions();
  const result = await run(binary('ssh'), [
    ...(opts.configFile ? ['-F', opts.configFile] : []),
    '-G', ...(ssh.port ? ['-p', String(ssh.port)] : []), ...(ssh.user ? ['-l', ssh.user] : []), '--', ssh.host,
  ], undefined, 5000);
  const parsed = parseSshG(result.stdout);
  return { hostname: parsed.hostname || ssh.host, port: parsed.port || ssh.port || 22, user: parsed.user };
}

/** The host aliases of ~/.ssh/config (and the files it includes) */
export function listSshHosts(): string[] {
  const configFile = runOptions().configFile ?? path.join(os.homedir(), '.ssh', 'config');
  const seen = new Set<string>();
  const hosts: string[] = [];
  const readFile = (file: string, depth: number) => {
    if (depth > 4 || seen.has(file)) return;
    seen.add(file);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const host of parseSshConfigHosts(text)) if (!hosts.includes(host)) hosts.push(host);
    for (const include of parseSshConfigIncludes(text)) {
      const expanded = include.replace(/^~(?=\/)/, os.homedir());
      const full = path.isAbsolute(expanded) ? expanded : path.join(os.homedir(), '.ssh', expanded);
      if (full.endsWith('/*')) {
        const dir = full.slice(0, -2);
        try { for (const name of fs.readdirSync(dir).sort()) readFile(path.join(dir, name), depth + 1); } catch { /* missing */ }
      } else {
        readFile(full, depth + 1);
      }
    }
  };
  readFile(configFile, 0);
  return hosts;
}

/** Reads `name` from an env file on the server; null when the file has no such line */
export async function readRemoteEnv(ssh: SshSettings, file: string, name: string): Promise<string | null> {
  const result = await runOnServer(ssh, readEnvCommand(file, name));
  // grep: 0 found, 1 not found, 2 cannot read the file
  if (result.code >= 2) throw new SshError(result.stderr.trim() || `Cannot read ${file}`, 'other', result.stderr);
  const line = result.stdout.split('\n')[0] ?? '';
  return parseEnvLine(line, name);
}

/**
 * The env files on the server that hold a PostgreSQL URL (home, /srv, /var/www, /opt, /home),
 * with the names of those variables only. The script goes on stdin to `sh -s`, so the
 * user's login shell (fish, zsh…) does not matter.
 */
export async function findRemoteEnvFiles(ssh: SshSettings): Promise<EnvFileMatch[]> {
  validateSsh(ssh);
  const result = await run(binary('ssh'), [...baseSshOptions(targetOf(ssh), runOptions()), '--', ssh.host, 'sh -s'], ENV_SEARCH_SCRIPT, 30000);
  if (result.code === 255) throw new SshError(result.stderr.trim() || 'ssh failed', classifySshError(result.stderr), result.stderr);
  return parseEnvSearch(result.stdout);
}

/** The server's key fingerprints, to show before trusting it the first time */
export async function hostFingerprints(ssh: SshSettings): Promise<string[]> {
  const { hostname, port } = await resolveTarget(ssh);
  if (!isSafeSshValue(hostname)) return [];
  const scan = await run(binary('ssh-keyscan'), ['-T', '5', '-p', String(port), hostname], undefined, 10000);
  if (!scan.stdout.trim()) return [];
  const keygen = await run(binary('ssh-keygen'), ['-l', '-f', '-'], scan.stdout, 5000);
  // "256 SHA256:abc… host (ED25519)" → "ED25519 SHA256:abc…"
  return keygen.stdout.split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const type = /\((\w+)\)\s*$/.exec(line)?.[1] ?? '';
    return `${type} ${parts[1] ?? ''}`.trim();
  });
}

/** Adds the server's key to known_hosts (after the user saw its fingerprint) */
export async function trustHost(ssh: SshSettings): Promise<void> {
  await runOnServer(ssh, 'true', { acceptNewHostKey: true });
}

// --- Tunnels ---------------------------------------------------------------------------

interface Tunnel {
  ssh: SshSettings;
  port: number;
  child: ChildProcess | null;
  ready: Promise<void> | null;
  users: number;
  holders: Set<string>;
  lastUsed: number;
}

const tunnels = new Map<string, Tunnel>();

// --- Tunnels left by a session that ended without closing them (crash, kill) --------
// Their pids are noted in <userData>/ssh-tunnels.json; at startup the ones still running
// with bbdump's tunnel command line are stopped (a reused pid is never touched).

const pidFile = () => path.join(pathManager.appDataPath, 'ssh-tunnels.json');
const readPids = (): number[] => {
  try {
    const pids = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
    return Array.isArray(pids) ? pids.filter((p): p is number => Number.isInteger(p) && p > 1) : [];
  } catch {
    return [];
  }
};
const writePids = (pids: number[]) => {
  try {
    if (pids.length) fs.writeFileSync(pidFile(), JSON.stringify(pids));
    else fs.rmSync(pidFile(), { force: true });
  } catch { /* best effort */ }
};
const notePid = (pid: number | undefined, add: boolean) => {
  if (!pid) return;
  const pids = readPids().filter(p => p !== pid);
  writePids(add ? [...pids, pid] : pids);
};

/** Stops the tunnels a previous session left running */
export async function cleanUpOrphanTunnels(): Promise<void> {
  const pids = readPids();
  if (!pids.length || process.platform === 'win32') {
    writePids([]);
    return;
  }
  for (const pid of pids) {
    const ps = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], undefined, 3000);
    const command = ps.stdout.trim();
    if (command.includes('ssh') && command.includes('ExitOnForwardFailure=yes') && command.includes('-L 127.0.0.1:')) {
      try {
        process.kill(pid);
        logger.info(`Stopped an SSH tunnel left by a previous session (pid ${pid})`);
      } catch { /* already gone */ }
    }
  }
  writePids([]);
}
const keyOf = (ssh: SshSettings) => [ssh.host, ssh.user ?? '', ssh.port ?? '', ssh.remoteHost, ssh.remotePort].join('|');

/** A free local port: the previous one when possible, so addresses already handed out stay valid */
function freePort(prefer?: number): Promise<number> {
  const tryListen = (port: number) => new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const chosen = typeof address === 'object' && address ? address.port : port;
      server.close(() => resolve(chosen));
    });
  });
  return (prefer ? tryListen(prefer) : Promise.reject(new Error('no preference'))).catch(() => tryListen(0));
}

function waitUntilListening(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const onExit = () => finish(new SshError(stderr().trim() || 'ssh exited', classifySshError(stderr()), stderr()));
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    child.once('exit', onExit);
    const probe = () => {
      if (done) return;
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); finish(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > OPEN_TIMEOUT_MS) finish(new SshError('The SSH tunnel did not open in time', 'timeout', stderr()));
        else setTimeout(probe, 150);
      });
    };
    probe();
  });
}

async function open(tunnel: Tunnel): Promise<void> {
  tunnel.port = await freePort(tunnel.port || undefined);
  const args = tunnelArgs(targetOf(tunnel.ssh), tunnel.port, tunnel.ssh.remoteHost, tunnel.ssh.remotePort, runOptions());
  const child = spawn(binary('ssh'), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  tunnel.child = child;
  notePid(child.pid, true);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.on('error', (error) => { stderr += String(error); });
  child.on('exit', (code) => {
    notePid(child.pid, false);
    if (tunnel.child !== child) return;
    tunnel.child = null;
    tunnel.ready = null;
    logger.info(`SSH tunnel to ${tunnel.ssh.host} closed (code ${code})`);
    // Something still relies on it (a proxy, the MCP server): reopen on the same port
    if (tunnel.holders.size) {
      setTimeout(() => { if (!tunnel.child && tunnel.holders.size) ensureOpen(tunnel).catch(() => { /* logged */ }); }, 2000);
    }
  });
  await waitUntilListening(tunnel.port, child, () => stderr);
  logger.info(`SSH tunnel to ${tunnel.ssh.host} open: 127.0.0.1:${tunnel.port} → ${tunnel.ssh.remoteHost}:${tunnel.ssh.remotePort}`);
}

function ensureOpen(tunnel: Tunnel): Promise<void> {
  if (tunnel.child && tunnel.ready) return tunnel.ready;
  tunnel.ready = open(tunnel).catch((error) => {
    tunnel.child?.kill();
    tunnel.child = null;
    tunnel.ready = null;
    logger.warn(`SSH tunnel to ${tunnel.ssh.host} failed: ${error instanceof Error ? error.message : error}`);
    throw error;
  });
  return tunnel.ready;
}

function tunnelFor(ssh: SshSettings): Tunnel {
  validateSsh(ssh);
  const key = keyOf(ssh);
  let tunnel = tunnels.get(key);
  if (!tunnel) {
    tunnel = { ssh: { ...ssh }, port: 0, child: null, ready: null, users: 0, holders: new Set(), lastUsed: Date.now() };
    tunnels.set(key, tunnel);
  }
  return tunnel;
}

/** Opens (or reuses) the tunnel; returns where to connect */
export async function ensureTunnel(ssh: SshSettings): Promise<{ host: string; port: number }> {
  const tunnel = tunnelFor(ssh);
  tunnel.lastUsed = Date.now();
  await ensureOpen(tunnel);
  return { host: '127.0.0.1', port: tunnel.port };
}

/** verify-full checks the server name, which is 127.0.0.1 through the tunnel: the chain is still checked */
const sslThroughTunnel = (mode: DatabaseConfig['sslMode']) => (mode === 'verify-full' ? 'verify-ca' : mode);

type Reachable = Pick<DatabaseConfig, 'host' | 'port' | 'ssh' | 'connectionString' | 'sslMode' | 'viaTunnel'>;

/** The database as reached through its tunnel (unchanged without SSH) */
export async function tunnelled<T extends Reachable>(db: T): Promise<T> {
  if (!db.ssh) return db;
  const endpoint = await ensureTunnel(db.ssh);
  return { ...db, host: endpoint.host, port: endpoint.port, connectionString: undefined, sslMode: sslThroughTunnel(db.sslMode), viaTunnel: true };
}

/** Runs `fn` with the database reached through its tunnel, kept open meanwhile */
export async function withTunnel<T extends Reachable, R>(db: T, fn: (db: T) => Promise<R>): Promise<R> {
  if (!db.ssh) return fn(db);
  const tunnel = tunnelFor(db.ssh);
  tunnel.users++;
  try {
    return await fn(await tunnelled(db));
  } finally {
    tunnel.users--;
    tunnel.lastUsed = Date.now();
  }
}

/** Keeps the tunnel open for a long-lived user (a project proxy, the MCP server) */
export async function holdTunnel(ssh: SshSettings, holder: string): Promise<{ host: string; port: number }> {
  tunnelFor(ssh).holders.add(holder);
  return ensureTunnel(ssh);
}

export function releaseHolder(holder: string): void {
  for (const tunnel of tunnels.values()) {
    if (tunnel.holders.delete(holder)) tunnel.lastUsed = Date.now();
  }
}

export function closeAllTunnels(): void {
  for (const tunnel of tunnels.values()) {
    tunnel.holders.clear();
    const child = tunnel.child;
    tunnel.child = null;
    tunnel.ready = null;
    child?.kill();
  }
  tunnels.clear();
}

// Unused tunnels close after a while
setInterval(() => {
  const now = Date.now();
  for (const tunnel of tunnels.values()) {
    if (!tunnel.child || tunnel.users > 0 || tunnel.holders.size > 0) continue;
    if (now - tunnel.lastUsed < IDLE_CLOSE_MS) continue;
    const child = tunnel.child;
    tunnel.child = null;
    tunnel.ready = null;
    child.kill();
    logger.info(`SSH tunnel to ${tunnel.ssh.host} closed after ${IDLE_CLOSE_MS / 60000} min unused`);
  }
}, 60 * 1000).unref();

/**
 * The pure parts of "database via SSH": what is a safe host, the aliases of
 * ~/.ssh/config, the ssh command line, what an ssh error means, and reading a variable
 * from a server's .env. The process side (spawning ssh, the tunnels) is sshTunnel.ts.
 *
 * bbdump runs the user's own `ssh`, so their ~/.ssh/config, keys, agent (1Password,
 * Keychain), known_hosts and ProxyJump all apply without being configured again.
 */

export interface SshTarget {
  /** Alias from ~/.ssh/config, or a host name / address */
  host: string;
  /** Only when not set by the alias */
  user?: string;
  port?: number;
}

/**
 * Host, alias, user or remote host given to ssh. Never starting with "-" (it would be
 * read as an option: `-oProxyCommand=…` runs a command), no spaces or shell characters.
 */
export function isSafeSshValue(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.@%:[\]-]{1,253}$/.test(value) && !value.startsWith('-');
}

export const isSafePort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;

/**
 * Ports as the form sends them (an emptied number field is ""): no valid SSH port means the
 * one of ~/.ssh/config (or 22), no valid database port means PostgreSQL's default.
 */
export function normalizeSshPorts<T extends { port?: unknown; remotePort?: unknown }>(ssh: T): Omit<T, 'port' | 'remotePort'> & { port?: number; remotePort: number } {
  const toPort = (value: unknown) => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return isSafePort(n) ? n : undefined;
  };
  return { ...ssh, port: toPort(ssh.port), remotePort: toPort(ssh.remotePort) ?? 5432 };
}

/** Host aliases a user can pick: the `Host` names without wildcards or negations */
export function parseSshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*host\s+(.+)$/i.exec(raw);
    if (!match) continue;
    for (const name of match[1].trim().split(/\s+/)) {
      if (!name || /[*?!]/.test(name) || hosts.includes(name)) continue;
      hosts.push(name);
    }
  }
  return hosts;
}

/** `Include` paths of an ssh config (relative ones are under ~/.ssh) */
export function parseSshConfigIncludes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*include\s+(.+)$/i.exec(raw);
    if (match) out.push(...match[1].trim().split(/\s+/));
  }
  return out;
}

/** What `ssh -G <alias>` resolved: the real host name, port and user */
export function parseSshG(text: string): { hostname?: string; port?: number; user?: string } {
  const out: { hostname?: string; port?: number; user?: string } = {};
  for (const line of text.split(/\r?\n/)) {
    const [key, ...rest] = line.trim().split(/\s+/);
    const value = rest.join(' ');
    if (key === 'hostname') out.hostname = value;
    else if (key === 'port' && /^\d+$/.test(value)) out.port = Number(value);
    else if (key === 'user') out.user = value;
  }
  return out;
}

export interface SshRunOptions {
  /** Another ssh config than ~/.ssh/config (tests, dev) */
  configFile?: string;
  /** Trust the server's key the first time (after the user saw its fingerprint) */
  acceptNewHostKey?: boolean;
}

/** Options common to every ssh run: never wait for a prompt, fail fast */
export function baseSshOptions(target: SshTarget, opts: SshRunOptions = {}): string[] {
  return [
    ...(opts.configFile ? ['-F', opts.configFile] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', `StrictHostKeyChecking=${opts.acceptNewHostKey ? 'accept-new' : 'yes'}`,
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.user ? ['-l', target.user] : []),
  ];
}

/** `ssh -N -L 127.0.0.1:<local>:<remote host>:<remote port> <host>`: the tunnel, nothing else */
export function tunnelArgs(target: SshTarget, localPort: number, remoteHost: string, remotePort: number, opts: SshRunOptions = {}): string[] {
  return [
    '-N', '-T',
    ...baseSshOptions(target, opts),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
    '--', target.host,
  ];
}

export type SshErrorCode = 'auth' | 'unknown-host' | 'host-changed' | 'dns' | 'unreachable' | 'timeout' | 'port-in-use' | 'other';

/** What went wrong, from ssh's stderr */
export function classifySshError(stderr: string): SshErrorCode {
  const s = stderr.toLowerCase();
  if (s.includes('remote host identification has changed') || (s.includes('host key for') && s.includes('has changed'))) return 'host-changed';
  if (s.includes('host key verification failed') || (s.includes('host key is known'))) return 'unknown-host';
  if (s.includes('permission denied') || s.includes('too many authentication failures')) return 'auth';
  if (s.includes('could not resolve hostname') || s.includes('name or service not known') || s.includes('nodename nor servname')) return 'dns';
  if (s.includes('timed out')) return 'timeout';
  if (s.includes('address already in use') || s.includes('cannot listen to port')) return 'port-in-use';
  if (s.includes('connection refused') || s.includes('no route to host') || s.includes('network is unreachable')) return 'unreachable';
  return 'other';
}

/** Single-quoted for the remote POSIX shell: 'it'\''s' */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const isSafeEnvVar = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);

/**
 * Remote command printing the line that defines `name` in `file` (with or without
 * `export`). The path is quoted, the name validated: nothing else reaches the shell.
 */
export function readEnvCommand(file: string, name: string): string {
  if (!isSafeEnvVar(name)) throw new Error('Invalid variable name');
  if (typeof file !== 'string' || !file.trim() || /[\0\n\r]/.test(file)) throw new Error('Invalid file path');
  return `grep -m1 -E ${shellQuote(`^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=`)} ${shellQuote(file)}`;
}

/**
 * POSIX sh script, fed to `sh -s` on the server (whatever the login shell): lists the env files
 * that hold a PostgreSQL URL, as "<file>\t<VARIABLE>" lines. Only the variable names leave the
 * server, never the values. Fixed text: nothing typed by the user reaches it.
 */
export const ENV_SEARCH_SCRIPT = `for d in "$HOME" /srv /var/www /opt /home; do
  [ -d "$d" ] || continue
  find "$d" -maxdepth 6 \\( -name node_modules -o -name .git -o -name vendor -o -name .cache -o -name .npm -o -name .nvm -o -name .local -o -name snap \\) -prune \\
    -o -type f \\( -name .env -o -name '.env.*' -o -name '*.env' \\) -size -512k -print 2>/dev/null
done | sort -u | head -n 300 | while IFS= read -r f; do
  grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.{0,2}postgres(ql)?://' "$f" 2>/dev/null \\
    | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*).*/\\2/' | sort -u \\
    | while IFS= read -r v; do printf '%s\\t%s\\n' "$f" "$v"; done
done
exit 0
`;

export interface EnvFileMatch {
  file: string;
  variables: string[];
  /** .env.example, .env.sample…: placeholders rather than the real URL */
  example: boolean;
  /** .env.production.bak-…, .env.old…: an earlier copy of a real file */
  copy: boolean;
}

/** The search's "<file>\t<VARIABLE>" lines, grouped by file: real files, then copies, then examples */
export function parseEnvSearch(stdout: string): EnvFileMatch[] {
  const byFile = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [file, variable] = line.split('\t');
    if (!file?.startsWith('/') || !variable || !isSafeEnvVar(variable)) continue;
    const vars = byFile.get(file) ?? [];
    if (!vars.includes(variable)) vars.push(variable);
    byFile.set(file, vars);
  }
  const name = (file: string) => file.split('/').pop() ?? '';
  const isExample = (file: string) => /(example|sample|template|dist|test)/i.test(name(file));
  const isCopy = (file: string) => !isExample(file) && /(\.bak|backup|\.old|\.orig|\.save|~$|\.\d{6,})/i.test(name(file));
  const rank = (m: EnvFileMatch) => (m.example ? 2 : m.copy ? 1 : 0);
  // DATABASE_URL first: it is the one apps (Prisma, Rails, Django…) read
  const order = (v: string) => (v === 'DATABASE_URL' ? 0 : /DATABASE|POSTGRES|PG/.test(v) ? 1 : 2);
  return [...byFile.entries()]
    .map(([file, variables]) => ({ file, variables: variables.sort((a, b) => order(a) - order(b) || a.localeCompare(b)), example: isExample(file), copy: isCopy(file) }))
    .sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file));
}

/** The value of `NAME=value` / `export NAME="value"` / `NAME='value' # comment` */
export function parseEnvLine(line: string, name: string): string | null {
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line.replace(/\r?\n$/, ''));
  if (!match) return null;
  let value = match[1].trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    value = value.replace(/\s+#.*$/, '');
  }
  return value;
}

/**
 * Where the tunnel should lead on the server, from the host of the URL read there:
 * a name without a dot (a Docker Compose service, "postgres") only resolves between
 * containers, so the tunnel goes to localhost and the user is told the port must be
 * published. Addresses and dotted names are reachable from the server: kept.
 */
export function remoteHostFromUrlHost(urlHost: string | undefined): { host: string; containerName?: string } {
  const host = (urlHost ?? '').trim();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return { host: 'localhost' };
  if (/^[\d.]+$/.test(host) || host.includes('.') || host.includes(':')) return { host };
  return { host: 'localhost', containerName: host };
}

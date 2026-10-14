/**
 * Which pg_dump to use for a server. pg_dump reads servers of its own major version and
 * older ones (back to 9.2), never newer ones: so the same major is best, otherwise the
 * closest newer one. Only when every installed pg_dump is older than the server is there
 * nothing to use.
 */
import * as path from 'path';

export interface PgToolVersion {
  path: string;
  version: string;
  majorVersion: string;
  source: 'libpq' | 'postgresql' | 'system';
}

const SOURCE_PRIORITY: Record<PgToolVersion['source'], number> = { postgresql: 1, libpq: 2, system: 3 };

export function pickPgDumpForServer(
  versions: PgToolVersion[],
  serverMajor: string,
): { tool: PgToolVersion; exact: boolean } | null {
  const server = parseInt(serverMajor, 10);
  if (!Number.isFinite(server)) return null;
  const usable = versions
    .map(v => ({ v, major: parseInt(v.majorVersion, 10) }))
    .filter(({ major }) => Number.isFinite(major) && major >= server)
    .sort((a, b) => a.major - b.major || SOURCE_PRIORITY[a.v.source] - SOURCE_PRIORITY[b.v.source]);
  if (!usable.length) return null;
  return { tool: usable[0].v, exact: usable[0].major === server };
}

/**
 * When the server's version is unknown: the newest pg_dump reads every older server, while
 * an older one stops with "server version mismatch".
 */
export function newestPgTool(versions: PgToolVersion[]): PgToolVersion | null {
  const sorted = versions
    .filter(v => Number.isFinite(parseInt(v.majorVersion, 10)))
    .sort((a, b) => parseInt(b.majorVersion, 10) - parseInt(a.majorVersion, 10)
      || b.version.localeCompare(a.version, undefined, { numeric: true })
      || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  return sorted[0] ?? null;
}

/** What to install when every pg_dump is older than the server */
export function pgDumpInstallHint(platform: NodeJS.Platform, serverMajor: string): string {
  if (platform === 'darwin') return `Install it with Homebrew: brew install postgresql@${serverMajor}`;
  if (platform === 'linux') {
    return `Install the matching client:\n  sudo apt install postgresql-client-${serverMajor}\n  or: sudo dnf install postgresql${serverMajor}`;
  }
  if (platform === 'win32') {
    return `Install the PostgreSQL ${serverMajor} client tools (bbdump finds them in Program Files):\n  winget install -e --id PostgreSQL.PostgreSQL.${serverMajor} --override "--mode unattended --enable-components commandlinetools --disable-components server,pgAdmin,stackbuilder"\n  or the EDB installer from postgresql.org`;
  }
  return `Install the PostgreSQL ${serverMajor} client tools`;
}

/** First of each file (paths compared without case on Windows) */
export function uniqueToolPaths<T extends { path: string }>(tools: T[], platform: string = process.platform): T[] {
  const seen = new Set<string>();
  return tools.filter(t => {
    const key = platform === 'win32' ? path.win32.normalize(t.path).toLowerCase() : path.normalize(t.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

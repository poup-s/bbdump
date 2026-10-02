import * as fs from 'fs';
import * as tls from 'tls';
import type { ConnectionOptions } from 'tls';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

export interface SslSettings {
  host?: string;
  ssl?: boolean;
  sslMode?: SslMode;
  sslRootCert?: string;
  connectionString?: string;
}

function uriParam(connectionString: string | undefined, name: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).searchParams.get(name) || undefined;
  } catch {
    const match = connectionString.match(new RegExp(`[?&]${name}=([^&]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

function uriHost(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname.replace(/^\[|\]$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Effective SSL settings, by priority: explicit sslMode field, then sslmode in the
 * connection string, then the legacy boolean `ssl` (v1.0.2 configs).
 */
export function resolveSsl(settings: SslSettings): { mode?: SslMode; rootCert?: string } {
  const fromUri = uriParam(settings.connectionString, 'sslmode') as SslMode | undefined;
  let mode: SslMode | undefined = settings.sslMode
    || (fromUri && SSL_MODES.includes(fromUri) ? fromUri : undefined)
    || (settings.ssl ? 'require' : undefined);
  const rootCert = settings.sslRootCert || uriParam(settings.connectionString, 'sslrootcert');
  // libpq: "require" with a root certificate behaves like verify-ca
  if (mode === 'require' && rootCert) mode = 'verify-ca';
  return { mode, rootCert };
}

export function isSslEnabled(settings: SslSettings): boolean {
  const { mode } = resolveSsl(settings);
  return !!mode && mode !== 'disable';
}

/**
 * node-postgres `ssl` option. prefer/require keep the historical behavior (encrypted,
 * certificate not checked); verify-ca/verify-full check the chain against the given CA
 * bundle (e.g. AWS RDS global-bundle.pem) or the system store.
 */
export function toNodePgSsl(settings: SslSettings): ConnectionOptions | undefined {
  const { mode, rootCert } = resolveSsl(settings);
  if (!mode || mode === 'disable') return undefined;
  if (mode === 'prefer' || mode === 'require') return { rejectUnauthorized: false };

  const options: ConnectionOptions = { rejectUnauthorized: true };
  if (rootCert) {
    options.ca = fs.readFileSync(rootCert, 'utf8');
  }
  if (mode === 'verify-ca') {
    // Chain is verified, host name is not (libpq verify-ca semantics)
    options.checkServerIdentity = () => undefined;
  } else {
    // node-postgres sends no servername for IP hosts, and Node then checks the
    // certificate against "localhost": always check against the real host.
    const host = settings.host || uriHost(settings.connectionString);
    if (host) {
      options.checkServerIdentity = (_hostname, cert) => tls.checkServerIdentity(host, cert);
    }
  }
  return options;
}

/** Environment for pg_dump / pg_restore / psql (libpq). */
export function libpqSslEnv(settings: SslSettings): Record<string, string> {
  const { mode, rootCert } = resolveSsl(settings);
  const env: Record<string, string> = {};
  if (mode) env.PGSSLMODE = mode;
  if (rootCert) env.PGSSLROOTCERT = rootCert;
  return env;
}

/**
 * Removes SSL parameters from a connection string before handing it to node-postgres,
 * which would otherwise re-read them per client and override the explicit `ssl` option
 * (and resolve a relative sslrootcert against the app's working directory).
 */
export function stripSslParams(connectionString: string): string {
  const names = ['sslmode', 'sslrootcert', 'ssl'];
  try {
    const url = new URL(connectionString);
    names.forEach(name => url.searchParams.delete(name));
    return url.toString();
  } catch {
    let result = connectionString;
    for (const name of names) {
      result = result.replace(new RegExp(`([?&])${name}=[^&]*&?`, 'g'), '$1');
    }
    return result.replace(/[?&]$/, '');
  }
}

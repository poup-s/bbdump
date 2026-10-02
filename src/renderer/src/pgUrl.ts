/**
 * Reads a PostgreSQL connection URL for the forms (add / edit database, onboarding).
 * Never throws. Handles what real URLs contain: any query parameters, unencoded "@", ":" or
 * "/" in the password, "%" that is not an escape, IPv6 hosts ([::1]). Several hosts
 * ("h1,h2") are refused: the node client bbdump uses cannot connect to them.
 */
import type { SslMode } from './types';

export interface ParsedPgUrl {
  user?: string;
  password?: string;
  host: string;
  port: number;
  database?: string;
  sslMode?: SslMode;
  sslRootCert?: string;
}

const SSL_MODES: readonly SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parsePgUrl(input: string): ParsedPgUrl | null {
  const match = input.trim().match(/^postgres(?:ql)?:\/\/(.*)$/is);
  if (!match) return null;
  const rest = match[1];

  // Query: from the first "?" (an unencoded "?" in a password is ambiguous for libpq too)
  const queryStart = rest.indexOf('?');
  const main = queryStart >= 0 ? rest.slice(0, queryStart) : rest;
  const query = queryStart >= 0 ? rest.slice(queryStart + 1) : '';

  // User info ends at the last "@": passwords may contain "@", ":" or "/"
  const at = main.lastIndexOf('@');
  const userInfo = at >= 0 ? main.slice(0, at) : '';
  const location = at >= 0 ? main.slice(at + 1) : main;

  const slash = location.indexOf('/');
  const hostPort = slash >= 0 ? location.slice(0, slash) : location;
  const database = slash >= 0 ? location.slice(slash + 1) : '';

  let host: string;
  let portText = '';
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end < 0) return null;
    host = hostPort.slice(1, end); // node-pg wants the bare address
    const after = hostPort.slice(end + 1);
    if (after && !after.startsWith(':')) return null;
    portText = after.slice(1);
  } else {
    if (hostPort.includes(',')) return null;
    const colon = hostPort.lastIndexOf(':');
    host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    portText = colon >= 0 ? hostPort.slice(colon + 1) : '';
  }
  if (!host || /[\s/]/.test(host)) return null;
  if (portText && !/^\d{1,5}$/.test(portText)) return null;
  const port = portText ? Number(portText) : 5432;
  if (port < 1 || port > 65535) return null;

  const colon = userInfo.indexOf(':');
  const user = colon >= 0 ? userInfo.slice(0, colon) : userInfo;
  const password = colon >= 0 ? userInfo.slice(colon + 1) : '';

  const params = new URLSearchParams(query);
  const sslMode = params.get('sslmode') as SslMode | null;
  return {
    user: user ? decode(user) : undefined,
    password: password ? decode(password) : undefined,
    host: decode(host),
    port,
    database: database ? decode(database) : undefined,
    sslMode: sslMode && SSL_MODES.includes(sslMode) ? sslMode : undefined,
    sslRootCert: params.get('sslrootcert') || undefined,
  };
}

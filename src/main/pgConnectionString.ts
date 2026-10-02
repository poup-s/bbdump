/**
 * Connection URLs as given to the PostgreSQL tools (pg_dump, pg_restore, psql).
 *
 * libpq refuses any query parameter it does not know ("invalid URI query parameter"),
 * while real-world URLs carry extras for other clients: Prisma's `schema`, `pgbouncer`,
 * `connection_limit`, `pool_timeout`…, or settings only recent libpq versions accept.
 * Only libpq connection keywords understood by every supported pg_dump (12+) are kept.
 */

/** libpq URI parameters accepted since PostgreSQL 12 */
const LIBPQ_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'dbname', 'user', 'password', 'passfile',
  'connect_timeout', 'client_encoding', 'options', 'application_name', 'fallback_application_name',
  'keepalives', 'keepalives_idle', 'keepalives_interval', 'keepalives_count', 'tcp_user_timeout',
  'sslmode', 'requiressl', 'sslcompression', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl',
  'requirepeer', 'gssencmode', 'krbsrvname', 'gsslib', 'service',
]);

export interface CleanedConnectionString {
  connectionString: string;
  /** Parameter names that were removed */
  removed: string[];
}

const paramName = (pair: string) => {
  const raw = pair.split('=')[0];
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
};

/** Keeps only the query parameters libpq accepts. Other strings are returned unchanged. */
export function connectionStringForPgTools(connectionString: string): CleanedConnectionString {
  const queryStart = connectionString.indexOf('?');
  if (!/^postgres(ql)?:\/\//i.test(connectionString.trim()) || queryStart < 0) {
    return { connectionString, removed: [] };
  }
  // Work on the raw query: URL() would re-encode the rest of the string
  const base = connectionString.slice(0, queryStart);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const pair of connectionString.slice(queryStart + 1).split('&')) {
    if (!pair) continue;
    const name = paramName(pair);
    if (LIBPQ_PARAMS.has(name)) kept.push(pair);
    else removed.push(name);
  }
  return { connectionString: kept.length ? `${base}?${kept.join('&')}` : base, removed };
}

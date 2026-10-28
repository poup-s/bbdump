/**
 * MySQL / MariaDB connections: a saved database (fields, or a mysql:// / mariadb:// URL with one
 * host) as options for the mysql2 driver and the command-line tools. Pure: shared by the app,
 * the MCP server (copied by scripts/copy-mcp-shared.mjs) and the tests.
 */

export interface MysqlTarget {
    connectionString?: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    /** The database (a MySQL "schema") */
    database: string;
    sslMode?: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
    sslRootCert?: string;
    /** host/port are a local SSH tunnel: the certificate names the real server */
    viaTunnel?: boolean;
}

/** What a connection needs, whatever reads it (driver, mysqldump config file) */
export interface MysqlConnection {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    /** undefined: no TLS. verifyServer: check the chain; verifyName: check the host name too */
    tls?: { verifyServer: boolean; verifyName: boolean; caFile?: string };
    /** host:port, for messages (never the password) */
    label: string;
}

export const MYSQL_DEFAULT_PORT = 3306;

export function isMysqlUri(text: string | undefined): boolean {
    return /^(mysql|mariadb):\/\//i.test(String(text ?? '').trim());
}

/** ssl-mode of MySQL's URLs and tools, sslaccept of some hosts (PlanetScale), ssl=true */
function urlSslMode(params: URLSearchParams): MysqlTarget['sslMode'] | undefined {
    const mode = (params.get('ssl-mode') ?? params.get('sslmode') ?? params.get('ssl_mode') ?? '').toUpperCase().replace(/-/g, '_');
    if (mode === 'DISABLED' || mode === 'DISABLE') return 'disable';
    if (mode === 'PREFERRED' || mode === 'PREFER') return 'prefer';
    if (mode === 'REQUIRED' || mode === 'REQUIRE') return 'require';
    if (mode === 'VERIFY_CA') return 'verify-ca';
    if (mode === 'VERIFY_IDENTITY' || mode === 'VERIFY_FULL') return 'verify-full';
    const accept = (params.get('sslaccept') ?? '').toLowerCase();
    if (accept === 'strict') return 'verify-full';
    if (accept === 'accept_invalid_certs') return 'require';
    const ssl = (params.get('ssl') ?? params.get('tls') ?? '').toLowerCase();
    if (ssl === 'true' || ssl === '1' || ssl.startsWith('{')) return 'require';
    if (ssl === 'false' || ssl === '0') return 'disable';
    return undefined;
}

/** The parts of a mysql:// URL; null when it cannot be read */
export function parseMysqlUri(text: string): { host: string; port: number; user: string; password?: string; database: string; sslMode?: MysqlTarget['sslMode']; sslRootCert?: string } | null {
    if (!isMysqlUri(text)) return null;
    try {
        // WHATWG URL only knows the special schemes' ports: read it as http to keep the rest
        const url = new URL(text.trim().replace(/^(mysql|mariadb):/i, 'http:'));
        if (!url.hostname) return null;
        return {
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port ? Number(url.port) : MYSQL_DEFAULT_PORT,
            user: decodeURIComponent(url.username),
            password: url.password ? decodeURIComponent(url.password) : undefined,
            database: decodeURIComponent(url.pathname.replace(/^\//, '')),
            sslMode: urlSslMode(url.searchParams),
            sslRootCert: url.searchParams.get('ssl-ca') ?? url.searchParams.get('sslrootcert') ?? undefined,
        };
    } catch {
        return null;
    }
}

/**
 * The connection of a target: the URL's parts win over the fields (a field left empty takes the
 * URL's value), the password field fills a URL saved without it, and the database field names
 * the database (a restore into another one).
 */
export function mysqlConnection(target: MysqlTarget): MysqlConnection {
    const fromUrl = target.connectionString ? parseMysqlUri(target.connectionString) : null;
    // Through a tunnel, host/port are the tunnel's local end, whatever the URL says
    const host = target.viaTunnel ? target.host : (fromUrl?.host ?? target.host);
    const port = target.viaTunnel ? target.port : (fromUrl?.port ?? target.port ?? MYSQL_DEFAULT_PORT);
    const user = fromUrl?.user || target.user || '';
    const password = fromUrl?.password ?? target.password ?? '';
    const database = target.database || fromUrl?.database || '';
    const mode = target.sslMode && target.sslMode !== 'disable' ? target.sslMode : (fromUrl?.sslMode ?? target.sslMode);
    const caFile = target.sslRootCert || fromUrl?.sslRootCert;
    let tls: MysqlConnection['tls'];
    if (mode === 'require') tls = { verifyServer: !!caFile, verifyName: false, caFile };
    else if (mode === 'verify-ca') tls = { verifyServer: true, verifyName: false, caFile };
    // Through a tunnel the certificate names the server, not 127.0.0.1: verify-full becomes verify-ca
    else if (mode === 'verify-full') tls = { verifyServer: true, verifyName: !target.viaTunnel, caFile };
    return { host, port: Number(port) || MYSQL_DEFAULT_PORT, user, password, database, tls, label: `${host}:${port}` };
}

/** Quotes an identifier (database, table, column) for MySQL / MariaDB */
export function mysqlIdent(name: string): string {
    return '`' + String(name).replace(/`/g, '``') + '`';
}

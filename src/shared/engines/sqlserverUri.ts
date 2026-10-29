/**
 * SQL Server connections: a saved database (fields, or a connection string) as options for the
 * tedious driver (through mssql). Reads the forms hosts give: sqlserver:// or mssql:// URLs,
 * JDBC URLs (jdbc:sqlserver://host:1433;databaseName=…) and ADO.NET strings (Server=…;Initial
 * Catalog=…, what Azure SQL shows). Pure: shared by the app, the MCP server and the tests.
 *
 * TLS as SQL Server's own drivers do (ODBC 18, Microsoft.Data.SqlClient 4+): encrypted and
 * verified unless the string says otherwise (TrustServerCertificate=true: encrypted, not verified).
 */

export type SqlServerSslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export interface SqlServerTarget {
    connectionString?: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    database: string;
    sslMode?: SqlServerSslMode;
    sslRootCert?: string;
    /** host/port are a local SSH tunnel */
    viaTunnel?: boolean;
}

/** What tedious needs (mssql's config), and a label for messages (never the password) */
export interface SqlServerConnection {
    server: string;
    port?: number;
    /** A named instance (host\SQLEXPRESS): found through the SQL Server Browser */
    instanceName?: string;
    user: string;
    password: string;
    database: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
    caFile?: string;
    label: string;
}

export const SQLSERVER_DEFAULT_PORT = 1433;

const truthy = (value: string | undefined) => /^(true|yes|1|on|mandatory|strict)$/i.test(String(value ?? '').trim());
const falsy = (value: string | undefined) => /^(false|no|0|off|optional)$/i.test(String(value ?? '').trim());

export function isSqlServerUri(text: string | undefined): boolean {
    const value = String(text ?? '').trim();
    return /^(sqlserver|mssql|jdbc:sqlserver):\/\//i.test(value) || /(^|;)\s*(server|data source|address|addr|network address)\s*=/i.test(value);
}

/** Encrypt / TrustServerCertificate as a mode: "no" plain, trusted "require", else verified */
function sslModeOf(encrypt: string | undefined, trust: string | undefined): SqlServerSslMode {
    if (falsy(encrypt)) return 'disable';
    return truthy(trust) ? 'require' : 'verify-full';
}

/** "host\instance,1433", "tcp:host,1433" or "host:1433" */
function hostPart(value: string): { host: string; port?: number } {
    let text = value.trim().replace(/^(tcp|np|lpc):/i, '');
    let port: number | undefined;
    const comma = text.match(/^(.*),\s*(\d+)$/);
    if (comma) {
        text = comma[1];
        port = Number(comma[2]);
    } else {
        const colon = text.match(/^([^:\\]+):(\d+)$/);
        if (colon) {
            text = colon[1];
            port = Number(colon[2]);
        }
    }
    return { host: text.trim(), port };
}

export interface ParsedSqlServerUri {
    host: string;
    port: number;
    user: string;
    password?: string;
    database: string;
    sslMode: SqlServerSslMode;
}

/** Key=value;… (ADO.NET, and the part of a JDBC URL after the host): keys lower case */
function keyValues(text: string): Map<string, string> {
    const map = new Map<string, string>();
    // Values may be in {braces} or "quotes" (a ; inside a password)
    const re = /\s*([^=;]+?)\s*=\s*("((?:[^"]|"")*)"|\{((?:[^}]|\}\})*)\}|[^;]*)\s*(;|$)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) && match[0]) {
        const value = match[3] !== undefined ? match[3].replace(/""/g, '"') : match[4] !== undefined ? match[4].replace(/\}\}/g, '}') : match[2].trim();
        map.set(match[1].toLowerCase().replace(/\s+/g, ' '), value);
    }
    return map;
}

const pick = (map: Map<string, string>, ...keys: string[]) => keys.map(key => map.get(key)).find(value => value !== undefined);

function fromKeyValues(map: Map<string, string>, base: Partial<ParsedSqlServerUri> = {}): ParsedSqlServerUri | null {
    const server = pick(map, 'server', 'data source', 'address', 'addr', 'network address', 'servername', 'server name');
    const where = server ? hostPart(server) : { host: base.host ?? '', port: base.port };
    if (!where.host) return null;
    const portText = pick(map, 'port', 'portnumber');
    return {
        host: where.host,
        port: Number(portText) || where.port || base.port || SQLSERVER_DEFAULT_PORT,
        user: pick(map, 'user id', 'uid', 'user', 'username', 'user name') ?? base.user ?? '',
        password: pick(map, 'password', 'pwd') ?? base.password,
        database: pick(map, 'initial catalog', 'database', 'databasename', 'database name') ?? base.database ?? '',
        sslMode: sslModeOf(pick(map, 'encrypt'), pick(map, 'trustservercertificate', 'trust server certificate')),
    };
}

/** The parts of a SQL Server connection string; null when it cannot be read */
export function parseSqlServerUri(text: string): ParsedSqlServerUri | null {
    const value = String(text ?? '').trim();
    if (!isSqlServerUri(value)) return null;
    try {
        const jdbc = value.match(/^jdbc:sqlserver:\/\/([^;]*)(;.*)?$/i);
        if (jdbc) {
            const where = hostPart(decodeURIComponent(jdbc[1]));
            return fromKeyValues(keyValues(jdbc[2] ?? ''), { host: where.host, port: where.port });
        }
        if (/^(sqlserver|mssql):\/\//i.test(value)) {
            const url = new URL(value.replace(/^(sqlserver|mssql):/i, 'http:'));
            const params = new Map([...url.searchParams.entries()].map(([k, v]) => [k.toLowerCase(), v]));
            // A named instance: ?instanceName=SQLEXPRESS
            const host = decodeURIComponent(url.hostname);
            const instance = params.get('instancename');
            return {
                host: instance ? `${host}\\${instance}` : host,
                port: Number(url.port) || SQLSERVER_DEFAULT_PORT,
                user: decodeURIComponent(url.username),
                password: url.password ? decodeURIComponent(url.password) : undefined,
                database: decodeURIComponent(url.pathname.replace(/^\//, '')) || params.get('database') || params.get('databasename') || '',
                sslMode: sslModeOf(params.get('encrypt'), params.get('trustservercertificate')),
            };
        }
        return fromKeyValues(keyValues(value));
    } catch {
        return null;
    }
}

/** A saved database (its fields, or its connection string) as driver options */
export function sqlserverConnection(target: SqlServerTarget): SqlServerConnection {
    const parsed = target.connectionString && !target.viaTunnel ? parseSqlServerUri(target.connectionString) : null;
    const host = parsed?.host ?? target.host;
    const [server, instanceName] = host.split('\\');
    const mode = target.sslMode ?? parsed?.sslMode ?? 'verify-full';
    const port = parsed?.port ?? target.port ?? SQLSERVER_DEFAULT_PORT;
    // A named instance has its own port, found through the Browser, unless one was given
    const explicitPort = !!port && port !== SQLSERVER_DEFAULT_PORT;
    return {
        server: server || 'localhost',
        port: instanceName && !explicitPort ? undefined : port || SQLSERVER_DEFAULT_PORT,
        instanceName: instanceName || undefined,
        user: parsed?.user || target.user,
        password: (parsed?.password ?? target.password) || '',
        database: parsed?.database || target.database,
        encrypt: mode !== 'disable',
        trustServerCertificate: mode === 'require' || mode === 'prefer',
        caFile: mode === 'verify-ca' || mode === 'verify-full' ? target.sslRootCert : undefined,
        label: instanceName && !explicitPort ? host : `${host}:${port || SQLSERVER_DEFAULT_PORT}`,
    };
}

/** [name], a ] doubled */
export const sqlserverIdent = (name: string) => `[${String(name).replace(/\]/g, ']]')}]`;

/**
 * MongoDB connection strings: mongodb://user:pass@host1:27017,host2/db?options and
 * mongodb+srv://user:pass@cluster.example.net/db. WHATWG URL cannot read the multi-host form,
 * so they are parsed here, the same way in the main process and in the renderer.
 */

export interface MongoHost {
    host: string;
    port?: number;
}

export interface MongoUri {
    srv: boolean;
    username?: string;
    password?: string;
    hosts: MongoHost[];
    database?: string;
    /** In their order, values decoded */
    options: Array<[string, string]>;
}

export const MONGO_DEFAULT_PORT = 27017;

export function isMongoUri(value: string | undefined | null): boolean {
    return typeof value === 'string' && /^mongodb(\+srv)?:\/\//i.test(value.trim());
}

const decode = (part: string): string | null => {
    try {
        return decodeURIComponent(part);
    } catch {
        return null;
    }
};

function parseHost(raw: string): MongoHost | null {
    let host: string;
    let portText: string | undefined;
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        if (end < 0) return null;
        host = raw.slice(1, end);
        const after = raw.slice(end + 1);
        if (after && !after.startsWith(':')) return null;
        portText = after ? after.slice(1) : undefined;
    } else {
        const colon = raw.lastIndexOf(':');
        host = colon >= 0 ? raw.slice(0, colon) : raw;
        portText = colon >= 0 ? raw.slice(colon + 1) : undefined;
    }
    const decoded = decode(host);
    if (!decoded || /[\s/?#@]/.test(decoded)) return null;
    if (portText === undefined) return { host: decoded };
    if (!/^\d{1,5}$/.test(portText)) return null;
    const port = Number(portText);
    return port >= 1 && port <= 65535 ? { host: decoded, port } : null;
}

/** Null when the string is not a usable MongoDB connection string */
export function parseMongoUri(value: string): MongoUri | null {
    const match = /^(mongodb(?:\+srv)?):\/\/(.*)$/is.exec(value.trim());
    if (!match) return null;
    const srv = match[1].toLowerCase() === 'mongodb+srv';
    const rest = match[2];

    // Credentials end at the last '@' before the path: '@' in a password must be encoded,
    // but a pasted one often is not
    const pathStart = rest.search(/[/?]/);
    const authority = pathStart >= 0 ? rest.slice(0, pathStart) : rest;
    const tail = pathStart >= 0 ? rest.slice(pathStart) : '';
    const at = authority.lastIndexOf('@');
    const userInfo = at >= 0 ? authority.slice(0, at) : undefined;
    const hostList = at >= 0 ? authority.slice(at + 1) : authority;

    let username: string | undefined;
    let password: string | undefined;
    if (userInfo !== undefined) {
        const colon = userInfo.indexOf(':');
        const user = decode(colon >= 0 ? userInfo.slice(0, colon) : userInfo);
        const pass = colon >= 0 ? decode(userInfo.slice(colon + 1)) : undefined;
        if (user === null || pass === null) return null;
        username = user || undefined;
        password = pass;
    }

    if (!hostList) return null;
    const hosts: MongoHost[] = [];
    for (const raw of hostList.split(',')) {
        const host = parseHost(raw.trim());
        if (!host || !host.host) return null;
        hosts.push(host);
    }
    // An SRV record names one host, without a port
    if (srv && (hosts.length !== 1 || hosts[0].port !== undefined)) return null;

    let database: string | undefined;
    const options: Array<[string, string]> = [];
    if (tail) {
        const question = tail.indexOf('?');
        const path = question >= 0 ? tail.slice(0, question) : tail;
        const query = question >= 0 ? tail.slice(question + 1) : '';
        if (path.length > 1) {
            const name = decode(path.slice(1));
            if (name === null || name.includes('/')) return null;
            database = name;
        }
        for (const pair of query.split('&')) {
            if (!pair) continue;
            const eq = pair.indexOf('=');
            const key = decode(eq >= 0 ? pair.slice(0, eq) : pair);
            const optionValue = decode(eq >= 0 ? pair.slice(eq + 1) : '');
            if (key === null || optionValue === null || !key) return null;
            options.push([key, optionValue]);
        }
    }
    return { srv, username, password, hosts, database, options };
}

export function formatMongoUri(uri: MongoUri): string {
    const credentials = uri.username
        ? `${encodeURIComponent(uri.username)}${uri.password !== undefined ? `:${encodeURIComponent(uri.password)}` : ''}@`
        : '';
    const hosts = uri.hosts
        .map(h => `${h.host.includes(':') ? `[${h.host}]` : h.host}${h.port !== undefined ? `:${h.port}` : ''}`)
        .join(',');
    const query = uri.options.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return `mongodb${uri.srv ? '+srv' : ''}://${credentials}${hosts}/${uri.database ? encodeURIComponent(uri.database) : ''}${query ? `?${query}` : ''}`;
}

/** An option's value, whatever its case (MongoDB option names are case-insensitive) */
export function mongoOption(uri: MongoUri, name: string): string | undefined {
    const lower = name.toLowerCase();
    return uri.options.find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** The same URI with an option set (replacing one of the same name, whatever its case) */
export function withMongoOption(uri: MongoUri, name: string, value: string): MongoUri {
    const lower = name.toLowerCase();
    return { ...uri, options: [...uri.options.filter(([key]) => key.toLowerCase() !== lower), [name, value]] };
}

/** The SSL modes of the dialog, PostgreSQL style */
export type MongoSslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/** What a MongoDB database is reached with: a URL, or the fields of the dialog */
export interface MongoTarget {
    connectionString?: string;
    host: string;
    port: number;
    user: string;
    password?: string;
    /** The database bbdump works on */
    database: string;
    sslMode?: MongoSslMode;
    sslRootCert?: string;
    mongo?: { authSource?: string };
    /** Reached through an SSH tunnel (host/port are its local end) */
    viaTunnel?: boolean;
}

/** TLS options matching the PostgreSQL-style SSL modes of the dialog */
function withTls(uri: MongoUri, sslMode: MongoSslMode | undefined, rootCert: string | undefined): MongoUri {
    if (!sslMode || sslMode === 'disable' || sslMode === 'prefer') return uri;
    let next = withMongoOption(uri, 'tls', 'true');
    // require: encrypted, certificate not checked (like PostgreSQL's sslmode=require)
    if (sslMode === 'require') next = withMongoOption(next, 'tlsAllowInvalidCertificates', 'true');
    // verify-ca: certificate checked, not the host name
    if (sslMode === 'verify-ca') next = withMongoOption(next, 'tlsAllowInvalidHostnames', 'true');
    if (rootCert) next = withMongoOption(next, 'tlsCAFile', rootCert);
    return next;
}

/** The connection string to use (password included, memory only) and the database to open */
export function mongoConnection(target: MongoTarget): { uri: string; database: string; hosts: string } {
    let uri: MongoUri;
    if (target.connectionString && isMongoUri(target.connectionString)) {
        const parsed = parseMongoUri(target.connectionString);
        if (!parsed) throw new Error('This MongoDB connection string cannot be read');
        uri = parsed.username && parsed.password === undefined && target.password ? { ...parsed, password: target.password } : parsed;
    } else {
        const user = target.user?.trim();
        uri = {
            srv: false,
            username: user || undefined,
            password: user ? target.password || undefined : undefined,
            hosts: [{ host: target.host.trim(), port: target.port || MONGO_DEFAULT_PORT }],
            database: target.database || undefined,
            options: [],
        };
        // A user lives in "admin" unless told otherwise (the path's database would be assumed)
        if (user) uri = withMongoOption(uri, 'authSource', target.mongo?.authSource?.trim() || 'admin');
        uri = withTls(uri, target.sslMode, target.sslRootCert);
        // Through a tunnel only this server is reachable: no discovery of the other members of a replica set
        if (target.viaTunnel) uri = withMongoOption(uri, 'directConnection', 'true');
    }
    const database = target.database || uri.database;
    if (!database) throw new Error('No database name: add it at the end of the URL (…/mydb) or in the field');
    const hosts = uri.hosts.map(h => (h.port ? `${h.host}:${h.port}` : h.host)).join(',');
    return { uri: formatMongoUri(uri), database, hosts: `${uri.srv ? 'srv:' : ''}${hosts}${mongoOption(uri, 'tls') === 'true' ? ' (TLS)' : ''}` };
}

/**
 * A URL with a user and a database but no authSource authenticates against that database:
 * MongoDB's rule, and the usual cause of "Authentication failed" (users mostly live in admin).
 */
export function authSourceHint(target: MongoTarget): string | undefined {
    if (!target.connectionString || !isMongoUri(target.connectionString)) return undefined;
    const parsed = parseMongoUri(target.connectionString);
    if (!parsed || parsed.srv || !parsed.username || !parsed.database || mongoOption(parsed, 'authSource') !== undefined) return undefined;
    return `The user is looked up in "${parsed.database}": if it is defined in admin, add ?authSource=admin to the URL.`;
}

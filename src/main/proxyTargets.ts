/**
 * What a project's proxy connects to, for each engine, from a saved database (password
 * decrypted). Pure: the SSH tunnel's local end, when there is one, is given by the caller.
 */
import type { DatabaseConfig } from '../types/config';
import { proxyProtocolOf } from '../shared/engines/proxy';
import { mysqlConnection, type MysqlConnection } from '../shared/engines/mysqlUri';
import { mongoConnection, mongoOption, parseMongoUri } from '../shared/engines/mongoUri';
import type { TargetCredentials } from './pgProtocol';
import type { MongoProxyTarget } from './mongoProxy';
import { isSslEnabled } from './sslConfig';

export { proxyProtocolOf, type ProxyProtocol } from '../shared/engines/proxy';

export type ProxyTarget =
    | (TargetCredentials & { engine: 'postgresql' })
    | { engine: 'mysql'; host: string; port: number; database: string; conn: MysqlConnection }
    | { engine: 'mongodb'; host: string; port: number; database: string; mongo: MongoProxyTarget };


function postgresTarget(db: DatabaseConfig): TargetCredentials {
    if (db.connectionString) {
        try {
            const url = new URL(db.connectionString);
            return {
                host: url.hostname || 'localhost',
                port: parseInt(url.port) || 5432,
                user: decodeURIComponent(url.username) || 'postgres',
                password: decodeURIComponent(url.password) || db.password || '',
                database: url.pathname.replace(/^\//, '') || db.name || 'postgres',
                ssl: isSslEnabled(db),
            };
        } catch {
            // The fields below
        }
    }
    return {
        host: db.host || 'localhost',
        port: db.port || 5432,
        user: db.user || 'postgres',
        password: db.password || '',
        database: db.name || 'postgres',
        ssl: isSslEnabled(db),
    };
}

/**
 * The proxy target of a saved database (password already decrypted). `tunnel`: the local end
 * of its SSH tunnel (the certificate then names the real server, not 127.0.0.1).
 */
export function proxyTargetFor(db: DatabaseConfig, tunnel?: { host: string; port: number }): ProxyTarget | null {
    const protocol = proxyProtocolOf(db);
    if (protocol === 'postgresql') {
        return { engine: 'postgresql', ...postgresTarget(db), ...(tunnel ?? {}) };
    }
    if (protocol === 'mysql') {
        const conn = mysqlConnection({
            connectionString: db.connectionString, host: tunnel?.host ?? db.host, port: tunnel?.port ?? db.port, user: db.user, password: db.password,
            database: db.name, sslMode: db.sslMode as never, sslRootCert: db.sslRootCert, viaTunnel: !!tunnel,
        });
        return { engine: 'mysql', host: conn.host, port: conn.port, database: conn.database, conn };
    }
    if (protocol === 'mongodb') {
        const { uri, database } = mongoConnection({
            connectionString: db.connectionString, host: db.host, port: db.port, user: db.user, password: db.password,
            database: db.name, sslMode: db.sslMode as never, sslRootCert: db.sslRootCert, mongo: db.mongo,
        });
        const parsed = parseMongoUri(uri);
        if (!parsed) return null;
        const option = (name: string) => mongoOption(parsed, name)?.toLowerCase();
        const useTls = option('tls') === 'true' || option('ssl') === 'true' || (parsed.srv && option('tls') !== 'false' && option('ssl') !== 'false');
        const insecure = option('tlsallowinvalidcertificates') === 'true' || option('tlsinsecure') === 'true';
        const first = parsed.hosts[0];
        const host = tunnel?.host ?? first.host;
        const port = tunnel?.port ?? first.port ?? 27017;
        return {
            engine: 'mongodb',
            host,
            port,
            database,
            mongo: {
                host,
                port,
                // A cluster (several hosts, SRV): its primary; through a tunnel only that server
                discoveryUri: !tunnel && (parsed.srv || parsed.hosts.length > 1) ? uri : undefined,
                tls: useTls ? {
                    verifyServer: !insecure,
                    verifyName: !insecure && option('tlsallowinvalidhostnames') !== 'true' && !tunnel,
                    caFile: mongoOption(parsed, 'tlsCAFile'),
                    servername: tunnel ? first.host : undefined,
                } : undefined,
                user: parsed.username,
                password: parsed.password,
                authSource: mongoOption(parsed, 'authSource') || (parsed.srv ? 'admin' : parsed.database || 'admin'),
                mechanism: mongoOption(parsed, 'authMechanism'),
                database,
            },
        };
    }
    return null;
}

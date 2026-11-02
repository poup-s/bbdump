/**
 * Project proxy: the protocol it speaks for a database, and the URL an app uses to reach it
 * (no real credentials in it). Pure: shared by the main process and the renderer.
 */
import { engineOf } from './features';
import { isMysqlFamily } from './manifests';

/** MariaDB speaks MySQL's protocol */
export type ProxyProtocol = 'postgresql' | 'mysql' | 'mongodb' | 'sqlserver';

/** Null for an engine a project proxy cannot route to (SQLite: a file, no server) */
export function proxyProtocolOf(db: { engine?: string } | null | undefined): ProxyProtocol | null {
    const engine = engineOf(db);
    if (engine === 'postgresql') return 'postgresql';
    if (isMysqlFamily(engine)) return 'mysql';
    if (engine === 'mongodb') return 'mongodb';
    if (engine === 'sqlserver') return 'sqlserver';
    return null;
}

/**
 * The app's URL. PostgreSQL, MySQL and SQL Server take any user and password (the proxy logs in with the
 * saved ones); MongoDB takes none (a login would be the app's, not the saved account's).
 */
export function proxyUrl(protocol: ProxyProtocol, port: number, name: string): string {
    if (protocol === 'mysql') return `mysql://${name}:${name}@127.0.0.1:${port}/${name}`;
    if (protocol === 'mongodb') return `mongodb://127.0.0.1:${port}/${name}?directConnection=true`;
    // SQL Server: no encryption on 127.0.0.1 (the proxy logs in with TLS when the database asks for it)
    if (protocol === 'sqlserver') return `sqlserver://127.0.0.1:${port};database=${name};user=${name};password=${name};encrypt=false`;
    return `postgresql://${name}:${name}@localhost:${port}/${name}`;
}

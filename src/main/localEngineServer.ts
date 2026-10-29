/**
 * The local server of MySQL, MariaDB and MongoDB: what runs on this computer, installing and
 * starting it, the account bbdump uses, and the databases created on it (saved with
 * isLocalBbdump: deleting one in bbdump drops it on the server).
 *
 * The account (MySQL / MariaDB): the one saved in <userData>/local-servers.json (encrypted,
 * 0600, apart from config.json), else root without a password (Homebrew's MySQL). Homebrew's
 * MariaDB only lets the system user in through its socket: on request bbdump creates a
 * "bbdump" account there. Otherwise the user types an administrator account once.
 * MongoDB installed by Homebrew or winget has no login: none is needed.
 */
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseConfig } from '../types/config';
import { getConfig, saveConfig } from './ipc/configIpc';
import { encryptionManager } from './encryption';
import { pathManager } from './paths';
import { logger } from './logger';
import { getErrorMessage } from './utils';
import { app } from 'electron';
import { quoteIdent } from '../shared/engines/sqlGuard';
import { parseGreeting, readPacket } from './mysqlProxy';
import { defaultWhich, firstExisting, isPortOpen, run } from './platform/probe';
import { defaultBrewPath, runBrew } from './platform/macos';
import { runScriptWithPkexec } from './platform/linux';
import { detectEnvironment, installFamily } from './platform/environment';
import { wingetCandidates } from './platform/windows';
import {
    LOCAL_ACCOUNT, LOCAL_ENGINE_PORT, SERVER_BINARIES, WINDOWS_SERVICES, brewBinaryCandidates, linuxLocalScript, linuxStartScript,
    macosLocalSteps, macosStartStep, manualLocalInstall, wingetLocalArgs, type LocalEngine,
} from './platform/localEngines';

type SystemOs = 'macos' | 'linux' | 'windows';
const systemOs = (): SystemOs => (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux');
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

export interface LocalServerState {
    engine: LocalEngine;
    port: number;
    os: SystemOs;
    /** Something answers on 127.0.0.1:port */
    running: boolean;
    /** What answers (a MariaDB on MySQL's port, MySQL on MariaDB's…) */
    answering?: LocalEngine;
    version?: string;
    /** The server's program is on this computer */
    installed: boolean;
    /** ready: bbdump can log in; needed: an account must be typed (or created, see canCreateAccount) */
    account: 'ready' | 'needed' | 'unknown';
    user?: string;
    /** Homebrew's MariaDB reached through the system user's socket: bbdump can create its account */
    canCreateAccount: boolean;
    canInstall: boolean;
    canStart: boolean;
    /** The command to type when bbdump cannot install it itself */
    installCommand: string;
}

// --- Saved accounts ---------------------------------------------------------------------------

interface SavedAccount { user: string; password: string }
const accountsFile = () => path.join(pathManager.appDataPath, 'local-servers.json');
const accountKey = (engine: LocalEngine, port: number) => `${engine === 'mongodb' ? 'mongodb' : 'mysql'}:${port}`;

function readAccounts(): Record<string, { user: string; password: string; savedAt?: string }> {
    try {
        const raw = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        return {};
    }
}

function savedAccount(engine: LocalEngine, port: number): SavedAccount | null {
    const entry = readAccounts()[accountKey(engine, port)];
    if (!entry || typeof entry.user !== 'string' || typeof entry.password !== 'string') return null;
    try {
        return { user: entry.user, password: entry.password ? encryptionManager.decrypt(entry.password) : '' };
    } catch {
        logger.warn('Saved local server account cannot be read: ignored');
        return null;
    }
}

function saveAccount(engine: LocalEngine, port: number, account: SavedAccount): void {
    const all = readAccounts();
    all[accountKey(engine, port)] = { user: account.user, password: account.password ? encryptionManager.encrypt(account.password) : '', savedAt: new Date().toISOString() };
    const file = accountsFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

// --- What answers -----------------------------------------------------------------------------

/** The MySQL-family server on a port: its greeting tells MySQL from MariaDB */
async function mysqlGreeting(port: number): Promise<{ flavour: 'mysql' | 'mariadb'; version: string } | null> {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.setTimeout(1500, () => reject(new Error('timeout')));
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        socket.setTimeout(0);
        const first = await Promise.race([readPacket(socket), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
        const greeting = parseGreeting(first.payload);
        const version = greeting.serverVersion.replace(/^5\.5\.5-/, '').replace(/-MariaDB.*$/i, '');
        return { flavour: /mariadb/i.test(greeting.serverVersion) ? 'mariadb' : 'mysql', version };
    } catch {
        return null;
    } finally {
        socket.destroy();
    }
}

async function mysqlLogin(options: { port?: number; socketPath?: string; user: string; password: string }) {
    const { createConnection } = await import('mysql2/promise');
    return createConnection({
        ...(options.socketPath ? { socketPath: options.socketPath } : { host: '127.0.0.1', port: options.port }),
        user: options.user, password: options.password, connectTimeout: 5000,
        // MariaDB's socket login: the server checks the system user, the client sends nothing
        authPlugins: { unix_socket: () => () => Buffer.alloc(0) },
    });
}

async function canLogInMysql(port: number, user: string, password: string): Promise<boolean> {
    try {
        const conn = await mysqlLogin({ port, user, password });
        await conn.end();
        return true;
    } catch {
        return false;
    }
}

const MYSQL_SOCKETS = ['/tmp/mysql.sock', '/opt/homebrew/var/mysql/mysql.sock', '/usr/local/var/mysql/mysql.sock', '/var/run/mysqld/mysqld.sock', '/run/mysqld/mysqld.sock'];

/** A socket where the system user is let in as an administrator (Homebrew's MariaDB), or null */
async function socketAdmin(): Promise<string | null> {
    if (process.platform === 'win32') return null;
    const user = os.userInfo().username;
    for (const socketPath of MYSQL_SOCKETS.filter(file => fs.existsSync(file))) {
        try {
            const conn = await mysqlLogin({ socketPath, user, password: '' });
            const [rows] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE = 'CREATE USER'");
            await conn.end();
            if (Number((rows as Array<{ n: number }>)[0]?.n) > 0) return socketPath;
        } catch {
            // Not this one
        }
    }
    return null;
}

function mongoUrl(port: number, account?: SavedAccount): string {
    const auth = account?.user ? `${encodeURIComponent(account.user)}:${encodeURIComponent(account.password)}@` : '';
    return `mongodb://${auth}127.0.0.1:${port}/?directConnection=true${account?.user ? '&authSource=admin' : ''}`;
}

async function mongoAccess(port: number, account?: SavedAccount): Promise<{ ok: boolean; version?: string; needsLogin?: boolean }> {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(mongoUrl(port, account), { serverSelectionTimeoutMS: 2500, connectTimeoutMS: 2500 });
    try {
        await client.connect();
        const build = await client.db('admin').command({ buildInfo: 1 });
        try {
            await client.db('admin').command({ listDatabases: 1, nameOnly: true });
            return { ok: true, version: String(build.version ?? '') };
        } catch (error) {
            return { ok: false, version: String(build.version ?? ''), needsLogin: /unauthorized|requires authentication/i.test(getErrorMessage(error)) };
        }
    } catch (error) {
        return { ok: false, needsLogin: /authentication/i.test(getErrorMessage(error)) };
    } finally {
        await client.close().catch(() => {});
    }
}

/** The account bbdump logs in with, or null */
async function workingAccount(engine: LocalEngine, port: number): Promise<SavedAccount | null> {
    const saved = savedAccount(engine, port);
    if (engine === 'mongodb') {
        if ((await mongoAccess(port)).ok) return { user: '', password: '' };
        return saved && (await mongoAccess(port, saved)).ok ? saved : null;
    }
    if (saved && await canLogInMysql(port, saved.user, saved.password)) return saved;
    // Homebrew's MySQL: root without a password, on this computer only
    if (await canLogInMysql(port, 'root', '')) return { user: 'root', password: '' };
    return null;
}

/** The Windows service of a server (from its installer), or null */
async function windowsService(engine: LocalEngine): Promise<string | null> {
    for (const name of WINDOWS_SERVICES[engine]) {
        const result = await run('sc.exe', ['query', name], 5000).catch(() => null);
        if (result && result.code === 0) return name;
    }
    return null;
}

async function installedBinary(engine: LocalEngine): Promise<boolean> {
    if (process.platform === 'darwin' && firstExisting(brewBinaryCandidates(engine))) return true;
    for (const name of SERVER_BINARIES[engine]) if (await defaultWhich(name)) return true;
    if (process.platform === 'win32') return (await windowsService(engine)) !== null;
    if (process.platform === 'linux') return SERVER_BINARIES[engine].some(name => fs.existsSync(`/usr/sbin/${name}`));
    return false;
}

/**
 * What runs the Linux scripts as root: pkexec (the system asks for the password). Dev and tests
 * only (the app not packaged): BBDUMP_PKEXEC names another one, e.g. sudo in the CI.
 */
async function rootRunner(): Promise<string | null> {
    if (!app.isPackaged && process.env.BBDUMP_PKEXEC) return process.env.BBDUMP_PKEXEC;
    return defaultWhich('pkexec');
}

async function brewPath(): Promise<string | null> {
    const found = await defaultWhich('brew');
    if (found) return found;
    const fallback = defaultBrewPath(process.arch);
    return fs.existsSync(fallback) ? fallback : null;
}

async function wingetPath(): Promise<string | null> {
    return (await defaultWhich('winget')) ?? firstExisting(wingetCandidates());
}

export async function localServerState(engine: LocalEngine, port = LOCAL_ENGINE_PORT[engine]): Promise<LocalServerState> {
    const system = systemOs();
    const family = system === 'linux' ? installFamily(await detectEnvironment()) : 'unknown';
    const installed = await installedBinary(engine);
    const base = {
        engine, port, os: system,
        installCommand: manualLocalInstall(engine, system, family),
        canInstall: system === 'macos' ? !!(await brewPath())
            : system === 'windows' ? !!wingetLocalArgs(engine) && !!(await wingetPath())
                : !!linuxLocalScript(engine, family, '0'.repeat(32)) && !!(await rootRunner()),
    };
    if (!(await isPortOpen(port, '127.0.0.1', 1500))) {
        return { ...base, installed, running: false, account: 'unknown', canCreateAccount: false, canStart: installed };
    }
    if (engine === 'mongodb') {
        const access = await mongoAccess(port);
        // Not MongoDB on that port (maybe MySQL)
        if (!access.ok && !access.needsLogin && !access.version) return { ...base, installed, running: true, account: 'unknown', canCreateAccount: false, canStart: false };
        const account = access.ok ? { user: '', password: '' } : await workingAccount(engine, port);
        return {
            ...base, installed: true, running: true, answering: 'mongodb', version: access.version,
            account: account ? 'ready' : 'needed', user: account?.user || undefined, canCreateAccount: false, canStart: false,
        };
    }
    const greeting = await mysqlGreeting(port);
    if (!greeting) return { ...base, installed, running: true, account: 'unknown', canCreateAccount: false, canStart: false };
    const account = await workingAccount(engine, port);
    return {
        ...base, installed: true, running: true, answering: greeting.flavour, version: greeting.version,
        account: account ? 'ready' : 'needed', user: account?.user,
        canCreateAccount: !account && !!(await socketAdmin()), canStart: false,
    };
}

/** Waits for the server to accept connections after an install or a start */
async function waitForPort(port: number, seconds: number): Promise<boolean> {
    for (let i = 0; i < seconds; i++) {
        if (await isPortOpen(port, '127.0.0.1', 1000)) return true;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

/** What to show of a failed command: its error lines when it printed some, else its last lines */
export function lastLines(text: string, count: number): string {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const errors = lines.filter(l => /\[ERROR\]|^Error:|\berror:/i.test(l));
    return (errors.length ? errors : lines).slice(-count).join('\n');
}

export async function installLocalServer(engine: LocalEngine, onLine: (line: string) => void): Promise<{ success: boolean; error?: string }> {
    const system = systemOs();
    const port = LOCAL_ENGINE_PORT[engine];
    try {
        if (system === 'macos') {
            const brew = await brewPath();
            if (!brew) return { success: false, error: 'Homebrew is not installed' };
            for (const step of macosLocalSteps(engine, brew)) {
                onLine(`brew ${step.slice(1).join(' ')}`);
                const result = await runBrew(step, onLine);
                // `brew trust` only exists since Homebrew 7: older versions load any tap
                if (result.code !== 0 && step[1] === 'trust' && /unknown command/i.test(result.output)) continue;
                if (result.code !== 0) return { success: false, error: lastLines(result.output, 5) || `brew ${step[1]} failed` };
            }
        } else if (system === 'linux') {
            const family = installFamily(await detectEnvironment());
            const password = randomBytes(24).toString('hex');
            const script = linuxLocalScript(engine, family, password);
            const pkexec = await rootRunner();
            if (!script || !pkexec) return { success: false, error: 'bbdump cannot install it on this system: use the command shown' };
            const result = await runScriptWithPkexec(script, pkexec, onLine);
            if (result.cancelled) return { success: false, error: 'Cancelled' };
            // 3: installed and running, but root (set up before) asks for a password: an account is typed in bbdump
            if (result.code === 3) logger.info(`Local ${engine} server installed; its root account asks for a password`);
            else if (result.code !== 0) return { success: false, error: lastLines(result.output, 5) };
            else saveAccount(engine, port, { user: LOCAL_ACCOUNT, password });
        } else {
            const args = wingetLocalArgs(engine);
            const winget = await wingetPath();
            if (!args || !winget) return { success: false, error: 'bbdump cannot install it on this system: use the link shown' };
            onLine(`winget ${args.join(' ')}`);
            const result = await run(winget, args, 30 * 60 * 1000);
            if (result.code !== 0) return { success: false, error: lastLines(result.stderr || result.stdout, 5) };
        }
        if (!(await waitForPort(port, 60))) return { success: false, error: 'Installed, but the server does not answer yet: start it, then check again' };
        logger.info(`Local ${engine} server installed`);
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
}

export async function startLocalServer(engine: LocalEngine): Promise<{ success: boolean; error?: string }> {
    const system = systemOs();
    try {
        if (system === 'macos') {
            const brew = await brewPath();
            if (!brew) return { success: false, error: 'Homebrew is not installed' };
            const result = await runBrew(macosStartStep(engine, brew), () => {});
            if (result.code !== 0) return { success: false, error: lastLines(result.output, 3) };
        } else if (system === 'linux') {
            const family = installFamily(await detectEnvironment());
            const script = linuxStartScript(engine, family);
            const pkexec = await rootRunner();
            if (!script || !pkexec) return { success: false, error: 'Start the server with your system tools' };
            const result = await runScriptWithPkexec(script, pkexec, () => {});
            if (result.code !== 0) return { success: false, error: result.cancelled ? 'Cancelled' : lastLines(result.output, 3) };
        } else {
            const service = await windowsService(engine);
            if (!service) return { success: false, error: 'No server service found' };
            // Starting a service needs the administrator: Windows asks
            const result = await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath sc.exe -ArgumentList 'start','${service}' -Verb RunAs -Wait`], 120000);
            if (result.code !== 0) return { success: false, error: result.stderr.trim() || 'Not started' };
        }
        if (!(await waitForPort(LOCAL_ENGINE_PORT[engine], 30))) return { success: false, error: 'The server does not answer yet' };
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
}

/** An administrator account typed by the user: checked, then saved (encrypted) */
export async function saveLocalAccount(engine: LocalEngine, port: number, user: string, password: string): Promise<{ success: boolean; error?: string }> {
    if (!user || user.length > 128 || password.length > 1024) return { success: false, error: 'Invalid account' };
    try {
        if (engine === 'mongodb') {
            const access = await mongoAccess(port, { user, password });
            if (!access.ok) return { success: false, error: 'This account cannot list the databases of the server (wrong password, or not an administrator)' };
        } else {
            const conn = await mysqlLogin({ port, user, password });
            await conn.end();
        }
        saveAccount(engine, port, { user, password });
        logger.info(`Local ${engine} server: account ${user} saved`);
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
}

/** Homebrew's MariaDB: a "bbdump" account created through the system user's socket */
export async function createLocalAccount(engine: LocalEngine, port: number): Promise<{ success: boolean; error?: string }> {
    if (engine === 'mongodb') return { success: false, error: 'Not needed for MongoDB' };
    try {
        const socketPath = await socketAdmin();
        if (!socketPath) return { success: false, error: 'bbdump cannot reach the server as an administrator: type an account' };
        const password = randomBytes(24).toString('hex');
        const conn = await mysqlLogin({ socketPath, user: os.userInfo().username, password: '' });
        try {
            for (const host of ['localhost', '127.0.0.1']) {
                await conn.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [LOCAL_ACCOUNT, host, password]);
                await conn.query('ALTER USER ?@? IDENTIFIED BY ?', [LOCAL_ACCOUNT, host, password]);
                await conn.query('GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION', [LOCAL_ACCOUNT, host]);
            }
        } finally {
            await conn.end();
        }
        if (!(await canLogInMysql(port, LOCAL_ACCOUNT, password))) return { success: false, error: 'The account was created but cannot log in over TCP' };
        saveAccount(engine, port, { user: LOCAL_ACCOUNT, password });
        logger.info(`Local ${engine} server: account ${LOCAL_ACCOUNT} created`);
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
}

export function validLocalName(engine: LocalEngine, name: string): boolean {
    return engine === 'mongodb' ? /^[A-Za-z0-9_-]{1,63}$/.test(name) : /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(name);
}

/** Backup settings chosen in the add dialog */
export interface LocalDatabaseSettings {
    output?: string;
    cron?: string;
    enabled?: boolean;
    encryptBackups?: boolean;
    verifyBackups?: boolean;
    retentionCount?: number;
}

/** A new database on the local server, saved in bbdump */
export async function createLocalEngineDatabase(engine: LocalEngine, name: string, port = LOCAL_ENGINE_PORT[engine], displayName?: string, settings: LocalDatabaseSettings = {}): Promise<{ success: boolean; id?: string; error?: string }> {
    if (!validLocalName(engine, name)) return { success: false, error: 'A database name of letters, digits and _ is needed' };
    const state = await localServerState(engine, port);
    if (!state.running || !state.answering) return { success: false, error: 'The local server is not running' };
    const account = await workingAccount(engine, port);
    if (!account) return { success: false, error: 'bbdump has no account on the local server' };
    const actual = state.answering;
    const config = getConfig();
    const sameFamily = (e?: string) => (actual === 'mongodb' ? e === 'mongodb' : e === 'mysql' || e === 'mariadb');
    if (config.databases.some(d => sameFamily(d.engine) && d.name === name && LOCAL_HOSTS.includes(d.host) && d.port === port)) {
        return { success: false, error: `${name} is already saved in bbdump` };
    }
    try {
        if (actual === 'mongodb') {
            const { MongoClient } = await import('mongodb');
            const client = new MongoClient(mongoUrl(port, account), { serverSelectionTimeoutMS: 5000 });
            try {
                await client.connect();
                const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
                if (databases.some(d => d.name === name)) return { success: false, error: `A database named ${name} already exists on this server` };
            } finally {
                await client.close().catch(() => {});
            }
        } else {
            const conn = await mysqlLogin({ port, user: account.user, password: account.password });
            try {
                const [rows] = await conn.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
                if ((rows as unknown[]).length) return { success: false, error: `A database named ${name} already exists on this server` };
                await conn.query(`CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4`);
            } finally {
                await conn.end();
            }
        }
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
    const entry: DatabaseConfig = {
        id: randomUUID(),
        engine: actual,
        name,
        displayName: displayName?.trim() || name,
        host: '127.0.0.1',
        port,
        user: account.user,
        password: account.password ? encryptionManager.encrypt(account.password) : '',
        encrypted: !!account.password,
        cron: typeof settings.cron === 'string' && settings.cron.trim() ? settings.cron.trim() : '0 0 * * *',
        output: typeof settings.output === 'string' && settings.output.trim() ? settings.output.trim() : config.defaultBackupPath || pathManager.backupsPath,
        enabled: settings.enabled === true,
        encryptBackups: settings.encryptBackups === true,
        verifyBackups: settings.verifyBackups !== false,
        retentionCount: Number.isInteger(settings.retentionCount) && settings.retentionCount! > 0 ? settings.retentionCount : undefined,
        isLocalBbdump: true,
        ...(actual === 'mongodb' && account.user ? { mongo: { authSource: 'admin' } } : {}),
    };
    config.databases.push(entry);
    saveConfig(config);
    logger.info(`Local ${actual} database ${name} created on port ${port}`);
    return { success: true, id: entry.id };
}

/** Deleting a database bbdump created on a local MySQL / MariaDB / MongoDB server */
export async function dropLocalEngineDatabase(id: string): Promise<{ success: boolean; error?: string; gone?: boolean }> {
    const db = getConfig().databases.find(d => d.id === id);
    if (!db || !db.isLocalBbdump) return { success: false, error: 'Not a database bbdump created on this computer' };
    if (!LOCAL_HOSTS.includes(db.host) || db.ssh || db.connectionString) return { success: false, error: 'Not a database of this computer' };
    const password = db.encrypted && db.password ? encryptionManager.decrypt(db.password) : db.password || '';
    try {
        if (db.engine === 'mongodb') {
            const { MongoClient } = await import('mongodb');
            const client = new MongoClient(mongoUrl(db.port, db.user ? { user: db.user, password } : undefined), { serverSelectionTimeoutMS: 5000 });
            try {
                await client.connect();
                await client.db(db.name).dropDatabase();
            } finally {
                await client.close().catch(() => {});
            }
            return { success: true };
        }
        const conn = await mysqlLogin({ port: db.port, user: db.user, password });
        try {
            const [rows] = await conn.query('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db.name]);
            if (!(rows as unknown[]).length) return { success: true, gone: true };
            await conn.query(`DROP DATABASE ${quoteIdent(db.name, 'mysql')}`);
        } finally {
            await conn.end();
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: getErrorMessage(error) };
    }
}

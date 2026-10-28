/**
 * The MySQL / MariaDB command-line tools a backup and a restore use: a dump tool (mysqldump,
 * mariadb-dump) and a client (mysql, mariadb). The server's own flavour comes first; the other
 * one works too with a few options (see mysqlDumpArgs in engines/mysql.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultWhich, firstExisting, run, type WhichFn } from '../platform/probe';

export type MysqlToolKind = 'dump' | 'client';
export type MysqlFlavour = 'mysql' | 'mariadb';

const NAMES: Record<MysqlFlavour, Record<MysqlToolKind, string>> = {
    mysql: { dump: 'mysqldump', client: 'mysql' },
    mariadb: { dump: 'mariadb-dump', client: 'mariadb' },
};

/** Names to look for, the server's flavour first */
export function mysqlToolNames(kind: MysqlToolKind, flavour: MysqlFlavour): string[] {
    const other: MysqlFlavour = flavour === 'mysql' ? 'mariadb' : 'mysql';
    return [NAMES[flavour][kind], NAMES[other][kind]];
}

/**
 * Folders the PATH often misses: Homebrew's keg-only mysql-client (and versioned kegs), the
 * mysql / mariadb formulas; on Windows, the installers' Program Files folders (newest first).
 */
export function mysqlToolDirs(
    platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    fsApi: Pick<typeof fs, 'readdirSync'> = fs,
): string[] {
    if (platform === 'darwin') {
        const dirs: string[] = [];
        for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
            let kegs: string[] = [];
            try {
                kegs = fsApi.readdirSync(prefix).filter(name => /^(mysql-client|mysql|mariadb)(@[\d.]+)?$/.test(name)).sort().reverse();
            } catch { /* no Homebrew there */ }
            dirs.push(...kegs.map(keg => path.posix.join(prefix, keg, 'bin')));
        }
        return dirs;
    }
    if (platform === 'win32') {
        const programFiles = env.ProgramFiles || 'C:\\Program Files';
        const dirs: string[] = [];
        for (const vendor of ['MySQL', 'MariaDB']) {
            try {
                const root = vendor === 'MySQL' ? path.win32.join(programFiles, 'MySQL') : programFiles;
                const folders = fsApi.readdirSync(root)
                    .filter(name => vendor === 'MySQL' ? /^MySQL (Server|Shell|Workbench)/i.test(name) : /^MariaDB \d/i.test(name))
                    .sort().reverse();
                dirs.push(...folders.map(folder => path.win32.join(root, folder, 'bin')));
            } catch { /* not installed there */ }
        }
        return dirs;
    }
    return [];
}

export async function findMysqlTool(
    kind: MysqlToolKind,
    flavour: MysqlFlavour,
    which: WhichFn = defaultWhich,
    platform = process.platform,
): Promise<string | null> {
    const exe = platform === 'win32' ? '.exe' : '';
    const join = (platform === 'win32' ? path.win32 : path.posix).join;
    for (const name of mysqlToolNames(kind, flavour)) {
        const found = await which(name);
        if (found) return found;
        const extra = firstExisting(mysqlToolDirs(platform).map(dir => join(dir, `${name}${exe}`)));
        if (extra) return extra;
    }
    return null;
}

/** How to install them, by platform and flavour (shown with the error) */
export function mysqlToolsInstallHint(flavour: MysqlFlavour, platform = process.platform): string {
    if (platform === 'darwin') return flavour === 'mariadb' ? 'brew install mariadb' : 'brew install mysql-client';
    if (platform === 'win32') return flavour === 'mariadb' ? 'winget install MariaDB.Server' : 'winget install Oracle.MySQL';
    return flavour === 'mariadb'
        ? 'the "mariadb-client" package (apt install mariadb-client, dnf install mariadb)'
        : 'the "mysql-client" package (apt install default-mysql-client, dnf install mysql)';
}

/** The tool's path, or an error that says how to install it */
export async function requireMysqlTool(kind: MysqlToolKind, flavour: MysqlFlavour, which: WhichFn = defaultWhich, platform = process.platform): Promise<string> {
    const found = await findMysqlTool(kind, flavour, which, platform);
    if (found) return found;
    const [name] = mysqlToolNames(kind, flavour);
    throw new Error(`${name} was not found. Install the ${flavour === 'mariadb' ? 'MariaDB' : 'MySQL'} client tools: ${mysqlToolsInstallHint(flavour, platform)}`);
}

/** Which flavour a tool is (MariaDB's say so in --version) and its version */
export async function mysqlToolInfo(file: string): Promise<{ flavour: MysqlFlavour; version?: string }> {
    const result = await run(file, ['--version']);
    const text = result.stdout + result.stderr;
    return {
        flavour: /mariadb/i.test(text) ? 'mariadb' : 'mysql',
        version: text.match(/(?:Ver|Distrib|from)\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? text.match(/(\d+\.\d+\.\d+)/)?.[1],
    };
}

/**
 * mongodump / mongorestore (MongoDB Database Tools, installed apart from the server). One
 * version (100.x) works with every server from 4.2, so there is no version to match as for
 * pg_dump: the first one found is used.
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultWhich, firstExisting, run, type WhichFn } from '../platform/probe';

export type MongoTool = 'mongodump' | 'mongorestore';

const versionKey = (name: string) => name.split('.').map(part => part.padStart(6, '0')).join('.');

/** Windows: the MSI installs into Program Files\MongoDB\Tools\<version>\bin, newest first */
export function windowsToolCandidates(
    name: MongoTool,
    programFiles = process.env.ProgramFiles || 'C:\\Program Files',
    fsApi: Pick<typeof fs, 'readdirSync'> = fs,
): string[] {
    const root = path.win32.join(programFiles, 'MongoDB', 'Tools');
    let versions: string[] = [];
    try {
        versions = fsApi.readdirSync(root).filter(v => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
    } catch { /* not installed there */ }
    return versions.map(v => path.win32.join(root, v, 'bin', `${name}.exe`));
}

export async function findMongoTool(name: MongoTool, which: WhichFn = defaultWhich, platform = process.platform): Promise<string | null> {
    const found = await which(name);
    if (found) return found;
    return platform === 'win32' ? firstExisting(windowsToolCandidates(name)) : null;
}

/** How to install them, by platform (shown with the error) */
export function mongoToolsInstallHint(platform = process.platform): string {
    if (platform === 'darwin') return 'brew install mongodb/brew/mongodb-database-tools';
    if (platform === 'win32') return 'winget install MongoDB.DatabaseTools';
    return 'the "mongodb-database-tools" package from MongoDB\'s repository (https://www.mongodb.com/docs/database-tools/installation/)';
}

/** The tool's path, or an error that says how to install it */
export async function requireMongoTool(name: MongoTool, which: WhichFn = defaultWhich, platform = process.platform): Promise<string> {
    const found = await findMongoTool(name, which, platform);
    if (!found) throw new Error(`${name} was not found. Install the MongoDB Database Tools: ${mongoToolsInstallHint(platform)}`);
    return found;
}

/** "100.13.0" from "mongodump version: 100.13.0" */
export async function mongoToolVersion(file: string): Promise<string | undefined> {
    const result = await run(file, ['--version']);
    return (result.stdout + result.stderr).match(/version:\s*v?(\d+(?:\.\d+)*)/)?.[1];
}

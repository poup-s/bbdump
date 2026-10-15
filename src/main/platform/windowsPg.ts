/**
 * PostgreSQL client tools on Windows. The EDB installer (and winget, which runs it) puts them
 * in <Program Files>\PostgreSQL\<version>\bin and does not add that folder to PATH, so they
 * are looked for there, newest version first.
 */
import * as fs from 'fs';
import * as path from 'path';

type ReadDir = (dir: string) => string[];

/** The Program Files folders of this machine (64-bit first), without duplicates */
export function programFilesRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']
    .filter((r): r is string => !!r);
  const seen = new Set<string>();
  return roots.filter(r => {
    const key = r.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** <root>\PostgreSQL\<version>\bin folders, newest version first */
export function windowsPgBinDirs(
  env: NodeJS.ProcessEnv = process.env,
  readdir: ReadDir = dir => fs.readdirSync(dir),
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  const dirs: Array<{ dir: string; version: number }> = [];
  for (const root of programFilesRoots(env)) {
    const base = path.win32.join(root, 'PostgreSQL');
    let entries: string[] = [];
    try {
      entries = readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const bin = path.win32.join(base, entry, 'bin');
      if (exists(bin)) dirs.push({ dir: bin, version: parseFloat(entry) || 0 });
    }
  }
  return dirs.sort((a, b) => b.version - a.version).map(d => d.dir);
}

/**
 * PostgreSQL servers the EDB installer set up: <root>\PostgreSQL\<version>\data exists (the
 * client tools alone have no data folder), newest first.
 */
export function windowsPgServers(
  env: NodeJS.ProcessEnv = process.env,
  readdir: ReadDir = dir => fs.readdirSync(dir),
  exists: (p: string) => boolean = fs.existsSync,
): Array<{ major: string; dataDir: string }> {
  const servers: Array<{ major: string; dataDir: string; version: number }> = [];
  for (const root of programFilesRoots(env)) {
    const base = path.win32.join(root, 'PostgreSQL');
    let entries: string[] = [];
    try {
      entries = readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dataDir = path.win32.join(base, entry, 'data');
      const version = parseFloat(entry);
      if (version && exists(dataDir)) servers.push({ major: String(Math.trunc(version)), dataDir, version });
    }
  }
  return servers.sort((a, b) => b.version - a.version).map(({ major, dataDir }) => ({ major, dataDir }));
}

/** Every copy of a tool (e.g. "pg_dump") in those folders, newest version first */
export function windowsPgTool(
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
  readdir?: ReadDir,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  return toolInDirs(windowsPgBinDirs(env, readdir, exists), tool, exists);
}

/** Every copy of a tool in already scanned bin folders (scan once for several tools) */
export function toolInDirs(binDirs: string[], tool: string, exists: (p: string) => boolean = fs.existsSync): string[] {
  return binDirs.map(dir => path.win32.join(dir, `${tool}.exe`)).filter(file => exists(file));
}

/**
 * Puts the newest version's bin folder first in this process's PATH (the EDB installer does
 * not), at launch and right after installing the tools. No-op elsewhere or when already there.
 */
export function addNewestPgBinToPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') return null;
  const newest = windowsPgBinDirs(env)[0];
  const current = env.PATH || env.Path || '';
  if (!newest || current.toLowerCase().split(path.delimiter).includes(newest.toLowerCase())) return null;
  env.PATH = [newest, current].join(path.delimiter);
  return newest;
}

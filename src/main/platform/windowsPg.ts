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

/** Every copy of a tool (e.g. "pg_dump") in those folders, newest version first */
export function windowsPgTool(
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
  readdir?: ReadDir,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  return windowsPgBinDirs(env, readdir, exists)
    .map(dir => path.win32.join(dir, `${tool}.exe`))
    .filter(file => exists(file));
}

// Windows: PostgreSQL's tools are found in Program Files\PostgreSQL\<version>\bin, newest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { programFilesRoots, windowsPgBinDirs, windowsPgTool } = require(path.join(process.cwd(), 'dist/main/platform/windowsPg.js'));

// A fake disk: EDB installs 16 and 17 in Program Files, 15 in Program Files (x86)
const files = new Set([
  'C:\\Program Files\\PostgreSQL\\16\\bin', 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
  'C:\\Program Files\\PostgreSQL\\17\\bin', 'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe', 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
  'C:\\Program Files (x86)\\PostgreSQL\\15\\bin', 'C:\\Program Files (x86)\\PostgreSQL\\15\\bin\\pg_dump.exe',
]);
const dirs = { 'C:\\Program Files\\PostgreSQL': ['16', '17', 'data'], 'C:\\Program Files (x86)\\PostgreSQL': ['15'] };
const readdir = dir => { if (!dirs[dir]) throw new Error('ENOENT'); return dirs[dir]; };
const exists = p => files.has(p);
const env = { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };

test('Program Files folders, 64-bit first, without duplicates', () => {
  assert.deepEqual(programFilesRoots(env), ['C:\\Program Files', 'C:\\Program Files (x86)']);
  assert.deepEqual(programFilesRoots({}), ['C:\\Program Files']);
});

test('bin folders of every installed version, newest first', () => {
  assert.deepEqual(windowsPgBinDirs(env, readdir, exists), [
    'C:\\Program Files\\PostgreSQL\\17\\bin', 'C:\\Program Files\\PostgreSQL\\16\\bin', 'C:\\Program Files (x86)\\PostgreSQL\\15\\bin',
  ]);
});

test('a tool where it exists, newest first', () => {
  assert.deepEqual(windowsPgTool('pg_dump', env, readdir, exists), [
    'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe', 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe', 'C:\\Program Files (x86)\\PostgreSQL\\15\\bin\\pg_dump.exe',
  ]);
  assert.deepEqual(windowsPgTool('psql', env, readdir, exists), ['C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe']);
  assert.deepEqual(windowsPgTool('pg_dump', {}, () => { throw new Error('ENOENT'); }, exists), []);
});

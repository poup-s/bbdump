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

test('winget: the client tools only, without a shell window to answer', () => {
  const { wingetClientToolsArgs, WINGET_CLIENT_MAJORS } = require(path.join(process.cwd(), 'dist/main/platform/windows.js'));
  const args = wingetClientToolsArgs('18');
  assert.deepEqual(args.slice(0, 4), ['install', '-e', '--id', 'PostgreSQL.PostgreSQL.18']);
  assert.ok(args.includes('--disable-interactivity'));
  const override = args[args.indexOf('--override') + 1];
  assert.match(override, /--enable-components commandlinetools/);
  assert.match(override, /--disable-components server,pgAdmin,stackbuilder/);
  assert.deepEqual(WINGET_CLIENT_MAJORS, ['18', '17']);
});

test("winget's answers: installed, already there, no such version, prompt refused", () => {
  const { wingetOutcome } = require(path.join(process.cwd(), 'dist/main/platform/windows.js'));
  assert.equal(wingetOutcome(0, 'Successfully installed'), 'installed');
  assert.equal(wingetOutcome(-1978335135, 'Found an existing package already installed.'), 'installed');
  assert.equal(wingetOutcome(-1978335212, 'No package found matching input criteria.'), 'not-found');
  assert.equal(wingetOutcome(1223, 'Installer failed'), 'cancelled');
  assert.equal(wingetOutcome(1, 'Installer failed with exit code: 3'), 'failed');
});

test('a tool in folders scanned once', () => {
  const { toolInDirs } = require(path.join(process.cwd(), 'dist/main/platform/windowsPg.js'));
  const binDirs = windowsPgBinDirs(env, readdir, exists);
  assert.deepEqual(toolInDirs(binDirs, 'psql', exists), ['C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe']);
});

test('winget, an app execution alias that stat() cannot follow, is still found', () => {
  const { isWindowsExecutable } = require(path.join(process.cwd(), 'dist/main/platform/probe.js'));
  const fail = () => { throw Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }); };
  const stats = kind => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' });
  assert.equal(isWindowsExecutable('winget.exe', { statSync: fail, lstatSync: () => stats('link') }), true);
  assert.equal(isWindowsExecutable('pg_dump.exe', { statSync: () => stats('file'), lstatSync: fail }), true);
  assert.equal(isWindowsExecutable('bin', { statSync: () => stats('dir'), lstatSync: () => stats('dir') }), false);
  assert.equal(isWindowsExecutable('missing.exe', { statSync: fail, lstatSync: fail }), false);
});

test('Windows: the client tools and the server install with winget', () => {
  const { canRunInstall, planFor } = require(path.join(process.cwd(), 'dist/main/platform/install.js'));
  const windows = { os: 'windows', osLabel: 'Windows', supported: true, arch: 'x64', packageManager: { id: 'winget', path: 'winget.exe' } };
  for (const component of ['client-tools', 'server']) {
    const plan = planFor(component, windows, 'me');
    assert.equal(plan.automatic, true);
    assert.equal(canRunInstall(windows, plan), true);
  }
  const noWinget = { ...windows, packageManager: null };
  const manual = planFor('client-tools', noWinget, 'me');
  assert.equal(manual.automatic, false);
  assert.match(manual.command, /^winget install/);
  assert.equal(canRunInstall(noWinget, manual), false);
});

test('servers: a data folder, newest first (the client tools alone have none)', () => {
  const { windowsPgServers } = require(path.join(process.cwd(), 'dist/main/platform/windowsPg.js'));
  const withData = p => files.has(p) || p === 'C:\\Program Files\\PostgreSQL\\16\\data' || p === 'C:\\Program Files (x86)\\PostgreSQL\\15\\data';
  assert.deepEqual(windowsPgServers(env, readdir, withData), [
    { major: '16', dataDir: 'C:\\Program Files\\PostgreSQL\\16\\data' },
    { major: '15', dataDir: 'C:\\Program Files (x86)\\PostgreSQL\\15\\data' },
  ]);
  assert.deepEqual(windowsPgServers(env, readdir, exists), []);
});

test('server install: the password only in an option file, the service named by EDB', () => {
  const windows = require(path.join(process.cwd(), 'dist/main/platform/windows.js'));
  const file = windows.serverOptionFile('s3cret-Pw_', 5432);
  assert.match(file, /^mode=unattended\r\n/);
  assert.match(file, /\r\nsuperpassword=s3cret-Pw_\r\n/);
  assert.match(file, /\r\nenable-components=server,commandlinetools\r\n/);
  assert.match(file, /\r\ndisable-components=pgAdmin,stackbuilder\r\n/);
  const args = windows.wingetServerArgs('18', 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\bbdump-pg-1\\postgresql.opt');
  assert.deepEqual(args.slice(0, 5), ['install', '-e', '--id', 'PostgreSQL.PostgreSQL.18', '--force']);
  assert.equal(args.at(-1), '--optionfile "C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\bbdump-pg-1\\postgresql.opt"');
  assert.ok(!args.join(' ').includes('s3cret'));
  assert.equal(windows.windowsServiceName('18'), 'postgresql-x64-18');
});

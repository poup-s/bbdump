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

test('extensions on Windows: the newest PostGIS bundle, its md5, the TimescaleDB zip and sha256', () => {
  const ext = require(path.join(process.cwd(), 'dist/main/platform/windowsExtensions.js'));
  const listing = '<a href="postgis-bundle-pg18-3.6.2x64.zip">x</a><a href="postgis-bundle-pg18-3.6.2x64.zip.md5">x</a><a href="postgis-bundle-pg18-3.10.0x64.zip">x</a><a href="postgis-bundle-pg18x64-setup-3.6.2-1.exe">x</a>';
  assert.equal(ext.newestPostgisBundle(listing, 18), 'postgis-bundle-pg18-3.10.0x64.zip');
  assert.equal(ext.newestPostgisBundle(listing, 17), null);
  assert.equal(ext.parseMd5File('9E28723541938D1B1A8EFB59A5922741 *postgis-bundle-pg18-3.6.2x64.zip\n'), '9e28723541938d1b1a8efb59a5922741');
  assert.equal(ext.parseMd5File('<html>'), null);
  const digest = 'a'.repeat(64);
  const release = { assets: [
    { name: 'timescaledb-postgresql-17-windows-amd64.zip', browser_download_url: 'https://x/17.zip', digest: `sha256:${'b'.repeat(64)}` },
    { name: 'timescaledb-postgresql-18-windows-amd64.zip', browser_download_url: 'https://x/18.zip', digest: `sha256:${digest}` },
  ] };
  assert.deepEqual(ext.timescaleAsset(release, 18), { url: 'https://x/18.zip', file: 'timescaledb-postgresql-18-windows-amd64.zip', algorithm: 'sha256', digest });
  assert.equal(ext.timescaleAsset(release, 16), null);
  assert.equal(ext.timescaleAsset({ assets: [{ ...release.assets[1], digest: '' }] }, 18), null);
});

test('extensions on Windows: only an EDB server folder, quoted in the copy script', () => {
  const ext = require(path.join(process.cwd(), 'dist/main/platform/windowsExtensions.js'));
  assert.equal(ext.pgRootFromSharedir('C:/Program Files/PostgreSQL/18/share'), 'C:\\Program Files\\PostgreSQL\\18');
  assert.equal(ext.pgRootFromSharedir('/usr/share/postgresql/18'), null);
  assert.equal(ext.psQuote("C:\\Users\\O'Neil"), "'C:\\Users\\O''Neil'");
  const postgis = ext.copyScript('postgis', "C:\\T\\O'N\\files", 'C:\\Program Files\\PostgreSQL\\18', 'C:\\T\\done.txt');
  assert.match(postgis, /\$src = 'C:\\T\\O''N\\files'/);
  assert.match(postgis, /-not \(Test-Path/);
  assert.match(postgis, /Set-Content -Path 'C:\\T\\done\.txt' -Value 'ok'/);
  const tsdb = ext.copyScript('timescaledb', 'C:\\T\\files', 'C:\\Program Files\\PostgreSQL\\18', 'C:\\T\\done.txt');
  assert.match(tsdb, /\*\.dll'\) \(Join-Path \$dst 'lib'\)/);
  assert.match(tsdb, /share\\extension/);
});

test('extension catalog: Windows builds for PostGIS and TimescaleDB, none for pgvector', () => {
  const cat = require(path.join(process.cwd(), 'dist/main/extensionCatalog.js'));
  assert.equal(cat.extensionPackage(cat.catalogEntry('postgis'), 'windows', 18), 'PostGIS bundle (OSGeo)');
  assert.equal(cat.extensionPackage(cat.catalogEntry('pgrouting'), 'windows', 18), 'PostGIS bundle (OSGeo)');
  assert.equal(cat.extensionPackage(cat.catalogEntry('timescaledb'), 'windows', 18), 'TimescaleDB (Windows build)');
  assert.equal(cat.extensionPackage(cat.catalogEntry('vector'), 'windows', 18), null);
  assert.equal(cat.packageInstallCommand(cat.catalogEntry('postgis'), 'windows', 18), null);
  const missing = cat.missingExtensions(['postgis', 'vector'], [], { packageManager: 'windows', major: 18, autoInstall: true });
  assert.deepEqual(missing.map(m => [m.name, m.installable]), [['postgis', true], ['vector', false]]);
});

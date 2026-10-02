// Backup folders: listing, default folder and the path check behind delete / download.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-locations-'));
let locations;

before(() => {
  process.chdir(tmp); // the Electron stub puts userData (and logs) in the cwd
  require('./electronStub.cjs');
  locations = require(path.join(cwd, 'dist/main/backupLocations.js'));
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('backup folders', () => {
  const internal = '/data/bbdump/backups';
  const appData = '/data/bbdump';

  test('internal, default and per-database folders, without duplicates', () => {
    const dirs = locations.collectBackupDirectories({
      defaultBackupPath: '/home/alice/Documents/bbdump',
      databases: [
        { output: '/home/alice/Documents/bbdump' },
        { output: '/srv/dumps/shop.backup' },
        { output: 'custom' },
        { output: '/home/alice/.config/bbdump/backups' },
        { output: '' },
        {},
      ],
    }, internal, appData, '/unused');
    assert.deepEqual(dirs, [
      internal,
      '/home/alice/Documents/bbdump',
      '/srv/dumps',
      '/data/bbdump/custom',
      '/home/alice/.config/bbdump/backups',
    ]);
  });

  test('the platform default is used when no folder was chosen', () => {
    const dirs = locations.collectBackupDirectories({ databases: [] }, internal, appData, '/home/alice/Documents/bbdump');
    assert.deepEqual(dirs, [internal, '/home/alice/Documents/bbdump']);
  });

  test('a reference resolves only directly inside a backup folder', () => {
    const dirs = [internal, '/home/alice/Documents/bbdump'];
    const resolve = (ref) => locations.resolveBackupReference(ref, dirs, internal);
    assert.equal(resolve('/home/alice/Documents/bbdump/db_2026.backup'), '/home/alice/Documents/bbdump/db_2026.backup');
    assert.equal(resolve('db_2026.backup'), `${internal}/db_2026.backup`, 'bare names stay in the internal folder');
    assert.equal(resolve('../config.json'), null);
    assert.equal(resolve('../../etc/x.backup'), null);
    assert.equal(resolve('/home/alice/Documents/bbdump/../secret.backup'), null);
    assert.equal(resolve('/home/alice/Documents/bbdump/sub/db.backup'), null, 'no nested folders');
    assert.equal(resolve('/home/alice/Documents/bbdump/notes.txt'), null, 'only .backup files');
    assert.equal(resolve('/etc/passwd'), null);
    assert.equal(resolve('a\0.backup'), null);
    assert.equal(resolve(''), null);
  });

  test('the default folder: the user choice, else the platform one', () => {
    assert.equal(locations.defaultBackupDir({ defaultBackupPath: ' /mnt/nas/bbdump ' }), '/mnt/nas/bbdump');
    const fallback = locations.defaultBackupDir({});
    if (process.platform === 'linux') assert.equal(path.basename(fallback), 'bbdump');
    else assert.equal(fallback, path.join(process.cwd(), 'backups')); // cwd: tmp, symlinks resolved
  });

  test('lists .backup files of every folder, skipping missing ones', () => {
    const extra = fs.mkdtempSync(path.join(tmp, 'extra-'));
    fs.writeFileSync(path.join(extra, 'a_1.backup'), 'x');
    fs.writeFileSync(path.join(extra, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(extra, 'dir.backup'));
    const files = locations.listBackupFiles({ defaultBackupPath: extra, databases: [{ output: '/does/not/exist' }] });
    assert.deepEqual(files, [path.join(extra, 'a_1.backup')]);
  });
});

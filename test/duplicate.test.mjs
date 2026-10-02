// Copies made by "duplicate" up to 1.1 inherited their source's last backup date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { clearInheritedLastBackups } = require(path.join(process.cwd(), 'dist/main/inheritedBackupDate.js'));

const DATE = '2026-10-01T15:34:24.364Z';

test('the copy loses the date, the source with backup files keeps it', () => {
  const dbs = [
    { id: 'src-id', name: 'shop', lastBackup: DATE },
    { id: 'copy-id', name: 'shop_copy', lastBackup: DATE },
  ];
  const fixed = clearInheritedLastBackups(dbs, ['src-id_2026-10-01T15-34-24-538Z.backup']);
  assert.deepEqual(fixed, ['shop_copy']);
  assert.equal(dbs[0].lastBackup, DATE);
  assert.equal(dbs[1].lastBackup, undefined);
});

test('the source is recognized even listed after its copy', () => {
  const dbs = [
    { id: 'copy-id', name: 'shop_copy', lastBackup: DATE },
    { id: 'src-id', name: 'shop', lastBackup: DATE },
  ];
  clearInheritedLastBackups(dbs, ['src-id_2026-10-01T15-34-24-538Z.backup']);
  assert.equal(dbs[0].lastBackup, undefined);
  assert.equal(dbs[1].lastBackup, DATE);
});

test('files named after the database (older versions) count, without matching a longer name', () => {
  const dbs = [
    { id: 'a', name: 'shop', lastBackup: DATE },
    { id: 'b', name: 'shop_copy', lastBackup: DATE },
  ];
  // "shop_copy_…" must not make "shop" an owner, nor "shop_…" make "shop_copy" one
  clearInheritedLastBackups(dbs, ['shop_copy_2026-09-01T00-00-00-000Z.backup']);
  assert.equal(dbs[0].lastBackup, undefined);
  assert.equal(dbs[1].lastBackup, DATE);
});

test('no backup file left: the first one keeps the date, the copies lose it', () => {
  const dbs = [
    { id: 'src', name: 'neondb', lastBackup: DATE },
    { id: 'c1', name: 'neondb_copy', lastBackup: DATE },
    { id: 'c2', name: 'neondb_copy2', lastBackup: DATE },
  ];
  assert.deepEqual(clearInheritedLastBackups(dbs, []), ['neondb_copy', 'neondb_copy2']);
  assert.equal(dbs[0].lastBackup, DATE);
});

test('different dates and missing dates are left alone', () => {
  const dbs = [
    { id: 'a', name: 'a', lastBackup: '2026-10-01T10:00:00.000Z' },
    { id: 'b', name: 'b', lastBackup: '2026-10-01T11:00:00.000Z' },
    { id: 'c', name: 'c' },
  ];
  assert.deepEqual(clearInheritedLastBackups(dbs, []), []);
  assert.equal(dbs[0].lastBackup, '2026-10-01T10:00:00.000Z');
  assert.equal(dbs[1].lastBackup, '2026-10-01T11:00:00.000Z');
});

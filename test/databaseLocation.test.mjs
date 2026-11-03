// Where the list says a database lives: a file of this computer, its local server, SSH, or elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/databaseLocation.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports, require);
const { databaseLocation, isOnThisComputer } = mod.exports;

test('files, local server, SSH and remote databases', () => {
  assert.equal(databaseLocation({ engine: 'sqlite', sqlite: { path: '/x/notes.sqlite' } }), 'file');
  assert.equal(databaseLocation({ engine: 'duckdb', duckdb: { path: '/x/a.duckdb' } }), 'file');
  assert.equal(databaseLocation({ isLocalBbdump: true }), 'local');
  assert.equal(databaseLocation({ engine: 'mysql', isLocalBbdump: true }), 'local');
  assert.equal(databaseLocation({ engine: 'mysql', ssh: { host: 'vps' } }), 'ssh');
  assert.equal(databaseLocation({ engine: 'mongodb' }), 'remote');
  assert.equal(databaseLocation({}), 'remote', 'a 1.0.2 entry without engine: PostgreSQL elsewhere');
});

test('the home page counts files as local', () => {
  assert.equal(isOnThisComputer({ engine: 'duckdb', duckdb: { path: '/x/a.duckdb' } }), true);
  assert.equal(isOnThisComputer({ isLocalBbdump: true }), true);
  assert.equal(isOnThisComputer({ engine: 'sqlserver' }), false);
  assert.equal(isOnThisComputer({ ssh: { host: 'vps' } }), false);
});

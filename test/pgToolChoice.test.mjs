// Which pg_dump backs up a server: the same major, else the closest newer one; never an older one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { pickPgDumpForServer, newestPgTool, pgDumpInstallHint } = require(path.join(process.cwd(), 'dist/main/pgToolChoice.js'));

const tool = (version, source = 'postgresql') => ({ path: `/pg${version}/bin/pg_dump`, version, majorVersion: version.split('.')[0], source });

test('server 16.9 with pg_dump 17.4, 18.6, 17.8, 18.3 installed: a pg_dump 17 is used, no error', () => {
  const installed = [tool('17.4'), tool('18.6'), tool('17.8', 'system'), tool('18.3'), tool('17.8')];
  const choice = pickPgDumpForServer(installed, '16');
  assert.ok(choice);
  assert.equal(choice.exact, false);
  assert.equal(choice.tool.majorVersion, '17');
  assert.equal(choice.tool.source, 'postgresql');
});

test('same major: that one, the PostgreSQL install before the system one', () => {
  const choice = pickPgDumpForServer([tool('17.10', 'system'), tool('18.4'), tool('17.10')], '17');
  assert.equal(choice.exact, true);
  assert.equal(choice.tool.source, 'postgresql');
});

test('much older server: still the closest newer pg_dump', () => {
  assert.equal(pickPgDumpForServer([tool('18.4'), tool('17.10')], '12').tool.majorVersion, '17');
});

test('newer server than every pg_dump: nothing to use, and the hint names the version', () => {
  assert.equal(pickPgDumpForServer([tool('16.4'), tool('17.10')], '18'), null);
  assert.match(pgDumpInstallHint('darwin', '18'), /brew install postgresql@18/);
  assert.match(pgDumpInstallHint('linux', '18'), /postgresql-client-18/);
});

test('server version unknown: the newest pg_dump', () => {
  assert.equal(newestPgTool([tool('16.4'), tool('18.1'), tool('18.4', 'system'), tool('17.10')]).version, '18.4');
  assert.equal(newestPgTool([]), null);
});

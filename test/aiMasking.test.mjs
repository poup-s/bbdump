// Personal data masked for AI clients: the app's settings file and what the MCP server does with it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-aimask-'));
let app;
let mcp;

before(async () => {
  process.chdir(tmp); // the Electron stub puts userData in the cwd
  require('./electronStub.cjs');
  app = require(path.join(cwd, 'dist/main/aiMasking.js'));
  mcp = await import(pathToFileURL(path.join(cwd, 'mcp-postgres/build/masking.js')).href);
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('settings saved by the app', () => {
  test('off by default, saved per database, kept tidy', () => {
    assert.deepEqual(app.getAiMasking('db1'), { enabled: false, columns: [], updatedAt: undefined });
    app.setAiMasking('db1', {
      enabled: true,
      columns: [
        { table: 'public.users', column: 'email', kind: 'secret' },
        { table: 'public.users', column: 'email', kind: 'email' },
        { table: 'users', column: 'x', kind: 'secret' },
        { table: 'public.users', column: 'phone', kind: 'nope' },
      ],
    });
    const saved = app.getAiMasking('db1');
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.columns, [{ table: 'public.users', column: 'email', kind: 'secret' }]);
    assert.deepEqual(app.aiMaskedDatabaseIds(), ['db1']);
    app.forgetAiMasking('db1');
    assert.deepEqual(app.aiMaskedDatabaseIds(), []);
  });
});

describe('MCP server', () => {
  const file = { databases: { a: { enabled: true, columns: [{ table: 'public.users', column: 'email', kind: 'email' }] }, b: { enabled: false, columns: [{ table: 'public.users', column: 'name', kind: 'name' }] } } };

  test('rules only for databases with masking on', () => {
    assert.equal(mcp.rulesFromFile(file, ['b']), null);
    assert.equal(mcp.rulesFromFile(null, ['a']), null);
    assert.deepEqual([...mcp.rulesFromFile(file, ['a', 'b'])], [['public.users.email', 'email']]);
  });

  test('fakes are stable, NULL stays NULL, "null" empties', () => {
    assert.equal(mcp.fakeValue('alice@real.com', 'email'), mcp.fakeValue('alice@real.com', 'email'));
    assert.match(mcp.fakeValue('alice@real.com', 'email'), /^user_[0-9a-f]{12}@example\.com$/);
    assert.match(mcp.fakeValue('Alice', 'secret'), /^XXXX[0-9A-F]{8}$/);
    assert.match(mcp.fakeValue('+33612345678', 'phone'), /^\+000\d{9}$/);
    assert.equal(mcp.fakeValue(null, 'email'), null);
    assert.equal(mcp.fakeValue('kept?', 'null'), null);
  });

  test('partial: the shape is kept, part of the value starred', () => {
    assert.equal(mcp.fakeValue('bob1234@email.fr', 'partial'), '****234@email.fr');
    assert.equal(mcp.fakeValue('sebastien poupi', 'partial'), '*****tien poupi');
    assert.equal(mcp.fakeValue('bob@x.fr', 'partial'), '**b@x.fr');
    assert.equal(mcp.fakeValue('+33 6 12 34 56 78', 'partial'), '+** * ** ** ** 78');
    assert.equal(mcp.fakeValue('a', 'partial'), '*');
    assert.equal(mcp.fakeValue(null, 'partial'), null);
  });

  test('only the chosen columns of each row change', () => {
    const rows = [{ id: 1, email: 'alice@real.com', city: 'Paris' }];
    const masked = mcp.maskRows(rows, new Map([['email', 'secret']]));
    assert.equal(masked[0].city, 'Paris');
    assert.equal(masked[0].id, 1);
    assert.notEqual(masked[0].email, 'alice@real.com');
    assert.equal(rows[0].email, 'alice@real.com');
  });
});

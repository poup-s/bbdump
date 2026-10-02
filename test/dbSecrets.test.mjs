// Credentials used by "Test connection" in the database dialogs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-secrets-'));
let secrets;

before(() => {
  process.chdir(tmp); // the Electron stub puts userData (key, logs) in the cwd
  require('./electronStub.cjs');
  secrets = require(path.join(cwd, 'dist/main/dbSecrets.js'));
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('connection test credentials', () => {
  const saved = () => 'saved-secret';

  test('a typed password wins and the saved one is not read', () => {
    let read = false;
    const result = secrets.credentialsForConnectionTest({ password: 'typed' }, () => { read = true; return 'saved-secret'; });
    assert.deepEqual(result, { password: 'typed', connectionString: undefined });
    assert.equal(read, false, 'no decryption when it is not needed');
  });

  test('a password typed in the URL wins too', () => {
    const result = secrets.credentialsForConnectionTest({ connectionString: 'postgresql://app:fromurl@db.example.com/app' }, saved);
    assert.equal(result.password, '');
    assert.equal(result.connectionString, 'postgresql://app:fromurl@db.example.com/app');
  });

  test('editing with nothing typed uses the saved password', () => {
    assert.deepEqual(secrets.credentialsForConnectionTest({ password: '' }, saved), { password: 'saved-secret', connectionString: undefined });
  });

  test('editing a URL without password puts the saved one into it', () => {
    const result = secrets.credentialsForConnectionTest({ connectionString: 'postgresql://app@db.example.com:5432/app?sslmode=require' }, saved);
    assert.equal(result.password, 'saved-secret');
    assert.match(result.connectionString, /^postgresql:\/\/app:saved-secret@db\.example\.com:5432\/app\?sslmode=require$/);
  });

  test('adding a database (nothing saved) keeps an empty password', () => {
    assert.deepEqual(secrets.credentialsForConnectionTest({ password: '', connectionString: 'postgresql://app@localhost/app' }, null),
      { password: '', connectionString: 'postgresql://app@localhost/app' });
  });
});

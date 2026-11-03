// Connection errors in the explorer: a sentence by kind, the driver's message without Electron's prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/connectionError.ts'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports, require);
const { readableConnectionError } = mod.exports;

test('the prefix goes, the kind is found', () => {
  assert.deepEqual(
    readableConnectionError("Error invoking remote method 'get-db-full-schema': Error: connect ECONNREFUSED 127.0.0.1:3399"),
    { kind: 'refused', detail: 'connect ECONNREFUSED 127.0.0.1:3399' },
  );
  const cases = {
    'getaddrinfo ENOTFOUND db.example.com': 'notFound',
    'Connection terminated due to connection timeout': 'timeout',
    'password authentication failed for user "app"': 'auth',
    "Access denied for user 'app'@'10.0.0.2' (using password: YES)": 'auth',
    "Login failed for user 'sa'.": 'auth',
    'self-signed certificate in certificate chain': 'tls',
    'database "shop" does not exist': 'missingDatabase',
    'something else': 'other',
  };
  for (const [raw, kind] of Object.entries(cases)) assert.equal(readableConnectionError(raw).kind, kind, raw);
});

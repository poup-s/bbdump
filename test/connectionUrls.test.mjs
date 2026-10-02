// Connection URLs: reading them in the forms, and passing them to pg_dump / pg_restore / psql.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();

// The renderer parser is TypeScript compiled by Vite: transform it on the fly
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(root, 'src/renderer/src/pgUrl.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const pgUrlModule = { exports: {} };
new Function('module', 'exports', 'require', compiled)(pgUrlModule, pgUrlModule.exports, require);
const { parsePgUrl } = pgUrlModule.exports;

const { connectionStringForPgTools } = require(path.join(root, 'dist/main/pgConnectionString.js'));

describe('reading a connection URL', () => {
  test('a Prisma URL with many parameters', () => {
    const parsed = parsePgUrl('postgresql://app:s3cret@db.example.com:6543/shop?schema=public&connection_limit=1&pgbouncer=true&pool_timeout=10&sslmode=require');
    assert.deepEqual(parsed, {
      user: 'app', password: 's3cret', host: 'db.example.com', port: 6543, database: 'shop',
      sslMode: 'require', sslRootCert: undefined,
    });
  });

  test('passwords with unencoded @ : / and a stray %', () => {
    assert.equal(parsePgUrl('postgres://app:p@ss:w/rd@db.local/shop').password, 'p@ss:w/rd');
    assert.equal(parsePgUrl('postgres://app:100%sure@db.local/shop').password, '100%sure');
    assert.equal(parsePgUrl('postgres://app:p%40ss%3Aw%2Frd@db.local/shop').password, 'p@ss:w/rd');
  });

  test('defaults, IPv6 and odd but valid forms', () => {
    assert.deepEqual(
      [parsePgUrl('postgres://db.local/shop').port, parsePgUrl('postgres://db.local/shop').user],
      [5432, undefined],
    );
    assert.equal(parsePgUrl('postgresql://app@[::1]:5433/shop').host, '::1');
    assert.equal(parsePgUrl('postgresql://app@[::1]:5433/shop').port, 5433);
    assert.equal(parsePgUrl('  POSTGRESQL://app@db.local/shop  ').database, 'shop');
    assert.equal(parsePgUrl('postgresql://app@db.local/my%20db').database, 'my db');
    assert.equal(parsePgUrl('postgresql://app@db.local?sslmode=require').database, undefined);
    assert.equal(parsePgUrl('postgresql://app@db.local/shop?sslmode=verify-full&sslrootcert=/certs/ca.pem').sslRootCert, '/certs/ca.pem');
    assert.equal(parsePgUrl('postgresql://app@db.local/shop?sslmode=bogus').sslMode, undefined);
  });

  test('refuses what cannot be used, without throwing', () => {
    for (const bad of ['', 'mysql://db/shop', 'postgresql://', 'postgresql://app@/shop', 'postgresql://h1:5432,h2:5432/shop',
      'postgresql://db.local:99999/shop', 'postgresql://db.local:abc/shop', 'postgresql://[::1/shop', 'not a url at all']) {
      assert.equal(parsePgUrl(bad), null, bad);
    }
  });
});

describe('URL given to the PostgreSQL tools', () => {
  test('drops parameters libpq refuses, keeps the ones it knows, in order', () => {
    const result = connectionStringForPgTools(
      'postgresql://app:s3cret@db.example.com:6543/shop?schema=public&sslmode=require&pgbouncer=true&application_name=bbdump&connection_limit=1&channel_binding=require',
    );
    assert.equal(result.connectionString, 'postgresql://app:s3cret@db.example.com:6543/shop?sslmode=require&application_name=bbdump');
    assert.deepEqual(result.removed, ['schema', 'pgbouncer', 'connection_limit', 'channel_binding']);
  });

  test('keeps the rest of the URL byte for byte', () => {
    const url = 'postgresql://app:p%40ss@db.example.com/my%20db?options=-c%20search_path%3Dapp';
    assert.deepEqual(connectionStringForPgTools(url), { connectionString: url, removed: [] });
  });

  test('a URL left without parameters loses its "?"', () => {
    assert.equal(connectionStringForPgTools('postgresql://app@db/shop?schema=public').connectionString, 'postgresql://app@db/shop');
  });

  test('non-URL strings and malformed escapes are left alone', () => {
    assert.equal(connectionStringForPgTools('host=db dbname=shop').connectionString, 'host=db dbname=shop');
    assert.equal(connectionStringForPgTools('postgresql://db/shop?%zz=1&sslmode=disable').connectionString, 'postgresql://db/shop?sslmode=disable');
  });
});

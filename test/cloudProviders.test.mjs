// Cloud hosts in the add dialog: recognizing them from the URL, and pooled URLs pg_dump cannot use.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();

const { transformSync } = require('esbuild');
const load = (file) => {
  const compiled = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
  return mod.exports;
};
const { detectProvider, poolerAdvice, urlSetsSsl, hasPasswordPlaceholder } = load('src/renderer/src/cloudProviders.ts');
const { parsePgUrl } = load('src/renderer/src/pgUrl.ts');

const advice = (url) => {
  const p = parsePgUrl(url);
  return poolerAdvice(url, p.host, p.port);
};

describe('recognizing the host', () => {
  const cases = {
    'aws-0-eu-west-3.pooler.supabase.com': 'supabase',
    'db.abcdefgh.supabase.co': 'supabase',
    'ep-cool-darkness-123456.eu-central-1.aws.neon.tech': 'neon',
    'ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech': 'neon',
    'monorail.proxy.rlwy.net': 'railway',
    'dpg-abc123-a.oregon-postgres.render.com': 'render',
    'mydb.c9akciq32.eu-west-1.rds.amazonaws.com': 'rds',
    'abc-123.rdb.fr-par.scw.cloud': 'scaleway',
  };
  for (const [host, id] of Object.entries(cases)) {
    test(`${host} → ${id}`, () => assert.equal(detectProvider(host)?.id, id));
  }
  test('look-alike and local hosts are not recognized', () => {
    for (const host of ['localhost', '127.0.0.1', 'db.example.com', 'neon.tech.evil.com', 'notsupabase.com', 'render.company.io']) {
      assert.equal(detectProvider(host), null, host);
    }
  });
});

describe('pooled URLs', () => {
  test('Supabase transaction pooler 6543 → session pooler 5432, the rest untouched', () => {
    const url = 'postgresql://postgres.abcd:p%40ss@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true';
    assert.deepEqual(advice(url), {
      provider: 'supabase',
      fixedUrl: 'postgresql://postgres.abcd:p%40ss@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?pgbouncer=true',
    });
  });
  test('Supabase session pooler and direct host are fine', () => {
    assert.equal(advice('postgresql://postgres.abcd:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres'), null);
    assert.equal(advice('postgresql://postgres:pw@db.abcd.supabase.co:5432/postgres'), null);
  });
  test('Neon -pooler host → direct endpoint', () => {
    const url = 'postgresql://neondb_owner:npg_x@ep-cool-darkness-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    assert.deepEqual(advice(url), {
      provider: 'neon',
      fixedUrl: 'postgresql://neondb_owner:npg_x@ep-cool-darkness-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    });
  });
  test('a password containing "-pooler." is left alone', () => {
    const url = 'postgresql://u:a-pooler.b@ep-x-1-pooler.eu-central-1.aws.neon.tech/neondb';
    assert.equal(advice(url).fixedUrl, 'postgresql://u:a-pooler.b@ep-x-1.eu-central-1.aws.neon.tech/neondb');
  });
  test('Neon direct endpoint and other hosts are fine', () => {
    assert.equal(advice('postgresql://u:p@ep-x-1.eu-central-1.aws.neon.tech/neondb'), null);
    assert.equal(advice('postgresql://u:p@db.example.com:6543/app'), null);
  });
});

test('SSL set in the URL', () => {
  assert.equal(urlSetsSsl('postgresql://u:p@h/db?sslmode=require'), true);
  assert.equal(urlSetsSsl('postgresql://u:p@h/db?a=1&ssl=true'), true);
  assert.equal(urlSetsSsl('postgresql://u:p@h/db'), false);
});

test('password placeholders copied from a dashboard', () => {
  assert.equal(hasPasswordPlaceholder('postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-west-3.pooler.supabase.com:5432/postgres'), true);
  assert.equal(hasPasswordPlaceholder('postgresql://[user]:[password]@ep-x.neon.tech/neondb'), true);
  assert.equal(hasPasswordPlaceholder('postgresql://u:s3cret@h/db'), false);
});

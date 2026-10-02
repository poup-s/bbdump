// MCP server helpers that need no database: write detection, URL parsing, INSERT building, formats.
// Needs mcp-postgres/build (npm run build:mcp); skipped otherwise.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const build = path.join(process.cwd(), 'mcp-postgres', 'build');
const built = fs.existsSync(path.join(build, 'sql.js'));
const load = (file) => import(pathToFileURL(path.join(build, file)).href);

describe('MCP server', { skip: built ? false : 'mcp-postgres is not built (npm run build:mcp)' }, () => {
  test('read-only check: first keyword, data-modifying CTEs, EXPLAIN targets; strings and names are ignored', async () => {
    const { findWriteKeyword } = await load('sql.js');
    assert.equal(findWriteKeyword("SELECT * FROM orders WHERE comment = 'DELETE me; DROP TABLE x'"), null);
    assert.equal(findWriteKeyword('SELECT comment, "update", lock FROM posts'), null);
    assert.equal(findWriteKeyword('-- DROP TABLE x\nSELECT 1'), null);
    assert.equal(findWriteKeyword('SELECT $tag$ DELETE $tag$'), null);
    assert.equal(findWriteKeyword('WITH t AS (SELECT 1) SELECT * FROM t'), null);
    assert.equal(findWriteKeyword('EXPLAIN (ANALYZE, BUFFERS) SELECT 1'), null);
    assert.equal(findWriteKeyword('  (SELECT 1) UNION (SELECT 2)'), null);
    assert.equal(findWriteKeyword('DELETE FROM orders'), 'DELETE');
    assert.equal(findWriteKeyword('with d as (delete from orders returning id) select count(*) from d'), 'DELETE');
    assert.equal(findWriteKeyword('EXPLAIN ANALYZE UPDATE orders SET total = 0'), 'UPDATE');
    assert.equal(findWriteKeyword('VACUUM orders'), 'VACUUM');
    assert.equal(findWriteKeyword('CALL do_things()'), 'CALL');
  });

  test('statement count and server-side row limit', async () => {
    const { statementCount, isRowQuery, limitedQuery } = await load('sql.js');
    assert.equal(statementCount('SELECT 1;'), 1);
    assert.equal(statementCount("SELECT ';'; COMMIT; DROP TABLE x"), 3);
    assert.equal(isRowQuery('SHOW server_version'), false);
    assert.equal(isRowQuery('  with x as (select 1) select * from x'), true);
    assert.equal(limitedQuery('SELECT * FROM t;  ', 11), 'SELECT * FROM (\nSELECT * FROM t\n) AS bbdump_result LIMIT 11');
  });

  test('CSV and markdown output', async () => {
    const { toCsv, toMarkdown } = await load('sql.js');
    const rows = [{ a: 'x,y', b: null }, { a: 'say "hi"', b: { k: 1 } }];
    assert.equal(toCsv(['a', 'b'], rows), 'a,b\n"x,y",\n"say ""hi""","{""k"":1}"');
    assert.equal(toMarkdown(['a'], [{ a: 'p|q\nr' }]), '| a |\n| --- |\n| p\\|q r |');
  });

  test('connection URLs: special characters in passwords, IPv6, Prisma schema', async () => {
    const { parseConnectionString } = await load('connections.js');
    assert.deepEqual(
      parseConnectionString('postgresql://app:p@ss:w/rd%@db.example.com:6543/shop?schema=billing&sslmode=require&connection_limit=1'),
      { host: 'db.example.com', port: 6543, database: 'shop', user: 'app', password: 'p@ss:w/rd%', sslMode: 'require', sslRootCert: undefined, schema: 'billing' },
    );
    const v6 = parseConnectionString('postgres://u@[::1]:5433/db');
    assert.equal(v6.host, '::1');
    assert.equal(v6.port, 5433);
    assert.equal(parseConnectionString('postgres://u@h/db?options=-c%20search_path%3Dapp').schema, 'app');
    assert.deepEqual(parseConnectionString('mysql://x'), {});
  });

  test('undo points: snapshot diff and distinct rows touched', async () => {
    const { diffSnapshots, touchedRows } = await load('undo.js');
    const before = new Map([['1', '{"id":1,"v":"a"}'], ['2', '{"id":2,"v":"b"}'], ['3', '{"id":3,"v":"c"}']]);
    const after = new Map([['1', '{"id":1,"v":"a"}'], ['2', '{"id":2,"v":"B"}'], ['4', '{"id":4,"v":"d"}']]);
    const t = diffSnapshots('public', 't', ['id'], before, after);
    // 2 updated (before+after), 3 deleted (before only), 4 inserted (after only), 1 untouched
    assert.deepEqual(t.before.sort(), ['{"id":2,"v":"b"}', '{"id":3,"v":"c"}']);
    assert.deepEqual(t.after.sort(), ['{"id":2,"v":"B"}', '{"id":4,"v":"d"}']);
    assert.equal(touchedRows([t]), 3);
  });

  test('journal encryption uses the app format (iv:authTag:ciphertext, hex) and round-trips', async () => {
    const { encrypt, decrypt } = await load('journal.js');
    const key = Buffer.alloc(32, 7);
    const sealed = encrypt('{"tables":[]}', key);
    assert.match(sealed, /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);
    assert.equal(decrypt(sealed, key), '{"tables":[]}');
  });

  test('INSERT of rows with different keys: missing columns get DEFAULT', async () => {
    const { buildInsert } = await load('tools/mutations.js');
    const { sql, params } = buildInsert('public', 'products', [{ sku: 'a', price: 1 }, { sku: 'b', tags: ['x'] }]);
    assert.equal(sql, 'INSERT INTO public.products (sku, price, tags) VALUES ($1, $2, DEFAULT), ($3, DEFAULT, $4) RETURNING *');
    assert.deepEqual(params, ['a', 1, 'b', ['x']]);
  });
});

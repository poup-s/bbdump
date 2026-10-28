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

  test('MongoDB tools are offered unless the access of the AI is turned off in bbdump', async () => {
    const { mongoReadAllowed } = await load('mongo/features.js');
    // No features.json, or a level saved while MongoDB was in testing: on (stable since 1.5)
    assert.equal(mongoReadAllowed(null), true);
    assert.equal(mongoReadAllowed({ engines: { postgresql: 'on' } }), true);
    assert.equal(mongoReadAllowed({ engines: { mongodb: 'off' } }), true);
    assert.equal(mongoReadAllowed({ disabled: ['explorer.edit'] }), true);
    assert.equal(mongoReadAllowed({ disabled: ['mcp.read'] }), false);
    assert.equal(mongoReadAllowed({}, 'mcp.write'), true);
    assert.equal(mongoReadAllowed({ disabled: ['mcp.write'] }, 'mcp.write'), false);
    assert.equal(mongoReadAllowed({ disabled: ['mcp.write'] }), true);
    assert.equal(mongoReadAllowed({ disabled: ['mcp.read'] }, 'mcp.write'), false, 'writing needs reading');
  });

  test('MongoDB changes shown as a shell command', async () => {
    const { shellCommand } = await load('mongo/writes.js');
    assert.equal(shellCommand('orders', 'updateMany', [{ city: 'Paris' }, { $set: { done: true } }]), 'db.orders.updateMany({"city":"Paris"}, {"$set":{"done":true}})');
    assert.equal(shellCommand('a"b', 'deleteMany', [{}]), 'db.a\\"b.deleteMany({})');
    assert.ok(shellCommand('x', 'insertMany', [[{ t: 'y'.repeat(5000) }]]).endsWith('…)'));
  });

  test('MongoDB filters and pipelines: Extended JSON read, writes and server JavaScript refused', async () => {
    const { readJsonObject, readPipeline, collectionName, fitDocuments } = await load('mongo/tools.js');
    const filter = await readJsonObject('{"_id": {"$oid": "65f0c0ffee65f0c0ffee65f0"}, "at": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}', 'filter');
    assert.equal(filter._id.constructor.name, 'ObjectId');
    assert.ok(filter.at.$gte instanceof Date);
    assert.deepEqual(await readJsonObject({ city: 'Paris' }, 'filter'), { city: 'Paris' });
    assert.deepEqual(await readJsonObject(undefined, 'filter'), {});
    await assert.rejects(readJsonObject('{"$where": "this.a > 1"}', 'filter'), /\$where runs JavaScript/);
    await assert.rejects(readJsonObject('{city: "Paris"', 'filter'), /not valid JSON/);
    await assert.rejects(readJsonObject('[1]', 'filter'), /must be a JSON object/);
    const stages = await readPipeline('[{"$match": {"at": {"$lt": {"$date": "2026-01-01T00:00:00Z"}}}}]');
    assert.ok(stages[0].$match.at.$lt instanceof Date);
    await assert.rejects(readPipeline([{ $match: {} }, { $out: 'copy' }]), /\$out writes/);
    await assert.rejects(readPipeline([{ $project: { x: { $function: { body: 'x', args: [], lang: 'js' } } } }]), /\$function/);
    assert.equal(collectionName('orders'), 'orders');
    for (const bad of ['', '$cmd', 'system.users', 'a\0b']) assert.throws(() => collectionName(bad), /Invalid collection name/);
    const many = Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(100) }));
    const fitted = fitDocuments(many, 2000);
    assert.ok(fitted.documents.length < 100 && fitted.documents.length >= 1);
    assert.equal(fitted.left_out, 100 - fitted.documents.length);
    assert.equal(fitDocuments(many).left_out, 0);
  });

  test('MongoDB databases in list_connections unless the AI may not read them, never with their password', async () => {
    const crypto = await import('node:crypto');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-mcp-mongo-'));
    const key = crypto.randomBytes(32);
    const seal = (text) => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
      return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
    };
    fs.writeFileSync(path.join(dir, '.encryption.key'), key.toString('hex'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ databases: [
      { id: 'pg1', name: 'app', host: 'localhost', port: 5432, user: 'me', password: '', encrypted: false },
      { id: 'm1', engine: 'mongodb', name: 'shop', displayName: 'Shop', host: '127.0.0.1', port: 27017, user: 'app', password: seal('p@ss:w/rd'),
        connectionString: 'mongodb://app@db1:27018,db2/shop?authSource=admin&tls=true' },
      { id: 'm2', engine: 'mongodb', name: 'crm', host: 'db3', port: 27019, user: 'u', password: seal('pw'), sslMode: 'require', mongo: { authSource: 'users' } },
    ] }));
    const saved = { config: process.env.BBDUMP_CONFIG_PATH, key: process.env.BBDUMP_KEY_PATH };
    process.env.BBDUMP_CONFIG_PATH = path.join(dir, 'config.json');
    process.env.BBDUMP_KEY_PATH = path.join(dir, '.encryption.key');
    try {
      const { listConnections, getMongoTarget, savedEngine, getConnectionParams, findDatabase } = await load('connections.js');
      const { mongoConnection } = await load('shared/mongoUri.js');
      // Reading MongoDB turned off for the AI: PostgreSQL only
      fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({ disabled: ['mcp.read'] }));
      assert.deepEqual(listConnections().map(c => c.id), ['pg1']);
      assert.equal(savedEngine('shop'), null);
      assert.equal(getMongoTarget('m1'), null);

      // No features.json (or a level from when MongoDB was in testing): offered
      fs.rmSync(path.join(dir, 'features.json'));
      assert.deepEqual(listConnections().map(c => c.id), ['pg1', 'm1', 'm2']);
      fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({ engines: { mongodb: 'off' }, disabled: [] }));
      const listed = listConnections();
      assert.deepEqual(listed.map(c => c.id), ['pg1', 'm1', 'm2']);
      const shop = listed.find(c => c.id === 'm1');
      assert.equal(shop.engine, 'mongodb');
      assert.equal(shop.host, 'db1:27018,db2');
      assert.equal(shop.ssl, true);
      assert.equal(listed.find(c => c.id === 'pg1').engine, undefined);
      assert.ok(!JSON.stringify(listed).includes('p@ss'), 'no password in list_connections');
      assert.equal(savedEngine('Shop'), 'mongodb');
      assert.equal(savedEngine('app'), 'postgresql');
      // The PostgreSQL tools never pick a MongoDB database
      assert.equal(getConnectionParams('m1'), null);
      assert.equal(findDatabase('shop'), null);

      const shopTarget = getMongoTarget('m1');
      assert.equal(shopTarget.target.password, 'p@ss:w/rd');
      assert.equal(mongoConnection(shopTarget.target).uri, 'mongodb://app:p%40ss%3Aw%2Frd@db1:27018,db2/shop?authSource=admin&tls=true');
      const crm = mongoConnection(getMongoTarget('m2').target);
      assert.match(crm.uri, /^mongodb:\/\/u:pw@db3:27019\/crm\?authSource=users&tls=true&tlsAllowInvalidCertificates=true$/);
    } finally {
      for (const [name, value] of [['BBDUMP_CONFIG_PATH', saved.config], ['BBDUMP_KEY_PATH', saved.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the helpers copied from src/shared are those of this build', () => {
    for (const file of ['mongoUri.ts', 'documents.ts']) {
      const copy = path.join(process.cwd(), 'mcp-postgres', 'src', 'shared', file);
      if (!fs.existsSync(copy)) continue;
      const source = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'engines', file), 'utf8');
      assert.ok(fs.readFileSync(copy, 'utf8').endsWith(source), `${file}: run npm run build:mcp`);
    }
  });

  test('MongoDB masking: rules of the database, fakes for Extended JSON values, results that may reveal', async () => {
    const m = await load('mongo/masking.js');
    const file = { databases: {
      m1: { enabled: true, columns: [
        { table: 'shop.orders', column: 'customer.email', kind: 'email' },
        { table: 'shop.orders', column: 'at', kind: 'month' },
        { table: 'shop.users.v2', column: 'phone', kind: 'phone' },
        { table: 'other.orders', column: 'x', kind: 'secret' },
      ] },
      m2: { enabled: false, columns: [{ table: 'shop.orders', column: 'a', kind: 'null' }] },
    } };
    const rules = m.mongoRulesFromFile(file, 'm1', 'shop');
    assert.deepEqual([...rules.keys()].sort(), ['orders', 'users.v2'], 'a collection name may hold dots');
    assert.equal(m.mongoRulesFromFile(file, 'm2', 'shop'), null);
    assert.equal(m.mongoRulesFromFile(file, 'nope', 'shop'), null);

    const docs = [{ _id: 1, customer: { email: 'jean@corp.fr', name: 'Jean' }, at: { $date: '2026-05-17T10:20:00Z' }, total: 3 }];
    const masked = m.maskDocuments(docs, rules.get('orders'));
    assert.match(masked.documents[0].customer.email, /@example\.com$/);
    assert.equal(masked.documents[0].customer.name, 'Jean');
    assert.match(String(masked.documents[0].at), /^2026-05-01/);
    assert.equal(masked.documents[0].total, 3);
    assert.deepEqual(m.maskDocuments(docs, rules.get('orders')).documents, masked.documents, 'the same value gives the same fake');
    assert.equal(m.fakeDocumentValue({ $numberLong: '120000' }, 'null'), null);
    assert.match(String(m.fakeDocumentValue({ $oid: '65f0c0ffee' }, 'partial')), /^\*+/);

    assert.equal(m.mayRevealMasked([{ $group: { _id: '$city', n: { $sum: '$total' } } }], 'orders', rules), false);
    assert.equal(m.mayRevealMasked([{ $group: { _id: '$customer.email' } }], 'orders', rules), true);
    assert.equal(m.mayRevealMasked([{ $project: { c: '$customer' } }], 'orders', rules), true);
    assert.equal(m.mayRevealMasked([{ $replaceWith: '$$ROOT' }], 'orders', rules), true);
    assert.equal(m.mayRevealMasked([{ $lookup: { from: 'users.v2', localField: 'u', foreignField: '_id', as: 'u' } }], 'orders', rules), true);
    assert.equal(m.mayRevealMasked({ 'customer.name': 1 }, 'orders', rules), false, 'an inclusion projection keeps the paths');
    const leaves = m.maskLeaves({ email: 'jean@corp.fr', n: 3, id: { $oid: 'ab' }, tags: ['vip'], at: { $date: '2026-01-02T00:00:00Z' } });
    assert.match(leaves.email, /^\*+.*@corp\.fr$/, 'text partly starred, its shape kept');
    assert.equal(leaves.n, 3);
    assert.deepEqual(leaves.id, { $oid: 'ab' });
    assert.match(leaves.tags[0], /^\*/);
    assert.match(String(leaves.at), /^\*/);
  });
});


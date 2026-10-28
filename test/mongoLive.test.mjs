// MongoDB against a real server: the explorer, document edits, aggregations, the dashboards'
// example pipelines, and a backup restored into another database. Skipped unless
// BBDUMP_TEST_MONGO is set (host:port of a throwaway server, e.g. the CI's mongo:8 service);
// backup and restore also need mongodump / mongorestore in the PATH.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = process.cwd();
const server = process.env.BBDUMP_TEST_MONGO;
const skip = server ? false : 'BBDUMP_TEST_MONGO is not set (host:port of a throwaway MongoDB server)';
const [host, port] = (server ?? '127.0.0.1:27017').split(':');
const suffix = `${process.pid}_${Date.now()}`;
const NAME = `bbdump_ci_${suffix}`;
const COPY = `bbdump_ci_copy_${suffix}`;
const hasTools = ['mongodump', 'mongorestore'].every(tool => {
  try { execFileSync(tool, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});

// Renderer modules are TypeScript compiled by Vite: transform them on the fly
const load = (file) => {
  const { transformSync } = require('esbuild');
  const full = path.join(root, file);
  const compiled = transformSync(fs.readFileSync(full, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  const localRequire = (id) => (id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(full), `${id}.ts`))) : require(id));
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, localRequire);
  return mod.exports;
};

let tmp;
let raw;
let BSON;
let registry;
let docs;
let writes;
const DAY = 86400000;
const now = Date.now();

describe('MongoDB on a real server', { skip }, () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-mongo-live-'));
    process.chdir(tmp); // the Electron stub puts userData (config, features, backups, logs) in the cwd
    const database = { id: 'm1', engine: 'mongodb', name: NAME, displayName: NAME, host, port: Number(port), user: '', password: '' };
    fs.writeFileSync('config.json', JSON.stringify({ databases: [database, { ...database, id: 'm2', name: COPY, displayName: COPY }] }));
    fs.writeFileSync('features.json', JSON.stringify({ engines: { mongodb: 'beta' }, disabled: [] }));
    require('./electronStub.cjs');
    require(path.join(root, 'dist/main/ipc/configIpc.js')).loadConfig();
    registry = require(path.join(root, 'dist/main/engines/registry.js'));
    const mongodb = require(path.join(root, 'node_modules/mongodb'));
    BSON = mongodb.BSON;
    raw = new mongodb.MongoClient(`mongodb://${host}:${port}`, { serverSelectionTimeoutMS: 10_000 });
    await raw.connect();

    const db = raw.db(NAME);
    const users = [
      { _id: new BSON.ObjectId(), name: 'Alice Martin', email: 'alice@example.com', phone: '0600000001', created_at: new Date(now - 90 * DAY) },
      { _id: new BSON.ObjectId(), name: 'Bruno Petit', email: 'bruno@example.com', phone: '0600000002', created_at: new Date(now - 60 * DAY) },
      { _id: new BSON.ObjectId(), name: 'a.b* (regex)', email: 'odd@example.com', phone: null, created_at: new Date(now - 10 * DAY) },
    ];
    await db.collection('users').insertMany(users);
    // 12 orders: 8 in the last 30 days, Paris for even ones; every third cancelled
    const orders = Array.from({ length: 12 }, (_, i) => {
      const user = users[i % 3];
      return {
        user_id: user._id,
        customer: { name: user.name, city: i % 2 === 0 ? 'Paris' : 'Lyon' },
        status: i % 3 === 0 ? 'cancelled' : 'paid',
        total: new BSON.Double(10 + i),
        created_at: new Date(now - (i < 8 ? i * 3 + 1 : 45 + i) * DAY),
      };
    });
    await db.collection('orders').insertMany(orders);
    await db.collection('items').insertMany([
      { _id: new BSON.ObjectId(), name: 'a', price: new BSON.Double(5), views: BSON.Long.fromNumber(12), city: 'Paris', at: new Date('2026-10-01T00:00:00Z') },
      { _id: 7, name: 'b', price: new BSON.Double(2.5), city: 'Lyon' },
      { _id: new BSON.ObjectId(), name: 'c', price: new BSON.Double(1), city: 'Paris' },
    ]);
    await db.createCollection('paris', { viewOn: 'items', pipeline: [{ $match: { city: 'Paris' } }] });

    docs = await registry.facetForDb('m1', 'explorer.documents', 'documents');
    writes = await registry.facetForDb('m1', 'explorer.editDocuments', 'documentWrites');
  });

  after(async () => {
    if (raw) {
      await raw.db(NAME).dropDatabase().catch(() => {});
      await raw.db(COPY).dropDatabase().catch(() => {});
      await raw.close();
    }
    process.chdir(root);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('connection and explorer', () => {
    test('the connection test gives the version and the number of collections', async () => {
      const connection = await registry.facetFor('mongodb', 'connection.test', 'connection');
      const result = await connection.test({ host, port: Number(port), user: '', password: '', database: NAME });
      assert.match(result.version, /^\d+\.\d+/);
      assert.equal(result.tables, 4);
    });

    test('collections and views, with their counts', async () => {
      const listed = await docs.listCollections('m1');
      assert.deepEqual(listed.map(c => [c.name, c.type]), [['items', 'collection'], ['orders', 'collection'], ['paris', 'view'], ['users', 'collection']]);
      assert.equal(listed.find(c => c.name === 'orders').documents, 12);
      assert.equal(listed.find(c => c.name === 'paris').documents, null);
    });

    test('a page, filtered and sorted, in relaxed Extended JSON', async () => {
      const page = await docs.find('m1', { collection: 'orders', filter: '{"customer.city": "Paris"}', sort: { field: 'total', direction: -1 }, limit: 2 });
      assert.equal(page.documents.length, 2);
      assert.equal(page.documents[0].total, 20);
      assert.ok(page.documents[0]._id.$oid);
      assert.ok(page.documents[0].created_at.$date);
      await assert.rejects(docs.find('m1', { collection: 'orders', filter: '{"$where": "1"}' }), /JavaScript/);
    });

    test('fields deduced from a sample, and the indexes', async () => {
      const described = await docs.describe('m1', 'orders');
      const paths = described.fields.map(f => f.path);
      for (const field of ['_id', 'customer.city', 'status', 'total', 'created_at']) assert.ok(paths.includes(field), field);
      assert.ok(described.indexes.some(i => i.name === '_id_'));
    });
  });

  describe('document edits', () => {
    test('a replace keeps the types of the values left alone, a stale one writes nothing', async () => {
      const col = raw.db(NAME).collection('items');
      const page = await docs.find('m1', { collection: 'items', sort: { field: 'name', direction: 1 } });
      const [a] = page.documents;
      const { document } = await writes.replace('m1', { collection: 'items', original: a, next: JSON.stringify({ ...a, name: 'a2', price: 6 }) });
      assert.equal(document.name, 'a2');
      const id = new BSON.ObjectId(a._id.$oid);
      assert.equal(await col.countDocuments({ _id: id, name: 'a2', price: { $type: 'double' }, views: { $type: 'long' }, at: { $type: 'date' } }), 1);
      await assert.rejects(writes.replace('m1', { collection: 'items', original: a, next: JSON.stringify({ ...a, name: 'zzz' }) }), /changed/);
      assert.equal((await col.findOne({ _id: id })).name, 'a2');
    });

    test('refused: an _id change, invalid JSON, an operator as a field', async () => {
      const b = (await docs.find('m1', { collection: 'items', filter: '{"_id": 7}' })).documents[0];
      await assert.rejects(writes.replace('m1', { collection: 'items', original: b, next: JSON.stringify({ ...b, _id: 8 }) }), /_id/);
      await assert.rejects(writes.replace('m1', { collection: 'items', original: b, next: '{name:' }), /not valid JSON/);
      await assert.rejects(writes.insert('m1', 'items', '{"$set": {"a": 1}}'), /field name/);
    });

    test('an insert reads Extended JSON, a delete only removes an unchanged document', async () => {
      const col = raw.db(NAME).collection('items');
      const { id } = await writes.insert('m1', 'items', '{"name": "d", "at": {"$date": "2026-10-28T00:00:00Z"}}');
      assert.ok((await col.findOne({ _id: new BSON.ObjectId(id.$oid) })).at instanceof Date);
      const c = (await docs.find('m1', { collection: 'items', filter: '{"name": "c"}' })).documents[0];
      await col.updateOne({ name: 'c' }, { $set: { city: 'Nice' } });
      await assert.rejects(writes.remove('m1', { collection: 'items', original: c }), /changed/);
      const fresh = (await docs.find('m1', { collection: 'items', filter: '{"name": "c"}' })).documents[0];
      await writes.remove('m1', { collection: 'items', original: fresh });
      assert.equal(await col.countDocuments({ name: 'c' }), 0);
      assert.equal(await col.countDocuments({}), 3);
    });

    test('a view cannot be written', async () => {
      const inView = (await docs.find('m1', { collection: 'paris' })).documents[0];
      await assert.rejects(writes.remove('m1', { collection: 'paris', original: inView }));
    });
  });

  describe('aggregations', () => {
    test('a pipeline runs, cut at its limit', async () => {
      const grouped = await docs.aggregate('m1', { collection: 'orders', pipeline: '[{"$group": {"_id": "$customer.city", "n": {"$sum": 1}}}, {"$sort": {"_id": 1}}]' });
      assert.deepEqual(grouped.documents, [{ _id: 'Lyon', n: 6 }, { _id: 'Paris', n: 6 }]);
      assert.equal(grouped.truncated, false);
      const cut = await docs.aggregate('m1', { collection: 'orders', pipeline: '[]', limit: 5 });
      assert.equal(cut.documents.length, 5);
      assert.equal(cut.truncated, true);
    });

    test('refused: writing stages, server JavaScript, not an array', async () => {
      await assert.rejects(docs.aggregate('m1', { collection: 'orders', pipeline: '[{"$out": "x"}]' }), /\$out/);
      await assert.rejects(docs.aggregate('m1', { collection: 'orders', pipeline: '[{"$merge": {"into": "x"}}]' }), /\$merge/);
      await assert.rejects(docs.aggregate('m1', { collection: 'orders', pipeline: '[{"$match": {"$where": "1"}}]' }), /JavaScript/);
      await assert.rejects(docs.aggregate('m1', { collection: 'orders', pipeline: '{"$match": {}}' }), /array/);
      assert.deepEqual((await raw.db(NAME).listCollections({ name: 'x' }).toArray()), []);
    });
  });

  describe('dashboards: the example pipelines given to the AI', () => {
    let program;
    let examples;
    // Each block's query, the way a dashboard runs it
    const run = async (example, block, values) => {
      const match = example.match(new RegExp(`^${block} = Query\\("mongo", \\{query: ("(?:[^"\\\\]|\\\\.)*")\\}`, 'm'));
      assert.ok(match, block);
      const { collection, pipeline } = program.mongoDashboardQuery(program.bindMongoFilters(JSON.parse(match[1]), values));
      return program.toMongoQueryResult(await docs.aggregate('m1', { collection, pipeline, limit: 1000 }));
    };
    const all = { from: '-infinity', to: 'infinity', city: null };

    before(() => {
      program = load('src/renderer/src/dashboards/dashboardProgram.ts');
      examples = load('src/renderer/src/dashboards/mongoDashboard.ts');
    });

    test('filters: the cities, totals for all time, a city, the last 30 days', async () => {
      assert.deepEqual((await run(examples.MONGO_EXAMPLE, 'cities', all)).rows, [{ value: 'Lyon' }, { value: 'Paris' }]);
      assert.deepEqual((await run(examples.MONGO_EXAMPLE, 'totals', all)).rows, [{ orders: 12, revenue: 186 }]);
      assert.equal((await run(examples.MONGO_EXAMPLE, 'totals', { ...all, city: 'Paris' })).rows[0].orders, 6);
      const month = program.periodRange('30d', new Date(now));
      assert.equal((await run(examples.MONGO_EXAMPLE, 'totals', { ...month, city: null })).rows[0].orders, 8);
    });

    test('columns in the written order, weeks as days, ids as text', async () => {
      const weeks = await run(examples.MONGO_EXAMPLE, 'perWeek', all);
      assert.deepEqual(weeks.columns, ['week', 'paid', 'cancelled']);
      assert.ok(weeks.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.week)), JSON.stringify(weeks.rows[0]));
      assert.equal(weeks.rows.reduce((sum, r) => sum + r.paid + r.cancelled, 0), 12);
      const recent = await run(examples.MONGO_EXAMPLE, 'recent', all);
      assert.deepEqual(recent.columns, ['id', 'name', 'status', 'total', 'created_at']);
      assert.equal(recent.rows.length, 12);
      assert.match(recent.rows[0].id, /^[0-9a-f]{24}$/);
    });

    test('a search is text, never a pattern; a picked user gives their orders', async () => {
      const found = await run(examples.MONGO_EXAMPLE_LINKED, 'users', { q: 'a.b*' });
      assert.deepEqual(found.rows.map(r => r.name), ['a.b* (regex)']);
      assert.equal((await run(examples.MONGO_EXAMPLE_LINKED, 'users', { q: null })).rows.length, 3);
      assert.equal((await run(examples.MONGO_EXAMPLE_LINKED, 'users', { q: '.*' })).rows.length, 0);
      const alice = (await run(examples.MONGO_EXAMPLE_LINKED, 'users', { q: 'alice' })).rows[0];
      const picked = await run(examples.MONGO_EXAMPLE_LINKED, 'picked', { user: alice.id });
      assert.deepEqual(picked.columns, ['name', 'email', 'phone', 'created_at', 'orders']);
      assert.equal(picked.rows[0].orders, 4);
      assert.equal((await run(examples.MONGO_EXAMPLE_LINKED, 'theirOrders', { user: alice.id })).rows.length, 4);
    });
  });

  // The CI sets BBDUMP_TEST_MONGO_TOOLS=required: missing tools fail there instead of skipping
  const toolsSkip = hasTools || process.env.BBDUMP_TEST_MONGO_TOOLS === 'required' ? false : 'mongodump / mongorestore are not in the PATH';
  describe('backup and restore', { skip: toolsSkip }, () => {
    test('a backup restored into another database gives the same documents, twice', async () => {
      const config = require(path.join(root, 'dist/main/ipc/configIpc.js')).getConfig();
      const backup = await registry.facetForDb('m1', 'backup.run', 'backup');
      const dumped = await backup.dump(config.databases.find(d => d.id === 'm1'));
      assert.equal(dumped.success, true, dumped.error);
      assert.ok(fs.statSync(dumped.filePath).size > 0);

      const restore = await registry.facetForDb('m2', 'restore.replace', 'restore');
      const target = config.databases.find(d => d.id === 'm2');
      for (let round = 0; round < 2; round++) {
        // The second restore replaces: no document twice
        const restored = await restore.restore(dumped.filePath, target, { replace: true });
        assert.equal(restored.success, true, restored.error);
        for (const name of ['orders', 'users', 'items']) {
          assert.equal(await raw.db(COPY).collection(name).countDocuments(), await raw.db(NAME).collection(name).countDocuments(), name);
        }
      }
      assert.equal(await raw.db(COPY).collection('orders').countDocuments({ total: { $type: 'double' } }), 12);
    });
  });
});

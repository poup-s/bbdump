// The local server of MySQL, MariaDB and MongoDB, against servers on this computer: what
// answers, the account bbdump keeps, a database created then deleted with it. Skipped unless
// BBDUMP_TEST_MYSQL / BBDUMP_TEST_MARIADB (127.0.0.1:port, root password
// BBDUMP_TEST_MYSQL_PASSWORD) or BBDUMP_TEST_MONGO (127.0.0.1:port, no login) are set.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const suffix = `${process.pid}_${Date.now()}`;
const rootPassword = process.env.BBDUMP_TEST_MYSQL_PASSWORD ?? '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-local-live-'));

let server;
let cfg;
before(() => {
  process.chdir(tmp);
  fs.writeFileSync('config.json', JSON.stringify({ databases: [] }));
  require('./electronStub.cjs');
  cfg = require(path.join(root, 'dist/main/ipc/configIpc.js'));
  cfg.loadConfig();
  server = require(path.join(root, 'dist/main/localEngineServer.js'));
});
after(() => process.chdir(root));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in the temp folder */ } });

for (const [engine, env] of [['mysql', 'BBDUMP_TEST_MYSQL'], ['mariadb', 'BBDUMP_TEST_MARIADB']]) {
  const address = process.env[env];
  describe(`local ${engine} server`, { skip: address ? false : `${env} is not set` }, () => {
    const port = Number((address ?? ':0').split(':')[1]);
    const name = `bbdump_local_${suffix}`;

    test('what answers, then the account typed once, then a database created and deleted with it', async () => {
      const first = await server.localServerState(engine, port);
      assert.equal(first.running, true);
      assert.equal(first.answering, engine);
      assert.match(first.version, /^\d+\.\d+/);
      if (rootPassword) {
        assert.equal(first.account, 'needed');
        const wrong = await server.saveLocalAccount(engine, port, 'root', 'not-the-password');
        assert.equal(wrong.success, false);
        const right = await server.saveLocalAccount(engine, port, 'root', rootPassword);
        assert.equal(right.success, true, right.error);
        const saved = JSON.parse(fs.readFileSync('local-servers.json', 'utf8'))[`mysql:${port}`];
        assert.equal(saved.user, 'root');
        assert.notEqual(saved.password, rootPassword, 'kept encrypted');
        if (process.platform !== 'win32') assert.equal(fs.statSync('local-servers.json').mode & 0o777, 0o600);
      }
      const ready = await server.localServerState(engine, port);
      assert.equal(ready.account, 'ready');

      const created = await server.createLocalEngineDatabase(engine, name, port, 'Local shop', { cron: '0 3 * * *', enabled: true, retentionCount: 5 });
      assert.equal(created.success, true, created.error);
      const entry = cfg.getConfig().databases.find(d => d.id === created.id);
      assert.deepEqual([entry.engine, entry.host, entry.port, entry.isLocalBbdump, entry.displayName, entry.cron, entry.enabled, entry.retentionCount], [engine, '127.0.0.1', port, true, 'Local shop', '0 3 * * *', true, 5]);
      const registry = require(path.join(root, 'dist/main/engines/registry.js'));
      const query = await registry.facetForDb(created.id, 'explorer.query', 'query');
      assert.deepEqual((await query.run(created.id, { sql: 'SELECT DATABASE() AS db' })).rows[0], { db: name });

      const twice = await server.createLocalEngineDatabase(engine, name, port);
      assert.equal(twice.success, false);
      assert.equal((await server.createLocalEngineDatabase(engine, 'bad name', port)).success, false);

      const dropped = await server.dropLocalEngineDatabase(created.id);
      assert.equal(dropped.success, true, dropped.error);
      const again = await server.dropLocalEngineDatabase(created.id);
      assert.equal(again.gone, true, 'already gone: nothing else happens');
      await require(path.join(root, 'dist/main/engines/mysql.js')).closeMysqlPools();
    });
  });
}

const mongo = process.env.BBDUMP_TEST_MONGO;
describe('local MongoDB server', { skip: mongo ? false : 'BBDUMP_TEST_MONGO is not set' }, () => {
  const port = Number((mongo ?? ':0').split(':')[1]);
  const name = `bbdump_local_${suffix}`;

  test('no login needed: a database created, written, deleted with it', async () => {
    const state = await server.localServerState('mongodb', port);
    assert.deepEqual([state.running, state.answering, state.account], [true, 'mongodb', 'ready']);
    const created = await server.createLocalEngineDatabase('mongodb', name, port);
    assert.equal(created.success, true, created.error);
    const entry = cfg.getConfig().databases.find(d => d.id === created.id);
    assert.deepEqual([entry.engine, entry.user, entry.isLocalBbdump], ['mongodb', '', true]);
    const { MongoClient } = require(path.join(root, 'node_modules/mongodb'));
    const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`);
    await client.connect();
    try {
      await client.db(name).collection('items').insertOne({ a: 1 });
      assert.equal((await server.createLocalEngineDatabase('mongodb', `${name}_2`, port)).success, true);
      assert.equal((await server.dropLocalEngineDatabase(created.id)).success, true);
      const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
      assert.equal(databases.some(d => d.name === name), false);
    } finally {
      await client.db(name).dropDatabase().catch(() => {});
      await client.close();
    }
  });

  test('a MySQL port is not taken for MongoDB', { skip: process.env.BBDUMP_TEST_MYSQL ? false : 'no MySQL server' }, async () => {
    const other = await server.localServerState('mongodb', Number(process.env.BBDUMP_TEST_MYSQL.split(':')[1]));
    assert.equal(other.running, true);
    assert.equal(other.answering, undefined);
  });
});

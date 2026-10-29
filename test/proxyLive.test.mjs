// The project proxy against real servers: an app connects with any login (MySQL, MariaDB) or
// none (MongoDB), the proxy logs in with the saved account and the app works on the target
// database. Skipped unless BBDUMP_TEST_MYSQL / BBDUMP_TEST_MARIADB (host:port, root password
// BBDUMP_TEST_MYSQL_PASSWORD) or BBDUMP_TEST_MONGO (host:port, no login needed) are set.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = process.cwd();
const suffix = `${process.pid}_${Date.now()}`;
const rootPassword = process.env.BBDUMP_TEST_MYSQL_PASSWORD ?? '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-proxy-live-'));

let proxy;
let targets;
before(() => {
  process.chdir(tmp);
  fs.writeFileSync('config.json', JSON.stringify({ databases: [] }));
  require('./electronStub.cjs');
  proxy = require(path.join(root, 'dist/main/tcpProxy.js')).tcpProxyManager;
  targets = require(path.join(root, 'dist/main/proxyTargets.js'));
});
after(() => {
  proxy?.stopAll();
  process.chdir(root);
});
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in the temp folder */ } });

const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const hasTool = (name) => { try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

for (const [engine, env] of [['mysql', 'BBDUMP_TEST_MYSQL'], ['mariadb', 'BBDUMP_TEST_MARIADB']]) {
  const server = process.env[env];
  describe(`${engine} through the project proxy`, { skip: server ? false : `${env} is not set` }, () => {
    const [host, portText] = (server ?? '127.0.0.1:3306').split(':');
    const port = Number(portText);
    const name = `bbdump_px_${suffix}`;
    const user = `bbpx_${process.pid}`;
    const userPassword = 'px-Secret-1';
    let mysql;
    let admin;
    before(async () => {
      mysql = require(path.join(root, 'node_modules/mysql2/promise'));
      admin = await mysql.createConnection({ host, port, user: 'root', password: rootPassword, multipleStatements: true });
      await admin.query(`CREATE DATABASE \`${name}\`; CREATE TABLE \`${name}\`.items (id INT PRIMARY KEY, label VARCHAR(40)); INSERT INTO \`${name}\`.items VALUES (1, 'one'), (2, 'two')`);
      // MySQL 8.4: caching_sha2_password (the first login is a full one, over RSA); MariaDB: mysql_native_password
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${userPassword}'; GRANT ALL ON \`${name}\`.* TO '${user}'@'%'`);
    });
    after(async () => {
      await admin?.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => {});
      await admin?.query(`DROP USER IF EXISTS '${user}'@'%'`).catch(() => {});
      await admin?.end();
    });

    const start = async (saved) => {
      const target = targets.proxyTargetFor({ id: 'x', engine, name, host, port, user, password: userPassword, output: '', cron: '', ...saved });
      const listen = await freePort();
      const project = `p_${engine}_${listen}`;
      await proxy.startProxy(project, listen, target, name);
      return { listen, project };
    };

    test('any login reaches the target database as the saved user (twice: full then fast login)', async () => {
      const { listen, project } = await start();
      try {
        for (let round = 0; round < 2; round++) {
          const app = await mysql.createConnection({ host: '127.0.0.1', port: listen, user: 'app', password: 'anything', database: 'whatever' });
          const [[who]] = await app.query('SELECT DATABASE() AS db, CURRENT_USER() AS me');
          assert.equal(who.db, name);
          assert.match(who.me, new RegExp(`^${user}@`));
          const [rows] = await app.query('SELECT label FROM items ORDER BY id');
          assert.deepEqual(rows.slice(0, 2).map(r => r.label), ['one', 'two']);
          // Prepared statements (binary protocol) and writes go through too
          const [found] = await app.execute('SELECT label FROM items WHERE id = ?', [2]);
          assert.equal(found[0].label, 'two');
          await app.query('INSERT INTO items VALUES (?, ?)', [10 + round, `r${round}`]);
          await app.end();
        }
        const [[count]] = await admin.query(`SELECT COUNT(*) AS n FROM \`${name}\`.items`);
        assert.equal(Number(count.n), 4);
      } finally {
        proxy.stopProxy(project);
      }
    });

    test('a database that asks for TLS: the proxy encrypts its connection to the server', async () => {
      const { listen, project } = await start({ sslMode: 'require' });
      try {
        const app = await mysql.createConnection({ host: '127.0.0.1', port: listen, user: 'app', password: 'anything' });
        const [rows] = await app.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
        assert.ok(rows[0]?.Value, 'the server sees an encrypted connection');
        await app.end();
      } finally {
        proxy.stopProxy(project);
      }
    });

    test('a wrong saved password: the app gets the reason', async () => {
      const { listen, project } = await start({ password: 'wrong' });
      try {
        await assert.rejects(
          mysql.createConnection({ host: '127.0.0.1', port: listen, user: 'app', password: 'x' }),
          err => /bbdump proxy: .*Access denied/i.test(err.message),
        );
      } finally {
        proxy.stopProxy(project);
      }
    });

    test("the server's own command-line client works through it", { skip: hasTool('mysql') ? false : 'no mysql client' }, async () => {
      const { listen, project } = await start();
      try {
        const out = execFileSync('mysql', ['-h127.0.0.1', `-P${listen}`, '-uapp', '-panything', '-N', '-e', 'SELECT COUNT(*) FROM items'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.match(out.trim(), /^\d+$/);
      } finally {
        proxy.stopProxy(project);
      }
    });
  });
}

const mongoServer = process.env.BBDUMP_TEST_MONGO;
describe('MongoDB through the project proxy', { skip: mongoServer ? false : 'BBDUMP_TEST_MONGO is not set' }, () => {
  const [host, portText] = (mongoServer ?? '127.0.0.1:27017').split(':');
  const port = Number(portText);
  const name = `bbdump_px_${suffix}`;
  const users = { sha256: `bbpx256_${process.pid}`, sha1: `bbpx1_${process.pid}` };
  const userPassword = 'px-Secret-1';
  let MongoClient;
  let admin;
  before(async () => {
    ({ MongoClient } = require(path.join(root, 'node_modules/mongodb')));
    admin = new MongoClient(`mongodb://${host}:${port}/?directConnection=true`);
    await admin.connect();
    await admin.db(name).collection('items').insertMany([{ _id: 1, label: 'one' }, { _id: 2, label: 'two' }, ...Array.from({ length: 150 }, (_, i) => ({ _id: 100 + i, label: `bulk${i}` }))]);
    // A user with SCRAM-SHA-256 credentials, one with SCRAM-SHA-1 only: the proxy logs in with both
    await admin.db('admin').command({ createUser: users.sha256, pwd: userPassword, roles: [{ role: 'readWrite', db: name }], mechanisms: ['SCRAM-SHA-256'] });
    await admin.db('admin').command({ createUser: users.sha1, pwd: userPassword, roles: [{ role: 'readWrite', db: name }], mechanisms: ['SCRAM-SHA-1'] });
  });
  after(async () => {
    await admin?.db(name).dropDatabase().catch(() => {});
    for (const user of Object.values(users)) await admin?.db('admin').command({ dropUser: user }).catch(() => {});
    await admin?.close();
  });

  const start = async (user, password = userPassword) => {
    const target = targets.proxyTargetFor({ id: 'x', engine: 'mongodb', name, host, port, user, password, output: '', cron: '', mongo: { authSource: 'admin' } });
    const listen = await freePort();
    const project = `p_mongo_${listen}`;
    await proxy.startProxy(project, listen, target, name);
    return { listen, project };
  };

  for (const kind of ['sha256', 'sha1']) {
    test(`the app works on the target database (SCRAM-${kind === 'sha1' ? 'SHA-1' : 'SHA-256'} login)`, async () => {
      const { listen, project } = await start(users[kind]);
      const app = new MongoClient(`mongodb://127.0.0.1:${listen}/myapp?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
      try {
        await app.connect();
        const items = app.db().collection('items');
        assert.equal((await items.findOne({ _id: 2 })).label, 'two');
        // A cursor over several batches (getMore names the database too)
        assert.ok((await items.find({}, { batchSize: 20 }).toArray()).length >= 152);
        await items.insertOne({ _id: kind, label: 'through the proxy' });
        assert.deepEqual((await app.db().listCollections().toArray()).map(c => c.name), ['items']);
        assert.equal((await app.db('admin').command({ ping: 1 })).ok, 1);
      } finally {
        await app.close();
        proxy.stopProxy(project);
      }
      // Written into the target, not into "myapp"
      assert.equal((await admin.db(name).collection('items').findOne({ _id: kind })).label, 'through the proxy');
      assert.equal(await admin.db('myapp').collection('items').countDocuments(), 0);
    });
  }

  test('a wrong saved password: the app gets the reason', async () => {
    const { listen, project } = await start(users.sha256, 'wrong');
    const app = new MongoClient(`mongodb://127.0.0.1:${listen}/myapp?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
    try {
      await assert.rejects(app.connect().then(() => app.db().collection('items').findOne({})), err => /bbdump proxy|Authentication failed|closed/i.test(err.message));
    } finally {
      await app.close().catch(() => {});
      proxy.stopProxy(project);
    }
  });
});

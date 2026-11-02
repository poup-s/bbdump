// The SQL Server project proxy against a fake server on this computer: the app (tedious, through
// mssql) logs in with any login and no encryption; the server receives the saved login, password
// and database, over TLS carried in TDS packets when the database asks for encryption.
// No SQL Server needed (the real one is in proxyLive.test.mjs, in CI).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-sqlserver-proxy-'));
let proxy;
let targets;
let tds;
let mssql;
before(() => {
  process.chdir(tmp);
  fs.writeFileSync('config.json', JSON.stringify({ databases: [] }));
  require('./electronStub.cjs');
  proxy = require(path.join(root, 'dist/main/tcpProxy.js')).tcpProxyManager;
  targets = require(path.join(root, 'dist/main/proxyTargets.js'));
  tds = require(path.join(root, 'dist/main/sqlserverProxy.js'));
  mssql = require(path.join(root, 'node_modules/mssql'));
});
after(() => {
  proxy?.stopAll();
  process.chdir(root);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const unscramble = (bytes) => Buffer.from([...bytes].map(b => { const x = b ^ 0xa5; return ((x << 4) & 0xf0) | (x >> 4); })).toString('utf16le');

/** A fake SQL Server: answers PRELOGIN (with TLS or not), records the LOGIN7, refuses it */
async function fakeServer(encryption) {
  const logins = [];
  let cert = null;
  if (encryption !== 'none') {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    cert = { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') };
  }
  const server = net.createServer({ pauseOnConnect: true }, async (socket) => {
    try {
      const prelogin = await tds.readTdsMessage(socket);
      const asked = tds.parsePrelogin(prelogin.payload).get(1)?.[0];
      const answer = encryption === 'none' ? tds.ENCRYPT.NOT_SUP : tds.ENCRYPT.ON;
      socket.write(tds.tdsPackets(tds.TDS.RESPONSE, tds.buildPrelogin([[0, Buffer.from([16, 0, 4, 0, 0, 0])], [1, Buffer.from([answer])], [2, Buffer.from([0])]])));
      let stream = socket;
      if (answer === tds.ENCRYPT.ON) {
        const transport = new tds.TdsTlsTransport(socket);
        stream = new tls.TLSSocket(transport, { isServer: true, ...cert });
        // Node's TLS server says 'secure' before writing its last handshake record: that one still goes in a packet
        await new Promise((resolve, reject) => { stream.once('secure', () => setImmediate(() => { transport.unwrap(); resolve(); })); stream.once('error', reject); });
      }
      const login = await tds.readTdsMessage(stream);
      const body = login.payload;
      const field = (i) => body.subarray(body.readUInt16LE(36 + i * 4), body.readUInt16LE(36 + i * 4) + body.readUInt16LE(38 + i * 4) * 2);
      logins.push({
        asked, tls: stream !== socket, type: login.type, user: field(1).toString('utf16le'), password: unscramble(field(2)), app: field(3).toString('utf16le'),
        server: field(4).toString('utf16le'), database: field(8).toString('utf16le'), integrated: !!(body[25] & 0x80), length: body.readUInt32LE(0) === body.length,
      });
      stream.write(tds.errorResponse(`Login failed for user '${field(1).toString('utf16le')}'.`));
      stream.end();
    } catch (error) {
      logins.push({ error: error.message });
      socket.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, logins, close: () => server.close() };
}

describe('SQL Server project proxy (fake server)', () => {
  test('LOGIN7: the app\'s options kept, its login replaced, Entra ID dropped, offsets consistent', () => {
    const app = {
      fixed: Buffer.alloc(36), clientId: Buffer.from([1, 2, 3, 4, 5, 6]),
      strings: { host: 'laptop', app: 'my-app', library: 'Tedious', language: 'us_english', database: 'ignored' },
      features: [{ id: 0x0a, data: Buffer.from([1]) }, { id: 0x02, data: Buffer.from([9, 9]) }],
    };
    app.fixed[25] = 0x80;
    const built = tds.buildLogin7(app, { user: 'saved', password: 'pw é', server: 'db.example.com', database: 'shop' });
    assert.equal(built.readUInt32LE(0), built.length);
    const back = tds.parseLogin7(built);
    assert.deepEqual(back.strings, { host: 'laptop', user: 'saved', app: 'my-app', server: 'db.example.com', library: 'Tedious', language: 'us_english', database: 'shop' });
    assert.deepEqual(back.features.map(f => f.id), [0x0a]);
    assert.equal(built[25] & 0x80, 0, 'no integrated security');
    const at = built.readUInt16LE(44);
    assert.equal(unscramble(built.subarray(at, at + built.readUInt16LE(46) * 2)), 'pw é');
    assert.deepEqual([...built.subarray(72, 78)], [1, 2, 3, 4, 5, 6]);
  });

  for (const [mode, sslMode] of [['TLS carried in TDS', 'require'], ['no encryption', 'disable']]) {
    test(`the server gets the saved login (${mode}); the app gets the server's answer`, { skip: sslMode === 'require' && !hasOpenssl ? 'no openssl' : false }, async () => {
      const fake = await fakeServer(sslMode === 'require' ? 'tls' : 'none');
      const target = targets.proxyTargetFor({ id: 'x', engine: 'sqlserver', name: 'shopdb', host: '127.0.0.1', port: fake.port, user: 'saved_user', password: 'S3cret é', sslMode, output: '', cron: '' });
      const listen = await freePort();
      await proxy.startProxy(`p_fake_${listen}`, listen, target, 'shopdb');
      try {
        const app = new mssql.ConnectionPool({ server: '127.0.0.1', port: listen, user: 'app', password: 'anything', database: 'whatever', options: { encrypt: false, trustServerCertificate: true, appName: 'my-app' }, connectionTimeout: 10000 });
        await assert.rejects(app.connect(), err => /Login failed for user 'saved_user'/.test(err.message));
        assert.equal(fake.logins.length, 1, JSON.stringify(fake.logins));
        const [login] = fake.logins;
        assert.deepEqual(
          { tls: login.tls, type: login.type, user: login.user, password: login.password, app: login.app, server: login.server, database: login.database, integrated: login.integrated, length: login.length },
          { tls: sslMode === 'require', type: 0x10, user: 'saved_user', password: 'S3cret é', app: 'my-app', server: '127.0.0.1', database: 'shopdb', integrated: false, length: true },
        );
        assert.equal(login.asked, sslMode === 'require' ? tds.ENCRYPT.ON : tds.ENCRYPT.NOT_SUP);
      } finally {
        proxy.stopProxy(`p_fake_${listen}`);
        fake.close();
      }
    });
  }

  test('an unreachable server: the app gets the proxy\'s reason with its login', async () => {
    const closed = await freePort();
    const target = targets.proxyTargetFor({ id: 'x', engine: 'sqlserver', name: 'shopdb', host: '127.0.0.1', port: closed, user: 'u', password: 'p', sslMode: 'require', output: '', cron: '' });
    const listen = await freePort();
    await proxy.startProxy(`p_down_${listen}`, listen, target, 'shopdb');
    try {
      const app = new mssql.ConnectionPool({ server: '127.0.0.1', port: listen, user: 'app', password: 'x', options: { encrypt: false, trustServerCertificate: true }, connectionTimeout: 10000 });
      await assert.rejects(app.connect(), err => /bbdump proxy: .*ECONNREFUSED/.test(err.message));
    } finally {
      proxy.stopProxy(`p_down_${listen}`);
    }
  });

  test('the app\'s URL: any login, no encryption on 127.0.0.1', () => {
    const { proxyUrl, proxyProtocolOf } = require(path.join(root, 'dist/shared/engines/proxy.js'));
    assert.equal(proxyProtocolOf({ engine: 'sqlserver' }), 'sqlserver');
    assert.equal(proxyUrl('sqlserver', 54330, 'shop'), 'sqlserver://127.0.0.1:54330;database=shop;user=shop;password=shop;encrypt=false');
  });
});

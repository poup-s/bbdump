// The pieces without a server: the project proxy's protocols (MySQL handshake, MongoDB
// messages), its targets and URLs, the local servers' install commands, and the new database
// of a restore.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-proxy-'));
let mysqlProxy, mongoProxy, targets, local, restoreToNew;
const { proxyUrl, proxyProtocolOf } = require(path.join(root, 'dist/shared/engines/proxy.js'));

before(() => {
  process.chdir(tmp);
  fs.writeFileSync('config.json', JSON.stringify({ databases: [] }));
  require('./electronStub.cjs');
  mysqlProxy = require(path.join(root, 'dist/main/mysqlProxy.js'));
  mongoProxy = require(path.join(root, 'dist/main/mongoProxy.js'));
  targets = require(path.join(root, 'dist/main/proxyTargets.js'));
  local = require(path.join(root, 'dist/main/platform/localEngines.js'));
  restoreToNew = require(path.join(root, 'dist/main/restoreToNew.js'));
});
after(() => process.chdir(root));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in the temp folder */ } });

/** A MySQL 8 greeting as the server sends it */
function greeting({ caps = 0xdfffffff >>> 0, plugin = 'caching_sha2_password', version = '8.4.3' } = {}) {
  const salt = Buffer.from('abcdefgh12345678wxyz');
  return Buffer.concat([
    Buffer.from([10]), Buffer.from(`${version}\0`), Buffer.from([1, 0, 0, 0]), salt.subarray(0, 8), Buffer.from([0]),
    Buffer.from([caps & 0xff, (caps >>> 8) & 0xff]), Buffer.from([255, 2, 0]), Buffer.from([(caps >>> 16) & 0xff, (caps >>> 24) & 0xff]),
    Buffer.from([21]), Buffer.alloc(10), Buffer.concat([salt.subarray(8), Buffer.from([0])]), Buffer.from(`${plugin}\0`),
  ]);
}

describe('MySQL proxy handshake', () => {
  test('reads the greeting, hides TLS and compression from the app', () => {
    const parsed = mysqlProxy.parseGreeting(greeting());
    assert.equal(parsed.serverVersion, '8.4.3');
    assert.equal(parsed.plugin, 'caching_sha2_password');
    assert.equal(parsed.salt.toString(), 'abcdefgh12345678wxyz');
    const forApp = mysqlProxy.parseGreeting(mysqlProxy.greetingForClient(parsed));
    assert.equal(forApp.caps & mysqlProxy.CAP.SSL, 0);
    assert.equal(forApp.caps & mysqlProxy.CAP.COMPRESS, 0);
    assert.equal(forApp.caps & mysqlProxy.CAP.PROTOCOL_41, mysqlProxy.CAP.PROTOCOL_41);
  });

  test('scrambles as the server expects (mysql_native_password, caching_sha2_password)', () => {
    const salt = Buffer.from('abcdefgh12345678wxyz');
    const sha1 = (...parts) => parts.reduce((h, b) => h.update(b), crypto.createHash('sha1')).digest();
    const stage1 = sha1(Buffer.from('secret'));
    const mix = sha1(salt, sha1(stage1));
    assert.deepEqual(mysqlProxy.scramble('mysql_native_password', 'secret', salt), Buffer.from(stage1.map((b, i) => b ^ mix[i])));
    assert.equal(mysqlProxy.scramble('caching_sha2_password', 'secret', salt).length, 32);
    assert.equal(mysqlProxy.scramble('mysql_native_password', '', salt).length, 0);
    assert.throws(() => mysqlProxy.scramble('client_ed25519', 'x', salt), /cannot log in with the client_ed25519 method/);
  });

  test("the proxy's login keeps the app's capabilities and names the target database", () => {
    const { CAP } = mysqlProxy;
    const app = CAP.PROTOCOL_41 | CAP.SECURE_CONNECTION | CAP.PLUGIN_AUTH | CAP.CONNECT_ATTRS | (1 << 24) | 1;
    const server = 0xffffffff >>> 0;
    const caps = mysqlProxy.upstreamCaps(app, server, false, true);
    assert.ok(caps & (1 << 24), 'CLIENT_DEPRECATE_EOF kept: results come as the app expects');
    assert.ok(caps & CAP.CONNECT_WITH_DB);
    assert.equal(caps & CAP.CONNECT_ATTRS, 0);
    assert.equal(caps & CAP.SSL, 0);
    assert.ok(mysqlProxy.upstreamCaps(app, server, true, false) & CAP.SSL);
    const response = mysqlProxy.buildHandshakeResponse({ caps, maxPacket: 1 << 24, charset: 255, mariaCaps: 0, user: 'shop', auth: Buffer.alloc(20, 7), database: 'shop_prod', plugin: 'mysql_native_password' });
    const parsed = mysqlProxy.parseHandshakeResponse(response);
    assert.equal(parsed.user, 'shop');
    assert.equal(parsed.database, 'shop_prod');
    assert.equal(parsed.charset, 255);
  });

  test('errors reach the app as MySQL error packets', () => {
    const packet = mysqlProxy.errorPacket(2, 'bbdump proxy: Access denied', 1045);
    assert.equal(packet[3], 2);
    assert.equal(mysqlProxy.errorText(packet.subarray(4)), 'bbdump proxy: Access denied (MySQL error 1045)');
  });
});

describe('MongoDB proxy messages', () => {
  const { BSON } = require(path.join(root, 'node_modules/mongodb'));

  test('$db names the target, except admin, config and local', () => {
    const find = Buffer.from(BSON.serialize({ find: 'items', filter: { a: 1 }, $db: 'myapp' }));
    assert.deepEqual(BSON.deserialize(mongoProxy.rewriteCommand(find, 'shop_prod')), { find: 'items', filter: { a: 1 }, $db: 'shop_prod' });
    const ping = Buffer.from(BSON.serialize({ ping: 1, $db: 'admin' }));
    assert.equal(mongoProxy.rewriteCommand(ping, 'shop_prod'), ping, 'same bytes when nothing changes');
  });

  test("the app's hello loses compression and its own login, keeps the rest in order", () => {
    const hello = Buffer.from(BSON.serialize({ hello: 1, client: { app: 'x' }, compression: ['zstd'], speculativeAuthenticate: { saslStart: 1 }, $db: 'admin' }));
    assert.deepEqual(Object.keys(BSON.deserialize(mongoProxy.rewriteCommand(hello, 'shop'))), ['hello', 'client', '$db']);
  });

  test('an OP_MSG keeps its document sequences; a checksum is dropped with its flag', () => {
    const body0 = Buffer.from(BSON.serialize({ insert: 'items', $db: 'myapp' }));
    const doc = Buffer.from(BSON.serialize({ _id: 1, label: 'kept as it is' }));
    const seqId = Buffer.from('documents\0');
    const seqLength = Buffer.alloc(4);
    seqLength.writeInt32LE(4 + seqId.length + doc.length);
    const flags = Buffer.alloc(4);
    flags.writeUInt32LE(1);
    const body = Buffer.concat([flags, Buffer.from([0]), body0, Buffer.from([1]), seqLength, seqId, doc, Buffer.alloc(4)]);
    const out = mongoProxy.rewriteMessage({ requestId: 5, responseTo: 0, opCode: 2013, body }, 'shop');
    assert.equal(out.body.readUInt32LE(0), 0);
    assert.equal(BSON.deserialize(mongoProxy.bodyDocument(out.body)).$db, 'shop');
    assert.ok(out.body.includes(doc), 'the inserted document is passed as it is');
    assert.equal(out.body.length, body.length - 4 - 'myapp'.length + 'shop'.length);
  });

  test('a legacy OP_QUERY hello names admin.$cmd: left as it is, compression removed', () => {
    const query = Buffer.from(BSON.serialize({ isMaster: 1, compression: ['snappy'] }));
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from('admin.$cmd\0'), Buffer.alloc(4), Buffer.from([0xff, 0xff, 0xff, 0xff]), query]);
    const out = mongoProxy.rewriteMessage({ requestId: 1, responseTo: 0, opCode: 2004, body }, 'shop');
    assert.ok(out.body.includes(Buffer.from('admin.$cmd\0')));
    assert.deepEqual(Object.keys(BSON.deserialize(out.body.subarray(4 + 11 + 8))), ['isMaster']);
  });

  test('its own small documents read back with the driver (int32, double, binary, sub-document)', () => {
    const doc = mongoProxy.bson({ saslStart: 1, ratio: 0.5, payload: Buffer.from('n,,n=u'), options: { skipEmptyExchange: true }, $db: 'admin' });
    const parsed = BSON.deserialize(doc, { promoteBuffers: true });
    assert.equal(parsed.saslStart, 1);
    assert.equal(parsed.ratio, 0.5);
    assert.equal(Buffer.from(parsed.payload).toString(), 'n,,n=u');
    assert.equal(parsed.options.skipEmptyExchange, true);
    assert.equal(mongoProxy.readFields(doc).payload.toString(), 'n,,n=u');
  });

  test('a malformed message is refused at once, never looped on', () => {
    // A document whose sub-document claims a negative length
    const doc = Buffer.from(BSON.serialize({ a: { b: 1 } }));
    doc.writeInt32LE(-3, 7);
    assert.throws(() => mongoProxy.topLevel(doc), /Malformed BSON/);
    // A declared length that is not the real one
    const short = Buffer.from(BSON.serialize({ find: 'x', $db: 'y' }));
    short.writeInt32LE(short.length + 10, 0);
    assert.throws(() => mongoProxy.rewriteCommand(short, 'z'), /Malformed BSON/);
    // An OP_MSG section of length -1 (used to loop forever)
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from([1]), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
    assert.throws(() => mongoProxy.rewriteMessage({ requestId: 1, responseTo: 0, opCode: 2013, body }, 'z'), /Malformed BSON/);
    // A key without its NUL
    assert.throws(() => mongoProxy.topLevel(Buffer.from([8, 0, 0, 0, 0x10, 0x61, 0x62, 0])), /Malformed BSON/);
  });

  test("the legacy opcodes (OP_INSERT…) name their namespace: refused, the target is never bypassed", () => {
    assert.throws(() => mongoProxy.rewriteMessage({ requestId: 1, responseTo: 0, opCode: 2002, body: Buffer.alloc(20) }, 'x'), /opcode 2002 is not supported/);
  });

  test('compressed messages are refused with the way out', () => {
    assert.throws(() => mongoProxy.rewriteMessage({ requestId: 1, responseTo: 0, opCode: 2012, body: Buffer.alloc(9) }, 'x'), /remove compressors/);
  });
});

describe('proxy targets and URLs', () => {
  test('one URL per protocol, no real credentials in it', () => {
    assert.equal(proxyUrl('postgresql', 54320, 'shop'), 'postgresql://shop:shop@localhost:54320/shop');
    assert.equal(proxyUrl('mysql', 33060, 'shop'), 'mysql://shop:shop@127.0.0.1:33060/shop');
    assert.equal(proxyUrl('mongodb', 27170, 'shop'), 'mongodb://127.0.0.1:27170/shop?directConnection=true');
    assert.equal(proxyProtocolOf({ engine: 'mariadb' }), 'mysql');
    assert.equal(proxyProtocolOf({}), 'postgresql');
    assert.equal(proxyProtocolOf({ engine: 'sqlite' }), null);
  });

  test('MySQL: the fields, TLS and the tunnel', () => {
    const saved = { engine: 'mysql', name: 'shop', host: 'db.example.com', port: 3306, user: 'app', password: 'pw', sslMode: 'verify-full' };
    const t = targets.proxyTargetFor(saved);
    assert.equal(t.engine, 'mysql');
    assert.deepEqual([t.conn.host, t.conn.port, t.conn.user, t.conn.password, t.conn.database], ['db.example.com', 3306, 'app', 'pw', 'shop']);
    assert.deepEqual(t.conn.tls, { verifyServer: true, verifyName: true, caFile: undefined });
    const tunnelled = targets.proxyTargetFor(saved, { host: '127.0.0.1', port: 41000 });
    assert.deepEqual([tunnelled.conn.host, tunnelled.conn.port, tunnelled.conn.tls.verifyName], ['127.0.0.1', 41000, false]);
  });

  test('MongoDB: SRV clusters through their primary, TLS by default, the login database', () => {
    const srv = targets.proxyTargetFor({ engine: 'mongodb', name: 'shop', host: '', port: 0, user: '', password: 'pw', connectionString: 'mongodb+srv://app@cluster0.abc.mongodb.net/?retryWrites=true' });
    assert.equal(srv.mongo.database, 'shop');
    assert.ok(srv.mongo.discoveryUri, 'the primary is looked up');
    assert.equal(srv.mongo.tls.verifyServer, true);
    assert.equal(srv.mongo.authSource, 'admin');
    assert.equal(srv.mongo.password, 'pw');
    const plain = targets.proxyTargetFor({ engine: 'mongodb', name: 'shop', host: 'localhost', port: 27017, user: '', password: '' });
    assert.equal(plain.mongo.discoveryUri, undefined);
    assert.equal(plain.mongo.tls, undefined);
    assert.equal(plain.mongo.user, undefined);
  });
});

describe('local servers: what each system runs', () => {
  test('Homebrew: install then start with brew services (MongoDB from its tap)', () => {
    assert.deepEqual(local.macosLocalSteps('mysql', '/opt/homebrew/bin/brew'), [['/opt/homebrew/bin/brew', 'install', 'mysql'], ['/opt/homebrew/bin/brew', 'services', 'start', 'mysql']]);
    assert.deepEqual(local.macosLocalSteps('mongodb', 'brew').slice(0, 2), [['brew', 'tap', 'mongodb/brew'], ['brew', 'trust', '--tap', 'mongodb/brew']]);
    // A failed install shows its error lines, not Homebrew's notes printed after them
    const { lastLines } = require(path.join(root, 'dist/main/localEngineServer.js'));
    assert.equal(lastLines("==> Pouring x\n2026 0 [ERROR] mariadbd: unknown variable 'mysqlx-bind-address=127.0.0.1'\n==> Caveats\nTo start mariadb now", 5), "2026 0 [ERROR] mariadbd: unknown variable 'mysqlx-bind-address=127.0.0.1'");
    assert.equal(lastLines('a\nb\nc', 2), 'b\nc');
    assert.equal(local.manualLocalInstall('mariadb', 'macos'), 'brew install mariadb && brew services start mariadb');
  });

  test('Linux: packages, the service and an account for bbdump; MongoDB by hand', () => {
    const script = local.linuxLocalScript('mariadb', 'debian', 'a'.repeat(48));
    assert.match(script, /apt-get install -y mariadb-server/);
    assert.match(script, /systemctl enable --now mariadb/);
    assert.match(script, /CREATE USER IF NOT EXISTS 'bbdump'@'127\.0\.0\.1' IDENTIFIED BY 'a{48}'/);
    assert.match(local.linuxLocalScript('mysql', 'fedora', 'b'.repeat(48)), /community-mysql-server/);
    assert.equal(local.linuxLocalScript('mongodb', 'debian', 'c'.repeat(48)), null);
    assert.equal(local.linuxLocalScript('mysql', 'arch', 'c'.repeat(48)), null);
    assert.throws(() => local.linuxLocalScript('mariadb', 'debian', "x'; DROP"), /Invalid generated password/);
    assert.match(local.manualLocalInstall('mongodb', 'linux', 'debian'), /^https:\/\/www\.mongodb\.com\//);
  });

  test('Windows: winget for MariaDB (its installer asks the root password) and MongoDB; MySQL by hand', () => {
    assert.ok(local.wingetLocalArgs('mariadb').includes('--interactive'));
    assert.ok(local.wingetLocalArgs('mongodb').includes('--silent'));
    assert.equal(local.wingetLocalArgs('mysql'), null);
    assert.match(local.manualLocalInstall('mysql', 'windows'), /dev\.mysql\.com/);
  });
});

describe('copies: names and anonymized fields', () => {
  test("a server's own databases are never created nor dropped", () => {
    const { validLocalName } = require(path.join(root, 'dist/main/localEngineServer.js'));
    for (const name of ['mysql', 'sys', 'information_schema', 'performance_schema', 'MySQL']) assert.equal(validLocalName('mysql', name), false, name);
    for (const name of ['admin', 'local', 'config']) assert.equal(validLocalName('mongodb', name), false, name);
    assert.equal(validLocalName('mysql', 'shop'), true);
    assert.equal(restoreToNew.validNewName('admin', 'mongodb'), false);
    assert.equal(restoreToNew.validNewName('Config', 'mongodb'), false);
  });

  test('an anonymized field is replaced in every shape a document gives it', () => {
    const { replaceEverywhere } = require(path.join(root, 'dist/main/sync/mongoCopy.js'));
    const fake = () => 'X';
    // Sampled as a scalar, met in an array
    assert.deepEqual(replaceEverywhere({ contact: [{ email: 'a@b.c' }, { email: 'd@e.f' }] }, 'contact.email', fake), { contact: [{ email: 'X' }, { email: 'X' }] });
    // Sampled as an array, met as a scalar
    assert.deepEqual(replaceEverywhere({ emails: 'a@b.c' }, 'emails[]', fake), { emails: 'X' });
    assert.deepEqual(replaceEverywhere({ emails: ['a', 'b'] }, 'emails[]', fake), { emails: ['X', 'X'] });
    // Absent: left absent
    assert.deepEqual(replaceEverywhere({ other: 1 }, 'contact.email', fake), { other: 1 });
  });
});

describe('restore into a new database', () => {
  test('the URL names the new database (MySQL), MongoDB keeps its own', () => {
    assert.equal(restoreToNew.urlWithDatabase('mysql://u@h:3306/prod?ssl-mode=REQUIRED', 'prod_restored'), 'mysql://u@h:3306/prod_restored?ssl-mode=REQUIRED');
    assert.equal(restoreToNew.urlWithDatabase('mongodb://u@h/admin', 'x'), 'mongodb://u@h/admin');
    assert.equal(restoreToNew.urlWithDatabase(undefined, 'x'), undefined);
  });

  test('names safe on a command line and in a URL', () => {
    assert.ok(restoreToNew.validNewName('shop_2026', 'mysql'));
    assert.ok(!restoreToNew.validNewName('shop-2026', 'mysql'));
    assert.ok(restoreToNew.validNewName('shop-2026', 'mongodb'));
    assert.ok(!restoreToNew.validNewName('a b', 'mongodb'));
    assert.ok(!restoreToNew.validNewName('', 'mysql'));
  });

  test('the new entry: same connection, another name, no schedule, not a copy', () => {
    const entry = restoreToNew.newDatabaseEntry({ id: 'a', engine: 'mysql', name: 'prod', host: 'h', port: 3306, user: 'u', password: 'enc', encrypted: true, enabled: true, syncSourceId: 'z', lastBackup: 'x', connectionString: 'mysql://u@h/prod' }, 'prod_restored');
    assert.notEqual(entry.id, 'a');
    assert.deepEqual([entry.name, entry.password, entry.encrypted, entry.enabled, entry.syncSourceId, entry.lastBackup], ['prod_restored', 'enc', true, false, undefined, undefined]);
    assert.equal(entry.connectionString, 'mysql://u@h/prod_restored');
  });
});

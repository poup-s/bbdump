// Database engines: feature flags (features.json, dev overrides), and drivers that provide
// every facet their manifest promises — and nothing they do not.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-engines-'));
const shared = require(path.join(cwd, 'dist/shared/engines/features.js'));
const { MANIFESTS, manifestFor } = require(path.join(cwd, 'dist/shared/engines/manifests.js'));
let flags;
let registry;

before(() => {
  process.chdir(tmp); // the Electron stub puts userData (features.json, logs) in the cwd
  fs.writeFileSync('features.json', JSON.stringify({
    engines: { mongodb: 'beta', postgresql: 'off', 'Bad Name': 'on', other: 'maybe' },
    disabled: ['explorer.edit', 'not-a-feature'],
  }));
  process.env.BBDUMP_FEATURES = 'explorer.query:off';
  require('./electronStub.cjs');
  flags = require(path.join(cwd, 'dist/main/featureFlags.js'));
  registry = require(path.join(cwd, 'dist/main/engines/registry.js'));
});

after(() => {
  delete process.env.BBDUMP_FEATURES;
  process.chdir(cwd);
});
// Loading the PostgreSQL driver starts looking for pg_dump, which logs into tmp: removed last
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

describe('engine of a saved database', () => {
  test('no engine means PostgreSQL, as for every database saved before', () => {
    assert.equal(shared.engineOf({}), 'postgresql');
    assert.equal(shared.engineOf({ engine: '' }), 'postgresql');
    assert.equal(shared.engineOf(null), 'postgresql');
    assert.equal(shared.engineOf({ engine: 'mongodb' }), 'mongodb');
  });
});

describe('feature resolution', () => {
  test('every PostgreSQL feature is on by default (it has tables, not documents)', () => {
    for (const key of shared.FEATURE_KEYS) {
      if (['explorer.documents', 'explorer.editDocuments', 'explorer.aggregate'].includes(key)) {
        assert.equal(shared.resolveFeature('postgresql', key).reason, 'feature.unsupported');
        continue;
      }
      assert.deepEqual(shared.resolveFeature('postgresql', key), { enabled: true, beta: false }, key);
    }
  });

  test('an engine this version does not know never falls back to PostgreSQL', () => {
    const state = shared.resolveFeature('cassandra', 'backup.run');
    assert.equal(state.enabled, false);
    assert.equal(state.reason, 'engine.unknown');
  });

  test('a feature turned off everywhere is off, with its reason', () => {
    const state = shared.resolveFeature('postgresql', 'explorer.edit', { engines: { postgresql: 'on' }, disabled: ['explorer.edit'] });
    assert.deepEqual(state, { enabled: false, beta: false, reason: 'feature.disabled' });
  });
});

describe('features.json', () => {
  test('keeps valid levels only, and stable engines can never be turned off', () => {
    const stable = { postgresql: 'on', mongodb: 'on', mysql: 'on', mariadb: 'on', sqlite: 'on' };
    assert.deepEqual(shared.sanitizeRollout({ engines: { postgresql: 'off', mongodb: 'off', mysql: 'beta', redis: 'beta', 'Bad Name': 'on', x: 'maybe' }, disabled: ['backup.run', 'nope', 3] }),
      { engines: { ...stable, redis: 'beta' }, disabled: ['backup.run'] });
    assert.deepEqual(shared.sanitizeRollout('garbage'), shared.DEFAULT_ROLLOUT);
    assert.deepEqual(shared.DEFAULT_ROLLOUT.engines, stable);
  });

  test('development overrides set the levels of engines in testing and switch features', () => {
    const next = shared.applyOverrides(shared.DEFAULT_ROLLOUT, 'redis:beta, mongodb:off, explorer.edit:off ,broken');
    assert.equal(next.engines.redis, 'beta');
    assert.equal(next.engines.mongodb, 'on');
    assert.deepEqual(next.disabled, ['explorer.edit']);
    assert.deepEqual(shared.applyOverrides(next, 'explorer.edit:on').disabled, []);
  });

  test('the file is read, sanitized, then the development overrides apply', () => {
    // features.json still says mongodb: 'beta' (saved while it was in testing): no longer applies
    assert.deepEqual(flags.currentRollout(), {
      engines: { postgresql: 'on', mongodb: 'on', mysql: 'on', mariadb: 'on', sqlite: 'on' },
      disabled: ['explorer.edit', 'explorer.query'],
    });
  });

  test('a stable engine cannot be set to another level', () => {
    assert.throws(() => flags.setEngineLevel('mongodb', 'off'), /Cannot set mongodb/);
    assert.throws(() => flags.setEngineLevel('postgresql', 'beta'), /Cannot set postgresql/);
  });

  test('the main process refuses a feature that is off', () => {
    assert.doesNotThrow(() => flags.requireFeature('postgresql', 'backup.run'));
    assert.throws(() => flags.requireFeature('postgresql', 'explorer.edit'), { name: 'FeatureUnavailableError' });
    assert.throws(() => flags.requireFeature('cassandra', 'backup.run'), /does not support/);
  });
});

describe('drivers and manifests agree', () => {
  test('every engine with a manifest has a driver, and the other way round', () => {
    assert.deepEqual(MANIFESTS.map(m => m.id).sort(), [...registry.DRIVER_ENGINES].sort());
  });

  test('a feature on (yes or beta) has its facet; a missing facet means "no"', async () => {
    for (const engine of registry.DRIVER_ENGINES) {
      const driver = await registry.getDriver(engine);
      const manifest = manifestFor(engine);
      assert.equal(driver.manifest, manifest, engine);
      for (const key of shared.FEATURE_KEYS) {
        const support = manifest.features[key] ?? 'no';
        if (support === 'no') continue;
        for (const facet of shared.facetsOf(key)) assert.ok(driver[facet], `${engine}: ${key} is "${support}" but facet ${facet} is missing`);
      }
      // No facet without a feature that uses it
      for (const facet of ['catalog', 'records', 'documents', 'documentWrites', 'query', 'stats', 'backup', 'restore']) {
        if (!driver[facet]) continue;
        const used = shared.FEATURE_KEYS.some(key => (manifest.features[key] ?? 'no') !== 'no' && shared.facetsOf(key).includes(facet));
        assert.ok(used, `${engine}: facet ${facet} is provided but no feature on uses it`);
      }
    }
  });

  test('a facet is handed out only when its feature is on', async () => {
    const catalog = await registry.facetFor('postgresql', 'explorer.browse', 'catalog');
    assert.equal(typeof catalog.listEntities, 'function');
    await assert.rejects(registry.facetFor('postgresql', 'explorer.edit', 'records'), { name: 'FeatureUnavailableError' });
    await assert.rejects(registry.facetFor('cassandra', 'backup.run', 'backup'), { name: 'FeatureUnavailableError' });
    assert.equal(await registry.getDriver('cassandra'), undefined);
  });
});

describe('MongoDB, stable', () => {
  const MONGO_FEATURES = ['connection.test', 'connection.tls', 'connection.ssh', 'stats.size', 'backup.run', 'backup.schedule', 'backup.verify', 'backup.encrypt', 'restore.replace', 'explorer.documents', 'explorer.editDocuments', 'explorer.aggregate', 'mcp.read', 'mcp.write', 'mcp.undo', 'mask.fields', 'chat', 'dashboards'];

  test('on by default, without a beta badge', () => {
    for (const key of MONGO_FEATURES) {
      assert.deepEqual(shared.resolveFeature('mongodb', key), { enabled: true, beta: false }, key);
    }
    assert.ok(Object.values(manifestFor('mongodb').features).every(support => support === 'yes'));
  });

  test('a level saved while it was in testing no longer applies; a feature turned off stays off', () => {
    for (const level of ['off', 'beta']) {
      const saved = shared.sanitizeRollout({ engines: { mongodb: level }, disabled: ['mcp.write'] });
      assert.deepEqual(shared.resolveFeature('mongodb', 'backup.run', saved), { enabled: true, beta: false }, level);
      assert.equal(shared.resolveFeature('mongodb', 'mcp.write', saved).reason, 'feature.disabled', level);
    }
  });

  test('nothing it cannot do', () => {
    for (const key of ['restore.toOther', 'explorer.browse', 'explorer.edit', 'explorer.query', 'explorer.diagram', 'proxy.tcp', 'database.duplicate', 'sync.fromSource', 'sync.anonymize', 'local.server']) {
      assert.equal(shared.resolveFeature('mongodb', key).reason, 'feature.unsupported', key);
    }
  });
});

describe('backup files of each engine', () => {
  let format;
  before(() => { format = require(path.join(cwd, 'dist/main/backupFormat.js')); });

  test('recognized by their first bytes', () => {
    assert.equal(format.archiveEngineOf(Buffer.from('PGDMP\x01\x0e')), 'postgresql');
    assert.equal(format.archiveEngineOf(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), 'mongodb');
    assert.equal(format.archiveEngineOf(Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0x00])), 'mongodb');
    assert.equal(format.archiveEngineOf(Buffer.from('BBDUMP_ENCRYPTED_V1')), undefined);
    assert.equal(format.archiveEngineOf(Buffer.alloc(0)), undefined);
  });

  test('a backup is never restored into a database of another engine', async () => {
    const { backupManager } = require(path.join(cwd, 'dist/main/backup.js'));
    const pgDump = path.join(tmp, 'pg_dump.backup');
    const mongoArchive = path.join(tmp, 'mongo_archive.backup');
    fs.writeFileSync(pgDump, Buffer.from('PGDMP\x01\x0e\x00'));
    fs.writeFileSync(mongoArchive, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    const ts = new Date().toISOString();

    const intoMongo = await backupManager.openBackupForRestore(pgDump, 'shop', 'mongodb', ts);
    assert.match(intoMongo.failure.error, /comes from a PostgreSQL database/);
    const intoPg = await backupManager.openBackupForRestore(mongoArchive, 'shop', 'postgresql', ts);
    assert.match(intoPg.failure.error, /comes from a MongoDB database/);

    const same = await backupManager.openBackupForRestore(mongoArchive, 'shop', 'mongodb', ts);
    assert.equal(same.file, mongoArchive);
    same.cleanup();
    assert.ok(fs.existsSync(mongoArchive), 'cleanup only removes a temporary decrypted copy');
  });
});

describe('MongoDB Database Tools', () => {
  let tools;
  before(() => { tools = require(path.join(cwd, 'dist/main/tools/mongoTools.js')); });

  test('Windows: Program Files\\MongoDB\\Tools\\<version>\\bin, newest version first', () => {
    const fakeFs = { readdirSync: () => ['100.9.4', '100.13.0', 'notes'] };
    assert.deepEqual(tools.windowsToolCandidates('mongodump', 'C:\\Program Files', fakeFs), [
      'C:\\Program Files\\MongoDB\\Tools\\100.13.0\\bin\\mongodump.exe',
      'C:\\Program Files\\MongoDB\\Tools\\100.9.4\\bin\\mongodump.exe',
    ]);
  });

  test('found in PATH, or an error that says how to install them', async () => {
    assert.equal(await tools.requireMongoTool('mongodump', async () => '/opt/homebrew/bin/mongodump', 'darwin'), '/opt/homebrew/bin/mongodump');
    await assert.rejects(tools.requireMongoTool('mongorestore', async () => null, 'darwin'), /mongorestore was not found.*brew install mongodb\/brew\/mongodb-database-tools/);
    await assert.rejects(tools.requireMongoTool('mongodump', async () => null, 'linux'), /mongodb-database-tools/);
    assert.match(tools.mongoToolsInstallHint('win32'), /winget install MongoDB\.DatabaseTools/);
  });
});

describe('MongoDB connection of the dump tools', () => {
  let mongo;
  before(() => { mongo = require(path.join(cwd, 'dist/main/engines/mongodb.js')); });

  test('the database to dump becomes the path; the login stays where it was', () => {
    // No authSource: the user was looked up in "main", it still is
    assert.equal(mongo.mongoToolUri({ connectionString: 'mongodb://app:pw@db1/main', host: '', port: 0, user: 'app', database: 'other' }),
      'mongodb://app:pw@db1/other?authSource=main');
    // Same database: unchanged
    assert.equal(mongo.mongoToolUri({ connectionString: 'mongodb://app:pw@db1/shop?authSource=admin', host: '', port: 0, user: 'app', database: 'shop' }),
      'mongodb://app:pw@db1/shop?authSource=admin');
    // Field by field: already explicit
    assert.equal(mongo.mongoToolUri({ host: 'db1', port: 27017, user: 'app', password: 'pw', database: 'shop' }),
      'mongodb://app:pw@db1:27017/shop?authSource=admin');
  });

  test('mongorestore gets no database in the path (it would only restore that one), the login stays', () => {
    assert.equal(mongo.mongoRestoreUri({ connectionString: 'mongodb://app:pw@db1/main', host: '', port: 0, user: 'app', database: 'shop_copy' }),
      'mongodb://app:pw@db1/?authSource=main');
    assert.equal(mongo.mongoRestoreUri({ host: 'db1', port: 27017, user: 'app', password: 'pw', database: 'shop' }),
      'mongodb://app:pw@db1:27017/?authSource=admin');
    assert.equal(mongo.mongoRestoreUri({ host: 'db1', port: 27017, user: '', database: 'shop' }), 'mongodb://db1:27017/');
  });
});

describe('MongoDB documents edited in the explorer keep their types', () => {
  let keepTypes;
  let BSON;
  before(async () => {
    ({ keepTypes } = require(path.join(cwd, 'dist/main/engines/mongodb.js')));
    ({ BSON } = await import('mongodb'));
  });
  // What the editor sends back: relaxed JSON parsed as canonical (5.0 reads 5, a long a number)
  const edited = (stored, change) => {
    const text = BSON.EJSON.stringify(stored, { relaxed: true });
    return BSON.EJSON.parse(JSON.stringify(change(JSON.parse(text))), { relaxed: false });
  };

  test('unchanged values keep their stored type', async () => {
    const stored = { _id: new BSON.ObjectId(), price: new BSON.Double(5), views: BSON.Long.fromNumber(12), tags: ['a', new BSON.Double(2)], at: new Date('2026-10-01T10:00:00Z'), nested: { rate: new BSON.Double(1) } };
    const result = await keepTypes(edited(stored, doc => doc), stored);
    assert.equal(result.price._bsontype, 'Double');
    assert.equal(result.views._bsontype, 'Long');
    assert.equal(result.tags[1]._bsontype, 'Double');
    assert.equal(result.nested.rate._bsontype, 'Double');
    assert.ok(result.at instanceof Date);
    assert.ok(result._id.equals(stored._id));
  });

  test('a changed number keeps the double or long type; other changes are taken as typed', async () => {
    const stored = { price: new BSON.Double(5), views: BSON.Long.fromNumber(12), name: 'old', count: 3 };
    const result = await keepTypes(edited(stored, doc => ({ ...doc, price: 7, views: 13, name: 'new', count: 4, added: true })), stored);
    assert.equal(result.price._bsontype, 'Double');
    assert.equal(Number(result.price.value), 7);
    assert.equal(result.views._bsontype, 'Long');
    assert.equal(result.views.toNumber(), 13);
    assert.equal(result.name, 'new');
    assert.equal(result.added, true);
    assert.equal(Number(result.count.valueOf()), 4);
  });
});

describe('MongoDB archives are read to their end', () => {
  let readMongoArchive;
  let BSON;
  before(async () => {
    ({ readMongoArchive } = require(path.join(cwd, 'dist/main/mongoArchive.js')));
    ({ BSON } = await import('mongodb'));
  });
  const zlib = require('node:zlib');
  const term = () => { const b = Buffer.alloc(4); b.writeInt32LE(-1); return b; };
  const magic = () => { const b = Buffer.alloc(4); b.writeUInt32LE(0x8199e26d); return b; };
  const doc = (value) => Buffer.from(BSON.serialize(value));
  /** The layout mongodump --archive writes: prelude, then one block and one EOF block per collection */
  const archive = () => Buffer.concat([
    magic(),
    doc({ concurrent_collections: 4, version: '0.1', server_version: '8.3.13', tool_version: '100.14.0' }),
    doc({ db: 'shop', collection: 'orders', metadata: '{}', size: 0, type: 'collection' }),
    doc({ db: 'shop', collection: 'empty', metadata: '{}', size: 0, type: 'collection' }),
    term(),
    doc({ db: 'shop', collection: 'empty', EOF: false, CRC: 0 }), term(),
    doc({ db: 'shop', collection: 'empty', EOF: true, CRC: 0 }), term(),
    doc({ db: 'shop', collection: 'orders', EOF: false, CRC: 0 }), doc({ n: 1 }), doc({ n: 2 }), doc({ n: 3 }), term(),
    doc({ db: 'shop', collection: 'orders', EOF: true, CRC: 0 }), term(),
  ]);
  const write = (name, bytes) => { const file = path.join(tmp, name); fs.writeFileSync(file, bytes); return file; };

  test('a complete archive, gzip or not, with its documents per collection', async () => {
    const expected = { collections: { 'shop.orders': 3, 'shop.empty': 0 }, documents: 3 };
    assert.deepEqual(await readMongoArchive(write('full.backup', zlib.gzipSync(archive()))), expected);
    assert.deepEqual(await readMongoArchive(write('raw.backup', archive())), expected);
  });

  test('a truncated archive is refused (mongorestore --dryRun accepts it)', async () => {
    const gz = zlib.gzipSync(archive());
    await assert.rejects(readMongoArchive(write('half.backup', gz.subarray(0, Math.floor(gz.length / 2)))), /incomplete/);
    const raw = archive();
    await assert.rejects(readMongoArchive(write('cut.backup', raw.subarray(0, raw.length - 30))), /incomplete/);
  });

  test('damaged data or another file is refused', async () => {
    const gz = Buffer.from(zlib.gzipSync(archive()));
    gz[gz.length - 6] ^= 0xff; // the gzip CRC no longer matches
    await assert.rejects(readMongoArchive(write('crc.backup', gz)), /damaged/);
    await assert.rejects(readMongoArchive(write('pg.backup', Buffer.from('PGDMP\x01\x0e\x00'))), /not a mongodump archive/);
  });
});

describe('MongoDB connection strings', () => {
  const uri = require(path.join(cwd, 'dist/shared/engines/mongoUri.js'));

  test('several hosts, encoded credentials and options', () => {
    const parsed = uri.parseMongoUri('mongodb://al%40ice:p%40ss:w@db1:27017,db2/shop?authSource=admin&replicaSet=rs0');
    assert.deepEqual(parsed, {
      srv: false, username: 'al@ice', password: 'p@ss:w',
      hosts: [{ host: 'db1', port: 27017 }, { host: 'db2' }],
      database: 'shop', options: [['authSource', 'admin'], ['replicaSet', 'rs0']],
    });
    assert.deepEqual(uri.parseMongoUri(uri.formatMongoUri(parsed)), parsed);
  });

  test('SRV names one host without a port', () => {
    assert.equal(uri.parseMongoUri('mongodb+srv://u:p@cluster0.db.example/app').srv, true);
    assert.equal(uri.parseMongoUri('mongodb+srv://u:p@cluster0.db.example:27017/app'), null);
    assert.equal(uri.parseMongoUri('mongodb+srv://a.net,b.net/app'), null);
  });

  test('a pasted password with an unencoded @, IPv6 hosts', () => {
    assert.equal(uri.parseMongoUri('mongodb://u:p@ss@host/db').password, 'p@ss');
    assert.deepEqual(uri.parseMongoUri('mongodb://[::1]:27018/db').hosts, [{ host: '::1', port: 27018 }]);
    assert.equal(uri.formatMongoUri(uri.parseMongoUri('mongodb://[::1]:27018/db')), 'mongodb://[::1]:27018/db');
  });

  test('what is not a usable MongoDB string', () => {
    for (const bad of ['mongodb://', 'mongodb://host:99999/db', 'postgresql://u@h/db', 'mongodb://h/db?%zz=1', 'mongodb://h/a/b']) {
      assert.equal(uri.parseMongoUri(bad), null, bad);
    }
  });
});

describe('MongoDB passwords never stay in the saved URL', () => {
  let secrets;
  before(() => { secrets = require(path.join(cwd, 'dist/main/dbSecrets.js')); });
  const pasted = 'mongodb://al%40ice:p%40ss:w@db1:27017,db2/shop?authSource=admin';

  test('taken out of a multi-host URL, put back in memory', () => {
    const { connectionString, password } = secrets.splitUriPassword(pasted);
    assert.equal(password, 'p@ss:w');
    assert.equal(connectionString, 'mongodb://al%40ice@db1:27017,db2/shop?authSource=admin');
    assert.equal(secrets.injectUriPassword(connectionString, password), 'mongodb://al%40ice:p%40ss%3Aw@db1:27017,db2/shop?authSource=admin');
  });

  test('no user in the URL: no password added, and never a PostgreSQL keyword', () => {
    assert.equal(secrets.injectUriPassword('mongodb://db1/shop', 'secret'), 'mongodb://db1/shop');
  });

  test('a config saved with the password in a MongoDB URL is migrated', () => {
    const config = { databases: [{ id: 'm1', name: 'shop', engine: 'mongodb', connectionString: pasted, password: '' }] };
    assert.equal(secrets.moveUriPasswordsOutOfConfig(config), 1);
    const db = config.databases[0];
    assert.ok(!db.connectionString.includes('p%40ss'));
    assert.equal(db.encrypted, true);
    assert.notEqual(db.password, 'p@ss:w');
    assert.equal(secrets.toRuntimeDatabase(db).password, 'p@ss:w');
  });
});

describe('MongoDB connection of the driver', () => {
  let mongo;
  before(() => { mongo = require(path.join(cwd, 'dist/main/engines/mongodb.js')); });

  test('field by field: user in admin by default, TLS from the SSL mode, hosts logged without secrets', () => {
    const result = mongo.mongoConnection({ host: 'db1', port: 27017, user: 'app', password: 's3cr:t', database: 'shop', sslMode: 'require' });
    assert.equal(result.uri, 'mongodb://app:s3cr%3At@db1:27017/shop?authSource=admin&tls=true&tlsAllowInvalidCertificates=true');
    assert.equal(result.database, 'shop');
    assert.equal(result.hosts, 'db1:27017 (TLS)');
  });

  test('a URL saved without its password gets it back; the field wins over the path', () => {
    const result = mongo.mongoConnection({ connectionString: 'mongodb+srv://app@cluster0.db.example/main', host: '', port: 0, user: 'app', password: 'pw', database: 'other' });
    assert.equal(result.uri, 'mongodb+srv://app:pw@cluster0.db.example/main');
    assert.equal(result.database, 'other');
    assert.equal(result.hosts, 'srv:cluster0.db.example');
  });

  test('a failed login with a URL naming a database but no authSource suggests admin', () => {
    const base = { host: '', port: 0, user: 'app', database: 'shop' };
    assert.match(mongo.authSourceHint({ ...base, connectionString: 'mongodb://app@db1/shop' }), /authSource=admin/);
    for (const cs of ['mongodb://app@db1/shop?authSource=admin', 'mongodb+srv://app@c.x.net/shop', 'mongodb://db1/shop', undefined]) {
      assert.equal(mongo.authSourceHint({ ...base, connectionString: cs }), undefined, String(cs));
    }
  });

  test('through an SSH tunnel: this server only, reached directly (no replica set discovery)', () => {
    const result = mongo.mongoConnection({ host: '127.0.0.1', port: 51234, user: 'app', password: 'pw', database: 'shop', mongo: { authSource: 'admin' }, sslMode: 'verify-ca', viaTunnel: true });
    assert.equal(result.uri, 'mongodb://app:pw@127.0.0.1:51234/shop?authSource=admin&tls=true&tlsAllowInvalidHostnames=true&directConnection=true');
    assert.ok(!mongo.mongoConnection({ host: 'db1', port: 27017, user: '', database: 'shop' }).uri.includes('directConnection'), 'not without a tunnel');
    assert.match(mongo.mongoToolUri({ host: '127.0.0.1', port: 51234, user: 'app', password: 'pw', database: 'shop', viaTunnel: true }), /directConnection=true/);
  });

  test('no database name anywhere is refused', () => {
    assert.throws(() => mongo.mongoConnection({ connectionString: 'mongodb://db1', host: '', port: 0, user: '', database: '' }), /No database name/);
  });
});

describe('document explorer helpers', () => {
  const docs = require(path.join(cwd, 'dist/shared/engines/documents.js'));

  test('server-side JavaScript is found anywhere in a filter', () => {
    assert.equal(docs.serverJavaScriptIn({ city: 'Paris' }), undefined);
    assert.equal(docs.serverJavaScriptIn({ $where: 'this.a > 1' }), '$where');
    assert.equal(docs.serverJavaScriptIn({ $and: [{ a: 1 }, { $expr: { $function: { body: 'x', args: [], lang: 'js' } } }] }), '$function');
    assert.equal(docs.serverJavaScriptIn({ $expr: { $gt: ['$a', 1] } }), undefined);
  });

  test('aggregation pipelines: read-only stages only, no server JavaScript', () => {
    assert.equal(docs.pipelineProblem([{ $match: { city: 'Paris' } }, { $group: { _id: '$city', n: { $sum: 1 } } }]), undefined);
    assert.equal(docs.pipelineProblem([]), undefined);
    assert.match(docs.pipelineProblem([{ $match: {} }, { $out: 'copy' }]), /\$out writes/);
    assert.match(docs.pipelineProblem([{ $merge: { into: 'x' } }]), /\$merge writes/);
    assert.match(docs.pipelineProblem([{ $group: { _id: null, x: { $accumulator: {} } } }]), /\$accumulator runs JavaScript/);
    assert.match(docs.pipelineProblem([{ $lookup: { from: 'b', pipeline: [{ $match: { $where: 'true' } }], as: 'b' } }]), /\$where/);
    assert.match(docs.pipelineProblem({ $match: {} }), /array of stages/);
    assert.match(docs.pipelineProblem([{ $match: {}, $limit: 1 }]), /one operator/);
    assert.match(docs.pipelineProblem(['$match']), /one operator/);
  });

  test('undo points of documents: what differs, keyed by _id, and what undoing does', () => {
    const doc = (id, v) => JSON.stringify({ _id: { $oid: id }, v: { $numberInt: String(v) } });
    const before = [doc('a', 1), doc('b', 2), doc('c', 3)];
    const after = [doc('a', 1), doc('b', 20), doc('d', 4)];
    // a untouched, b updated, c deleted, d inserted
    assert.deepEqual(docs.diffDocumentStates(before, after), { before: [doc('b', 2), doc('c', 3)], after: [doc('b', 20), doc('d', 4)] });
    assert.equal(docs.documentKey(doc('b', 2)), '{"$oid":"b"}');
    assert.deepEqual(docs.documentUndoCounts([doc('b', 2), doc('c', 3)], [doc('b', 20), doc('d', 4)]), { toDelete: 1, toRestore: 1, toRevert: 1 });
    // _id of another type
    assert.equal(docs.documentKey('{"_id":"sku-1","n":1}'), '"sku-1"');
  });

  test('updates: operators or an update pipeline, never a replacement nor JavaScript', () => {
    assert.equal(docs.updateProblem({ $set: { status: 'paid' }, $inc: { n: 1 } }), undefined);
    assert.equal(docs.updateProblem([{ $set: { total: { $add: ['$total', 1] } } }]), undefined);
    assert.match(docs.updateProblem({ status: 'paid' }), /not an update operator/);
    assert.match(docs.updateProblem({}), /empty/);
    assert.match(docs.updateProblem([]), /empty/);
    assert.match(docs.updateProblem([{ $out: 'x' }]), /\$out writes/);
    assert.match(docs.updateProblem([{ $group: { _id: 1 } }]), /cannot be used in an update pipeline/);
    assert.match(docs.updateProblem({ $set: { x: { $function: { body: '' } } } }), /\$function/);
    assert.match(docs.updateProblem('x'), /object of operators/);
  });

  test('masking by path: nested fields and array elements, missing ones left alone', () => {
    const doc = { _id: 1, customer: { email: 'a@b.fr', address: { zip: '75001' } }, items: [{ sku: 'x', owner: { email: 'c@d.fr' } }, { sku: 'y' }], tags: ['p', 'q'] };
    const star = () => '***';
    assert.deepEqual(docs.replaceAtPath(doc, 'customer.email', star).customer, { email: '***', address: { zip: '75001' } });
    assert.deepEqual(docs.replaceAtPath(doc, 'items[].owner.email', star).items, [{ sku: 'x', owner: { email: '***' } }, { sku: 'y' }]);
    assert.deepEqual(docs.replaceAtPath(doc, 'tags[]', star).tags, ['***', '***']);
    assert.deepEqual(docs.replaceAtPath(doc, 'nope.email', star), doc);
    assert.equal(doc.customer.email, 'a@b.fr', 'the original is not changed');
  });

  test('field references of a pipeline, and whether they reach a chosen path', () => {
    const refs = docs.fieldReferences([{ $group: { _id: '$customer.email', n: { $sum: 1 } } }, { $project: { all: '$$ROOT', when: { $year: '$at' } } }]);
    assert.deepEqual([...refs].sort(), ['$$ROOT', 'at', 'customer.email']);
    assert.equal(docs.referenceReaches('customer.email', 'customer.email'), true);
    assert.equal(docs.referenceReaches('customer', 'customer.email'), true, 'a parent carries it');
    assert.equal(docs.referenceReaches('items.owner.email', 'items[].owner.email'), true);
    assert.equal(docs.referenceReaches('customer.name', 'customer.email'), false);
    assert.equal(docs.referenceReaches('city', 'customer.email'), false);
  });

  test('indexes in a short form', () => {
    assert.deepEqual(docs.indexInfo({ name: 'at_1', key: { at: 1 }, expireAfterSeconds: 3600, partialFilterExpression: { a: 1 } }),
      { name: 'at_1', keys: { at: 1 }, unique: false, sparse: false, partial: true, ttlSeconds: 3600 });
  });

  test('BSON types of relaxed Extended JSON values', () => {
    const cases = [[null, 'null'], ['x', 'string'], [3, 'int'], [1.5, 'double'], [true, 'bool'], [[1], 'array'],
      [{ $oid: '65f0' }, 'objectId'], [{ $date: '2026-10-27T10:00:00Z' }, 'date'], [{ $numberDecimal: '1.10' }, 'decimal'],
      [{ $numberLong: '9007199254740993' }, 'long'], [{ a: 1 }, 'object'], [{ $date: 1, other: 2 }, 'object']];
    for (const [value, type] of cases) assert.equal(docs.documentType(value), type, JSON.stringify(value));
  });

  test('fields deduced from a sample: presence, types, nested paths and array elements', () => {
    const sample = [
      { _id: { $oid: 'a' }, city: 'Paris', total: 10, tags: ['x', 'y'], address: { zip: '75001' } },
      { _id: { $oid: 'b' }, city: 'Lyon', total: 2.5, tags: [] },
      { _id: { $oid: 'c' }, city: null, total: 3, address: { zip: 69001 } },
      { _id: { $oid: 'd' }, total: 4 },
    ];
    const byPath = Object.fromEntries(docs.describeSample(sample).map(f => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).slice(0, 3), ['_id', 'city', 'total']);
    assert.equal(byPath._id.presence, 1);
    assert.deepEqual(byPath._id.types, [{ type: 'objectId', share: 1 }]);
    assert.equal(byPath.city.presence, 0.75);
    assert.deepEqual(byPath.city.types.map(t => t.type).sort(), ['null', 'string']);
    assert.deepEqual(byPath.total.types, [{ type: 'int', share: 0.75 }, { type: 'double', share: 0.25 }]);
    assert.equal(byPath['tags[]'].presence, 0.25, 'an empty array has no element');
    assert.equal(byPath['address.zip'].presence, 0.5);
    assert.deepEqual(byPath['address.zip'].types.map(t => t.type).sort(), ['int', 'string']);
    assert.deepEqual(docs.describeSample([]), []);
  });

  test('values shown short and readable', () => {
    assert.equal(docs.formatDocumentValue({ $oid: '65f0c0ffee' }), 'ObjectId(65f0c0ffee)');
    assert.equal(docs.formatDocumentValue({ $date: '2026-10-27T10:00:00.000Z' }), '2026-10-27 10:00:00 UTC');
    assert.equal(docs.formatDocumentValue({ $date: { $numberLong: '0' } }), '1970-01-01 00:00:00 UTC');
    assert.equal(docs.formatDocumentValue({ $numberDecimal: '1.10' }), '1.10');
    assert.equal(docs.formatDocumentValue([1, 2]), '[2] [1,2]');
    assert.equal(docs.formatDocumentValue(undefined), '');
    assert.ok(docs.formatDocumentValue('x'.repeat(500)).length <= 121);
  });

  test('columns of a page: _id first, then fields as first seen', () => {
    assert.deepEqual(docs.documentColumns([{ b: 1, _id: 1 }, { a: 2, b: 3 }]), ['_id', 'b', 'a']);
    assert.deepEqual(docs.documentColumns([]), []);
  });
});

describe('MongoDB fields offered for anonymization', () => {
  const masking = require(path.join(cwd, 'dist/main/mongoMasking.js'));

  test('what a field can become, from its type', () => {
    assert.ok(masking.fieldKinds('string', false).includes('email'));
    assert.deepEqual(masking.fieldKinds('int', false), ['noise', 'null']);
    assert.deepEqual(masking.fieldKinds('int', true), ['null']);
    assert.deepEqual(masking.fieldKinds('date', false), ['noise', 'month', 'year', 'null']);
    assert.deepEqual(masking.fieldKinds('object', false), ['secret', 'null']);
    assert.deepEqual(masking.fieldKinds('bool', false), []);
  });

  test('personal fields detected by their own name, nested and camelCase included', () => {
    assert.equal(masking.detectFieldKind('orders', 'customer.email', 'string', false), 'email');
    assert.equal(masking.detectFieldKind('users', 'firstName', 'string', false), 'first_name');
    assert.equal(masking.detectFieldKind('orders', 'customer.name', 'string', false), 'name');
    assert.equal(masking.detectFieldKind('orders', 'items[].sku', 'string', false), undefined);
    assert.equal(masking.detectFieldKind('users', 'birthDate', 'date', false), 'year');
    assert.equal(masking.detectFieldKind('users', 'phone', 'int', false), undefined, 'a number is not a phone number here');
  });

  test('rows of the dialog: _id locked, detection kept only when the type allows it', () => {
    const columns = masking.fieldColumns('orders', [
      { path: '_id', presence: 1, types: [{ type: 'objectId', share: 1 }] },
      { path: 'customer.email', presence: 1, types: [{ type: 'string', share: 0.9 }, { type: 'null', share: 0.1 }] },
      { path: 'paid', presence: 1, types: [{ type: 'bool', share: 1 }] },
    ], new Set());
    assert.equal(columns[0].locked, 'key');
    assert.equal(columns[1].detected, 'email');
    assert.equal(columns[1].type, 'string | null');
    assert.equal(columns[2].locked, 'type');
  });
});


// MySQL, MariaDB and SQLite: connection URLs, read-only SQL, backup files, dump tools and the
// explorer's column shapes (no server needed). SQLite also runs for real, on a temporary file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const uri = require(path.join(cwd, 'dist/shared/engines/mysqlUri.js'));
const guard = require(path.join(cwd, 'dist/shared/engines/sqlGuard.js'));
const { MANIFESTS, manifestFor, isMysqlFamily } = require(path.join(cwd, 'dist/shared/engines/manifests.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-sql-engines-'));
let format, secrets, tools, mysql, sqlite, registry;

before(() => {
  process.chdir(tmp);
  require('./electronStub.cjs');
  format = require(path.join(cwd, 'dist/main/backupFormat.js'));
  secrets = require(path.join(cwd, 'dist/main/dbSecrets.js'));
  tools = require(path.join(cwd, 'dist/main/tools/mysqlTools.js'));
  mysql = require(path.join(cwd, 'dist/main/engines/mysql.js'));
  sqlite = require(path.join(cwd, 'dist/main/engines/sqlite.js'));
  registry = require(path.join(cwd, 'dist/main/engines/registry.js'));
});
after(async () => {
  await mysql?.closeMysqlPools();
  process.chdir(cwd);
});
// Best effort: on Windows a file a stopped query process still held may stay locked a moment
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp folder */ } });

describe('manifests', () => {
  test('MySQL, MariaDB and SQLite are known, with a driver each', async () => {
    assert.deepEqual(MANIFESTS.map(m => m.id), ['postgresql', 'mongodb', 'mysql', 'mariadb', 'sqlite']);
    for (const id of ['mysql', 'mariadb', 'sqlite']) {
      assert.equal(manifestFor(id).queryLanguage, 'sql');
      assert.equal((await registry.getDriver(id)).manifest.id, id);
    }
    assert.ok(isMysqlFamily('mariadb') && isMysqlFamily('mysql') && !isMysqlFamily('sqlite'));
  });

  test('SQLite has no server: no SSH, TLS, proxy or local server; nothing copies a database yet', () => {
    for (const key of ['connection.ssh', 'connection.tls', 'proxy.tcp', 'local.server', 'database.duplicate', 'sync.fromSource']) {
      assert.equal(manifestFor('sqlite').features[key] ?? 'no', 'no', key);
    }
    assert.equal(manifestFor('mysql').features['connection.tls'], 'yes');
    assert.equal(manifestFor('mariadb').defaultPort, 3306);
  });
});

describe('MySQL URLs', () => {
  test('read with their port, user, password, database and TLS mode', () => {
    const parsed = uri.parseMysqlUri('mysql://app:p%40ss%3Aw@db.example.com:3307/shop?ssl-mode=VERIFY_IDENTITY');
    assert.deepEqual(parsed, { host: 'db.example.com', port: 3307, user: 'app', password: 'p@ss:w', database: 'shop', sslMode: 'verify-full', sslRootCert: undefined });
    assert.equal(uri.parseMysqlUri('mariadb://u@h/db').port, 3306);
    assert.equal(uri.parseMysqlUri('mysql://u@h/db?sslaccept=strict').sslMode, 'verify-full');
    assert.equal(uri.parseMysqlUri('mysql://u@h/db?ssl=true').sslMode, 'require');
    assert.equal(uri.parseMysqlUri('postgresql://u@h/db'), null);
    assert.equal(uri.parseMysqlUri('mysql://'), null);
  });

  test('the URL wins, fields fill the gaps, a tunnel keeps its own host and turns verify-full into verify-ca', () => {
    const conn = uri.mysqlConnection({ connectionString: 'mysql://app@db.example.com/shop?ssl-mode=VERIFY_IDENTITY', host: '', port: 0, user: '', password: 'pw', database: '' });
    assert.deepEqual([conn.host, conn.port, conn.user, conn.password, conn.database], ['db.example.com', 3306, 'app', 'pw', 'shop']);
    assert.deepEqual(conn.tls, { verifyServer: true, verifyName: true, caFile: undefined });
    const tunnelled = uri.mysqlConnection({ connectionString: 'mysql://app@db.example.com/shop?ssl-mode=VERIFY_IDENTITY', host: '127.0.0.1', port: 51234, user: '', password: 'pw', database: '', viaTunnel: true });
    assert.deepEqual([tunnelled.host, tunnelled.port, tunnelled.tls.verifyName], ['127.0.0.1', 51234, false]);
    // A restore into another database names it
    assert.equal(uri.mysqlConnection({ connectionString: 'mysql://app@h/shop', host: '', port: 0, user: '', database: 'shop_copy' }).database, 'shop_copy');
    assert.equal(uri.mysqlConnection({ host: 'h', port: 3306, user: 'u', database: 'd', sslMode: 'disable' }).tls, undefined);
    assert.equal(uri.mysqlIdent('we`ird'), '`we``ird`');
  });

  test('a password in a mysql:// or mariadb:// URL is taken out and kept encrypted', () => {
    assert.deepEqual(secrets.splitUriPassword('mysql://app:s3cr%3Aet@db:3306/shop'), { connectionString: 'mysql://app@db:3306/shop', password: 's3cr:et' });
    assert.deepEqual(secrets.splitUriPassword('mariadb://app:pw@db/shop'), { connectionString: 'mariadb://app@db/shop', password: 'pw' });
    assert.equal(secrets.injectUriPassword('mysql://app@db:3306/shop', 'p@ss'), 'mysql://app:p%40ss@db:3306/shop');
  });
});

describe('read-only SQL', () => {
  const problem = (sql, dialect = 'mysql') => guard.readOnlyProblem(sql, dialect);

  test('one reading statement passes', () => {
    for (const sql of ['SELECT 1', 'select * from t;', 'WITH a AS (SELECT 1) SELECT * FROM a', 'SHOW TABLES', 'EXPLAIN SELECT 1', '(SELECT 1) UNION (SELECT 2)', "SELECT 'a; DROP TABLE t'", 'SELECT `delete` FROM t']) {
      assert.equal(problem(sql), null, sql);
    }
    assert.equal(problem('PRAGMA table_info(t)', 'sqlite'), null);
    assert.equal(problem('SELECT "drop" FROM [update]', 'sqlite'), null);
  });

  test('writes, DDL, several statements and hidden ones are refused', () => {
    for (const sql of ['UPDATE t SET a = 1', 'DROP TABLE t', 'TRUNCATE t', 'CALL p()', 'SELECT 1; DROP TABLE t', 'SELECT 1 /* ; */; DELETE FROM t',
      "SELECT 'x' -- ;\n; DROP TABLE t", 'SELECT 1 # ;\n; DROP TABLE t', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'SELECT 1 INTO @a', 'LOAD DATA INFILE "x" INTO TABLE t', '/*!40000 DROP TABLE t */']) {
      assert.notEqual(problem(sql), null, sql);
    }
    // MySQL runs /*! … */: its content counts
    assert.notEqual(problem('SELECT 1 /*!; DROP TABLE t */'), null);
    assert.notEqual(problem('WITH x AS (SELECT 1) DELETE FROM t', 'sqlite'), null);
    assert.notEqual(problem('ATTACH DATABASE "x" AS y', 'sqlite'), null);
    assert.equal(guard.statementCount('SELECT 1;;', 'mysql'), 1);
    assert.equal(guard.statementKind('  -- c\n insert into t values (1)', 'sqlite'), 'INSERT');
  });
});

describe('backup files', () => {
  test('a MySQL / MariaDB dump is a gzip stream whose first line names its engine; other gzip streams stay MongoDB', () => {
    const dump = (engine) => zlib.gzipSync(`${format.sqlDumpHeader(engine)}\n-- MySQL dump 10.13\nCREATE TABLE t (a int);\n`);
    assert.equal(format.archiveEngineOf(dump('mysql')), 'mysql');
    assert.equal(format.archiveEngineOf(dump('mariadb')), 'mariadb');
    assert.equal(format.archiveEngineOf(zlib.gzipSync(Buffer.from([0x6d, 0xe2, 0x99, 0x81, 1, 2, 3]))), 'mongodb');
    assert.equal(format.archiveEngineOf(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), 'mongodb');
    assert.equal(format.archiveEngineOf(Buffer.from('SQLite format 3\0rest of the header')), 'sqlite');
    // The header is read from a prefix of a big stream
    const big = zlib.gzipSync(Buffer.concat([Buffer.from(`${format.sqlDumpHeader('mysql')}\n`), Buffer.alloc(1_000_000, 'x')]));
    assert.equal(format.archiveEngineOf(big.subarray(0, format.ARCHIVE_HEAD_BYTES)), 'mysql');
  });
});

describe('dump and client tools', () => {
  test('the server flavour first; install hints by platform', () => {
    assert.deepEqual(tools.mysqlToolNames('dump', 'mariadb'), ['mariadb-dump', 'mysqldump']);
    assert.deepEqual(tools.mysqlToolNames('client', 'mysql'), ['mysql', 'mariadb']);
    assert.match(tools.mysqlToolsInstallHint('mysql', 'darwin'), /brew install mysql-client/);
    assert.match(tools.mysqlToolsInstallHint('mariadb', 'win32'), /winget install MariaDB/);
    assert.match(tools.mysqlToolsInstallHint('mysql', 'linux'), /mysql-client/);
  });

  test("Homebrew's keg-only mysql-client is found outside the PATH", () => {
    const fakeFs = { readdirSync: dir => (dir === '/opt/homebrew/opt' ? ['mysql-client', 'node', 'mariadb', 'mysql-client@8.4'] : []) };
    assert.deepEqual(tools.mysqlToolDirs('darwin', {}, fakeFs), ['/opt/homebrew/opt/mysql-client@8.4/bin', '/opt/homebrew/opt/mysql-client/bin', '/opt/homebrew/opt/mariadb/bin']);
  });

  test('the password goes in an option file, never on the command line', () => {
    const args = mysql.mysqlDumpArgs('/tmp/x/client.cnf', 'shop', 'mysql', 'mariadb');
    assert.equal(args[0], '--defaults-extra-file=/tmp/x/client.cnf');
    assert.ok(args.includes('--single-transaction') && args.includes('--routines') && args.includes('--set-gtid-purged=OFF') && args.includes('--column-statistics=0'));
    assert.equal(args.at(-1), 'shop');
    assert.ok(!mysql.mysqlDumpArgs('/f', 'shop', 'mariadb', 'mariadb').some(a => /gtid|column-statistics/.test(a)));
    const conn = uri.mysqlConnection({ host: 'db', port: 3306, user: 'app', password: 'p"a\\ss', database: 'shop', sslMode: 'verify-ca', sslRootCert: '/ca.pem' });
    const forMysql = mysql.mysqlOptionFileText(conn, 'mysql');
    assert.match(forMysql, /password="p\\"a\\\\ss"/);
    assert.match(forMysql, /ssl-mode=VERIFY_CA/);
    assert.match(forMysql, /ssl-ca="\/ca.pem"/);
    assert.match(forMysql, /protocol=TCP/);
    assert.match(mysql.mysqlOptionFileText({ ...conn, tls: undefined }, 'mariadb'), /skip-ssl/);
    assert.match(mysql.mysqlOptionFileText({ ...conn, tls: { verifyServer: false, verifyName: false } }, 'mariadb'), /^ssl$\n^skip-ssl-verify-server-cert$/m);
  });
});

describe('explorer columns', () => {
  test('MySQL types keep their names; TINYINT(1) is a boolean, AUTO_INCREMENT an identity', () => {
    const base = { is_nullable: 'NO', column_default: null, character_maximum_length: null, numeric_precision: 3, numeric_scale: 0 };
    const flag = mysql.describeMysqlColumn({ ...base, column_name: 'vip', data_type: 'tinyint', column_type: 'tinyint(1)', extra: '' });
    assert.equal(flag.udt_name, 'bool');
    assert.equal(flag.data_type, 'tinyint(1)');
    assert.equal(mysql.describeMysqlColumn({ ...base, column_name: 'id', data_type: 'bigint', column_type: 'bigint unsigned', extra: 'auto_increment' }).is_identity, 'YES');
    assert.equal(mysql.describeMysqlColumn({ ...base, column_name: 'full', data_type: 'varchar', column_type: 'varchar(80)', extra: 'STORED GENERATED' }).is_generated, 'ALWAYS');
    assert.equal(mysql.describeMysqlColumn({ ...base, column_name: 'at', data_type: 'timestamp', column_type: 'timestamp', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' }).is_generated, 'NEVER');
  });

  test('SQLite: INTEGER PRIMARY KEY is the rowid, BOOLEAN a boolean, generated columns read-only', () => {
    const col = (over) => ({ cid: 0, name: 'c', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0, hidden: 0, ...over });
    assert.equal(sqlite.describeSqliteColumn(col({ name: 'id', type: 'INTEGER', pk: 1 }), true).is_identity, 'YES');
    assert.equal(sqlite.describeSqliteColumn(col({ type: 'BOOLEAN' }), false).udt_name, 'bool');
    assert.equal(sqlite.describeSqliteColumn(col({ type: 'VARCHAR(40)' }), false).character_maximum_length, 40);
    assert.equal(sqlite.describeSqliteColumn(col({ type: '', hidden: 3 }), false).is_generated, 'ALWAYS');
    assert.equal(sqlite.describeSqliteColumn(col({ type: '' }), false).data_type, 'any');
    assert.deepEqual([true, false, { a: 1 }, undefined, new Date(0)].map(sqlite.sqliteBindable), [1, 0, '{"a":1}', null, '1970-01-01T00:00:00.000Z']);
  });
});

describe('SQLite queries in their own process', () => {
  let file;
  before(() => {
    file = path.join(tmp, 'q.sqlite');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, ok BOOLEAN, big INTEGER, raw BLOB); INSERT INTO t VALUES (1, 'a', 1, 9007199254740993, x'00ff');");
    db.close();
  });

  test('results come back typed (booleans, blobs, their origin column)', async () => {
    const result = await sqlite.runSqliteReadOnly(file, { sql: 'SELECT id, name AS n, ok, raw, 1 + 1 AS two FROM t WHERE id = ?', values: [1] });
    assert.deepEqual(result.fields, ['id', 'n', 'ok', 'raw', 'two']);
    assert.equal(result.rows[0].ok, true);
    assert.deepEqual([...result.rows[0].raw], [0, 255]);
    assert.deepEqual(result.origins[1], { table: 't', column: 'name' });
    assert.deepEqual(result.origins[4], { table: null, column: null });
  });

  test('read-only: writes refused by the guard and by the connection', async () => {
    await assert.rejects(sqlite.runSqliteReadOnly(file, { sql: "UPDATE t SET name = 'x'" }), /reading/);
    await assert.rejects(sqlite.runSqliteIsolated(file, { sql: "UPDATE t SET name = 'x'", mode: 'read' }), /readonly/);
    const write = await sqlite.runSqliteIsolated(file, { sql: "UPDATE t SET name = 'b'", mode: 'write' });
    assert.equal(write.rowCount, 1);
  });

  test('a query that runs too long is stopped (its process killed)', async () => {
    const started = Date.now();
    await assert.rejects(
      sqlite.runSqliteReadOnly(file, { sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', timeoutMs: 500 }),
      /stopped after/);
    assert.ok(Date.now() - started < 5000);
  });
});

describe('journal rows and dashboards (pure)', () => {
  test('a journal row keeps bigints and bytes exactly; numbers read as text by one driver compare equal', async () => {
    const rows = require(path.join(cwd, 'dist/shared/engines/sqlRows.js'));
    const text = rows.encodeRow({ id: 9007199254740993n, raw: new Uint8Array([0, 255]), total: '10.50', ok: true, at: null });
    const back = rows.decodeRow(text);
    assert.equal(back.id, 9007199254740993n);
    assert.deepEqual([...back.raw], [0, 255]);
    assert.equal(rows.rowKey(text, ['id']), JSON.stringify([{ $bigint: '9007199254740993' }]));
    assert.ok(rows.sameRow({ id: 9007199254740993n, raw: new Uint8Array([0, 255]), total: 10.5, ok: 1, at: null }, text));
    assert.ok(!rows.sameRow({ id: 9007199254740993n, raw: new Uint8Array([0, 255]), total: 11, ok: 1, at: null }, text));
  });

  test('MySQL and SQLite types read as the PostgreSQL ones the anonymization knows', () => {
    const { pgTypeOf } = require(path.join(cwd, 'dist/main/sqlMasking.js'));
    assert.deepEqual(['varchar(120)', 'tinyint(1)', 'int(11)', 'decimal(10,2)', 'double', 'datetime', 'date', 'json', 'blob', 'any'].map(t => pgTypeOf(t, t === 'tinyint(1)' ? 'bool' : undefined)),
      ['text', 'boolean', 'integer', 'numeric', 'double precision', 'timestamp without time zone', 'date', 'json', 'bytea', 'text']);
  });
});

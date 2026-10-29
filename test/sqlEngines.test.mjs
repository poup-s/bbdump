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
  test('MySQL, MariaDB, SQLite and DuckDB are known, with a driver each', async () => {
    assert.deepEqual(MANIFESTS.map(m => m.id), ['postgresql', 'mongodb', 'mysql', 'mariadb', 'sqlite', 'duckdb', 'sqlserver']);
    for (const id of ['mysql', 'mariadb', 'sqlite', 'duckdb', 'sqlserver']) {
      assert.equal(manifestFor(id).queryLanguage, 'sql');
      assert.equal((await registry.getDriver(id)).manifest.id, id);
    }
    assert.ok(isMysqlFamily('mariadb') && isMysqlFamily('mysql') && !isMysqlFamily('sqlite'));
  });

  test('SQLite and DuckDB have no server: no SSH, TLS, proxy or local server', () => {
    for (const key of ['connection.ssh', 'connection.tls', 'proxy.tcp', 'local.server']) {
      assert.equal(manifestFor('sqlite').features[key] ?? 'no', 'no', key);
      assert.equal(manifestFor('duckdb').features[key] ?? 'no', 'no', key);
    }
    assert.equal(manifestFor('mysql').features['connection.tls'], 'yes');
    assert.equal(manifestFor('mariadb').defaultPort, 3306);
  });

  test('MySQL and MariaDB can be reached through SSH, like PostgreSQL and MongoDB', () => {
    for (const id of ['mysql', 'mariadb']) assert.equal(manifestFor(id).features['connection.ssh'], 'yes', id);
  });

  test('MySQL, MariaDB and SQLite can be copied and updated from another database', () => {
    for (const id of ['mysql', 'mariadb', 'sqlite']) {
      assert.equal(manifestFor(id).features['database.duplicate'], 'yes', id);
      assert.equal(manifestFor(id).features['sync.fromSource'], 'yes', id);
    }
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

describe('copies made by bbdump (MySQL, MariaDB, SQLite)', () => {
  const fakes = () => require(path.join(cwd, 'dist/main/sync/fakeValues.js'));
  const copy = () => require(path.join(cwd, 'dist/main/sync/sqlCopy.js'));

  test('fake values: deterministic, the right shape, null kept, unique columns kept distinct', () => {
    const { fakeValue } = fakes();
    const email = fakeValue('alice@company.fr', 'email');
    assert.match(email, /^[a-z]+\.[a-z]+\.[0-9a-f]{4}@example\.com$/);
    assert.equal(fakeValue('alice@company.fr', 'email'), email, 'same value, same fake');
    assert.equal(fakeValue(null, 'email'), null);
    assert.match(fakeValue('0612345678', 'phone'), /^\+000\d{9}$/);
    assert.match(fakeValue('Alice Martin', 'name', { wide: true }), / [0-9A-F]{12}$/);
    assert.equal(fakeValue('Bordeaux', 'city', { maxLength: 4 }).length, 4);
    assert.equal(fakeValue('alice@company.fr', 'partial'), '***ce@company.fr');
    assert.equal(fakeValue('0612345678', 'partial'), '********78');
    assert.match(fakeValue('FR7630006000011234567890189', 'secret'), /^XXXX[0-9A-F]{8}$/);
    const many = new Set(Array.from({ length: 300 }, (_, i) => fakeValue(`user${i}@x.io`, 'email', { wide: true })));
    assert.equal(many.size, 300);
  });

  test('fake values: numbers within 10 %, dates moved by 30 days at most or rounded down', () => {
    const { fakeValue } = fakes();
    for (const salary of [1000, 2500, 31999]) {
      const v = fakeValue(salary, 'noise', { type: 'integer' });
      assert.ok(Number.isInteger(v) && Math.abs(v - salary) <= salary * 0.1 + 1, `${salary} → ${v}`);
    }
    assert.match(fakeValue('1234.50', 'noise', { type: 'numeric' }), /^\d+\.\d{2}$/);
    assert.equal(fakeValue('1987-06-15', 'year', { type: 'date' }), '1987-01-01');
    assert.equal(fakeValue('1987-06-15 08:30:00', 'month', { type: 'timestamp without time zone' }), '1987-06-01 00:00:00');
    const shifted = fakeValue('2026-03-10 14:00:00', 'noise', { type: 'timestamp without time zone' });
    const days = Math.abs(Date.parse(shifted.replace(' ', 'T') + 'Z') - Date.parse('2026-03-10T14:00:00Z')) / 86400000;
    assert.ok(days <= 30 && shifted.endsWith('14:00:00'), shifted);
  });

  test('a MySQL CREATE TABLE read line by line: columns, indexes, foreign keys', () => {
    const ddl = [
      'CREATE TABLE `orders` (',
      '  `id` int NOT NULL AUTO_INCREMENT,',
      '  `customer_id` int NOT NULL,',
      "  `status` varchar(20) NOT NULL DEFAULT 'paid',",
      '  `odd``name` text,',
      '  PRIMARY KEY (`id`),',
      '  UNIQUE KEY `uniq_ref` (`customer_id`,`status`),',
      '  KEY `idx_status` (`status`),',
      '  FULLTEXT KEY `ft_name` (`odd``name`),',
      '  CONSTRAINT `orders_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE',
      ') ENGINE=InnoDB AUTO_INCREMENT=401 DEFAULT CHARSET=utf8mb4',
    ].join('\n');
    const parsed = copy().parseMysqlCreateTable(ddl);
    assert.deepEqual([...parsed.columns.keys()], ['id', 'customer_id', 'status', 'odd`name']);
    assert.equal(parsed.columns.get('status'), "`status` varchar(20) NOT NULL DEFAULT 'paid'");
    assert.deepEqual(parsed.indexes.map(i => [i.name, i.unique, i.columns.join('+')]), [['uniq_ref', true, 'customer_id+status'], ['idx_status', false, 'status'], ['ft_name', false, 'odd`name']]);
    assert.deepEqual(parsed.foreignKeys.map(f => [f.name, f.references, f.columns[0], f.refColumns[0]]), [['orders_ibfk_1', 'customers', 'customer_id', 'id']]);
  });

  test('views and triggers made portable: no DEFINER, no qualifier of the source database', () => {
    const view = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `paid` AS select `shop`.`orders`.`id` AS `id` from `shop`.`orders`';
    assert.equal(copy().portableMysql(view, 'shop'), 'CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `paid` AS select `orders`.`id` AS `id` from `orders`');
    assert.equal(copy().portableMysql("CREATE DEFINER=`app`@`localhost` TRIGGER `t` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.status = 'x'", 'shop'),
      "CREATE TRIGGER `t` BEFORE INSERT ON `orders` FOR EACH ROW SET NEW.status = 'x'");
  });
});

describe('DuckDB helpers (no duckdb tool needed)', () => {
  const duck = require(path.join(cwd, 'dist/shared/engines/duckdbCli.js'));

  test('values bound as literals, never inside strings, quoted names or comments', () => {
    assert.equal(duck.bindDuckdb("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? -- ?\n/* ? */", ["O'Brien", 3]),
      "SELECT * FROM t WHERE a = 'O''Brien' AND b = '?' AND \"c?\" = 3 -- ?\n/* ? */");
    assert.equal(duck.bindDuckdb('SELECT ?, ?, ?, ?', [null, true, 12n, new Uint8Array([0, 255])]), "SELECT NULL, TRUE, 12, '\\x00\\xFF'::BLOB");
    assert.equal(duck.duckdbLiteral('a\u0000b'), "'ab'");
    assert.throws(() => duck.bindDuckdb('SELECT ?', []), /Not enough values/);
  });

  test('its JSON output: one array per statement, large integers exact', () => {
    const out = duck.parseDuckdbJson('[{"n":9007199254740993,"s":"[x]"}]\n[{"m":1.5}]\n');
    assert.equal(out.length, 2);
    assert.equal(out[0][0].n, 9007199254740993n);
    assert.equal(out[0][0].s, '[x]');
    assert.equal(out[1][0].m, 1.5);
    assert.deepEqual(duck.parseDuckdbJson('  '), []);
  });

  test('arguments by version, errors, and the tool found on the PATH', () => {
    assert.deepEqual(duck.duckdbArgs('/x.duckdb', { readOnly: true, version: '2.0.1' }), ['-no-agent', '-json', '-bail', '-readonly', '/x.duckdb']);
    assert.deepEqual(duck.duckdbArgs('/x.duckdb', { version: '1.4.2' }), ['-json', '-bail', '/x.duckdb']);
    assert.equal(duck.duckdbVersionOf('v1.4.2 (Andium) 68d7555f68'), '1.4.2');
    assert.equal(duck.duckdbError('duckdb agent mode is on\nCatalog Error: Table x does not exist!\nDid you mean "y"?'), 'Catalog Error: Table x does not exist!');
    const dir = fs.mkdtempSync(path.join(tmp, 'bin-'));
    const name = process.platform === 'win32' ? 'duckdb.exe' : 'duckdb';
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(duck.findDuckdbTool({ PATH: dir }), path.join(dir, name));
  });

  test('read-only check of the DuckDB dialect: its reading statements, files and extensions refused', () => {
    for (const sql of ['SELECT 1', 'FROM orders', 'DESCRIBE orders', 'SUMMARIZE orders', 'PIVOT t ON y USING sum(v)', 'WITH a AS (SELECT 1) SELECT * FROM a']) {
      assert.equal(guard.readOnlyProblem(sql, 'duckdb'), null, sql);
    }
    for (const sql of ["COPY orders TO '/tmp/x.csv'", "ATTACH '/tmp/other.duckdb'", 'INSTALL httpfs', 'LOAD httpfs', 'CALL pragma_version()', "EXPORT DATABASE '/tmp/x'", 'DELETE FROM orders']) {
      assert.ok(guard.readOnlyProblem(sql, 'duckdb'), sql);
    }
    assert.equal(guard.quoteIdent('a"b', 'duckdb'), '"a""b"');
  });
});

describe('SQL Server helpers (no server needed)', () => {
  const ss = require(path.join(cwd, 'dist/shared/engines/sqlserverUri.js'));

  test('connection strings: sqlserver:// URLs, JDBC, ADO.NET (Azure), TLS as the drivers read it', () => {
    assert.deepEqual(ss.parseSqlServerUri('sqlserver://sa:p%40ss@db.local:14330/shop?encrypt=true&trustServerCertificate=true'),
      { host: 'db.local', port: 14330, user: 'sa', password: 'p@ss', database: 'shop', sslMode: 'require' });
    assert.equal(ss.parseSqlServerUri('mssql://u@h/db').sslMode, 'verify-full');
    assert.equal(ss.parseSqlServerUri('sqlserver://u@h/db?encrypt=false').sslMode, 'disable');
    assert.deepEqual(ss.parseSqlServerUri('jdbc:sqlserver://h.example.com:1433;databaseName=sales;user=app;password={a;b}};c};encrypt=true'),
      { host: 'h.example.com', port: 1433, user: 'app', password: 'a;b};c', database: 'sales', sslMode: 'verify-full' });
    assert.deepEqual(ss.parseSqlServerUri('Server=tcp:myserver.database.windows.net,1433;Initial Catalog=mydb;Persist Security Info=False;User ID=me;Password="x;y";Encrypt=True;TrustServerCertificate=False;'),
      { host: 'myserver.database.windows.net', port: 1433, user: 'me', password: 'x;y', database: 'mydb', sslMode: 'verify-full' });
    assert.equal(ss.parseSqlServerUri('Data Source=PC\\SQLEXPRESS;Database=d;UID=u;PWD=p').host, 'PC\\SQLEXPRESS');
    assert.equal(ss.parseSqlServerUri('mysql://u@h/db'), null);
    // A named instance: found through the Browser unless a port is given
    const named = ss.sqlserverConnection({ host: 'PC\\SQLEXPRESS', port: 1433, user: 'u', password: 'p', database: 'd' });
    assert.deepEqual([named.server, named.instanceName, named.port, named.encrypt, named.trustServerCertificate], ['PC', 'SQLEXPRESS', undefined, true, false]);
    const plain = ss.sqlserverConnection({ host: 'h', port: 1500, user: 'u', database: 'd', sslMode: 'disable' });
    assert.deepEqual([plain.port, plain.encrypt, plain.label], [1500, false, 'h:1500']);
    assert.equal(ss.sqlserverIdent('a]b'), '[a]]b]');
  });

  test('read-only T-SQL: statements without ";" and the words that change things are refused', () => {
    for (const sql of ['SELECT TOP (5) * FROM [orders] WHERE [update] = 1', "SELECT N'COMMIT; DROP' AS x", 'WITH a AS (SELECT 1 AS n) SELECT n FROM a', '(SELECT 1)']) {
      assert.equal(guard.readOnlyProblem(sql, 'tsql'), null, sql);
    }
    for (const sql of ['SELECT 1 AS x DELETE FROM t', 'SELECT 1 AS x COMMIT', 'SELECT * INTO #t FROM o', 'EXEC sp_who', 'SELECT * FROM OPENROWSET(BULK \'c:\\x\', SINGLE_CLOB) AS f', 'WAITFOR DELAY \'00:00:05\'', 'SELECT 1; SELECT 2']) {
      assert.ok(guard.readOnlyProblem(sql, 'tsql'), sql);
    }
    assert.equal(guard.replacePlaceholders("SELECT ?, '?', [a?] -- ?\n, ?", 'tsql', i => `@p${i + 1}`), "SELECT @p1, '?', [a?] -- ?\n, @p2");
    assert.equal(guard.quoteIdent('x]', 'tsql'), '[x]]]');
  });

  test('backup: what a table, an index and a column read become; modules after what they use; the file recognized', () => {
    const driver = require(path.join(cwd, 'dist/main/engines/sqlserver.js'));
    const table = driver.createTableSql({ t: 'table', schema: 'sales', name: 'kinds', identity: { last: '40' }, primaryKey: { name: 'pk', clustered: false, unique: true, constraint: 'primary', columns: [{ name: 'id', desc: false }], include: [], filter: null }, columns: [
      { name: 'id', type: 'bigint', base: 'bigint', nullable: false, collation: null, identity: { seed: '10', increment: '10' }, computed: null, default: null, rowguid: false, rowversion: false, sparse: false },
      { name: 'label', type: 'nvarchar(100)', base: 'nvarchar', nullable: true, collation: 'Latin1_General_CS_AS', identity: null, computed: null, default: { name: 'df', definition: "(N'x')" }, rowguid: false, rowversion: false, sparse: false },
      { name: 'twice', type: 'bigint', base: 'bigint', nullable: true, collation: null, identity: null, computed: { definition: '([id]*(2))', persisted: true }, default: null, rowguid: false, rowversion: false, sparse: false },
      { name: 'stamp', type: 'timestamp', base: 'timestamp', nullable: false, collation: null, identity: null, computed: null, default: null, rowguid: false, rowversion: true, sparse: false },
    ] });
    assert.equal(table, "CREATE TABLE [sales].[kinds] (\n  [id] bigint IDENTITY(10, 10) NOT NULL,\n  [label] nvarchar(100) COLLATE Latin1_General_CS_AS NULL CONSTRAINT [df] DEFAULT (N'x'),\n  [twice] AS ([id]*(2)) PERSISTED,\n  [stamp] rowversion NOT NULL,\n  CONSTRAINT [pk] PRIMARY KEY NONCLUSTERED ([id])\n)");
    assert.equal(driver.createIndexSql({ t: 'index', schema: 'dbo', table: 'orders', index: { name: 'by_status', clustered: false, unique: false, constraint: null, columns: [{ name: 'status', desc: true }], include: ['total'], filter: '([status] IS NOT NULL)' } }),
      'CREATE NONCLUSTERED INDEX [by_status] ON [dbo].[orders] ([status] DESC) INCLUDE ([total]) WHERE ([status] IS NOT NULL)');
    assert.equal(driver.dumpExpression({ name: 'at', base: 'datetime2' }), 'CONVERT(varchar(40), [at], 126)');
    assert.equal(driver.dumpExpression({ name: 'p', base: 'geography' }), 'CAST([p] AS varbinary(max))');
    assert.equal(driver.sqlserverTypeText('nvarchar', -1, 0, 0), 'nvarchar(max)');
    assert.equal(driver.sqlserverTypeText('nchar', 6, 0, 0), 'nchar(3)');
    assert.deepEqual(driver.orderModules([{ id: 3, trigger: true }, { id: 2, trigger: false }, { id: 1, trigger: false }], [[1, 2]]).map(m => m.id), [2, 1, 3]);
    assert.equal(driver.likeLiteral('50%_[x]'), '%50[%][_][[]x[]]%');
    assert.equal(driver.sqlserverVersionLabel('16.0.4135.4', 3), '2022 (16.0.4135.4)');
    const { archiveEngineOf, SQLSERVER_BACKUP_HEADER } = require(path.join(cwd, 'dist/main/backupFormat.js'));
    assert.equal(archiveEngineOf(zlib.gzipSync(`${SQLSERVER_BACKUP_HEADER},"version":1}\n`)), 'sqlserver');
  });
});

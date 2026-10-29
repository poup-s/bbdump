// SQL Server for real (BBDUMP_TEST_SQLSERVER=host:port of a throwaway server, user sa, password
// BBDUMP_TEST_SQLSERVER_PASSWORD; skipped otherwise): the explorer, read-only queries, the
// dashboards' examples, bbdump's own backup restored twice and into a new database (types,
// identities, sequences, computed columns, views, functions, procedures, triggers), a restore
// that fails leaving nothing changed, and the MCP server's reading tools.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();
const server = process.env.BBDUMP_TEST_SQLSERVER;
const password = process.env.BBDUMP_TEST_SQLSERVER_PASSWORD ?? '';
const [host, port] = (server ?? '127.0.0.1:1433').split(':');
const suffix = `${process.pid}_${Date.now()}`;
const name = `bbdump_ci_${suffix}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-sqlserver-live-'));

const load = (file) => {
  const { transformSync } = require('esbuild');
  const full = path.join(root, file);
  const compiled = transformSync(fs.readFileSync(full, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  const localRequire = (id) => (id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(full), `${id}.ts`))) : require(id));
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, localRequire);
  return mod.exports;
};

const DAY = 86400000;
const now = Date.now();
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const SHOP = {
  customers: [[1, 'Alice', 'alice@example.com', 'Paris'], [2, 'Bruno', 'bruno@example.com', 'Lyon'], [3, 'a.b% (odd)', 'odd@example.com', 'Paris']],
  users: [[1, 'Alice Martin', 'alice@example.com', '0600000001', utc(now - 90 * DAY)], [2, 'Bruno Petit', 'bruno@example.com', null, utc(now - 60 * DAY)]],
  orders: Array.from({ length: 12 }, (_, i) => [i + 1, (i % 3) + 1, (i % 2) + 1, 10 + i, i % 3 === 0 ? 'cancelled' : 'paid', utc(now - (i < 8 ? i * 3 + 1 : 45 + i) * DAY)]),
};

/** Each string is one batch (CREATE VIEW, FUNCTION… must be alone in theirs) */
const SEED = [
  'CREATE TABLE customers (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(80), email NVARCHAR(120) NOT NULL UNIQUE, city NVARCHAR(40))',
  'CREATE TABLE users (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(80), email NVARCHAR(120), phone NVARCHAR(20), created_at DATETIME2)',
  `CREATE TABLE orders (id INT IDENTITY(1,1) PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, user_id INT,
     total DECIMAL(10,2), status NVARCHAR(20), created_at DATETIME2, CONSTRAINT orders_total_positive CHECK (total >= 0))`,
  'CREATE INDEX orders_by_status ON orders (status) INCLUDE (total) WHERE status IS NOT NULL',
  'CREATE SCHEMA sales',
  'CREATE SEQUENCE sales.ticket AS BIGINT START WITH 1000 INCREMENT BY 5',
  `CREATE TABLE sales.kinds (
     id BIGINT IDENTITY(10,10) PRIMARY KEY NONCLUSTERED, amount DECIMAL(18,4), price MONEY, at DATETIME2(7), at_tz DATETIMEOFFSET(7), day DATE,
     clock TIME(7), old DATETIME, small SMALLDATETIME, guid UNIQUEIDENTIFIER CONSTRAINT kinds_guid DEFAULT NEWID(), bytes VARBINARY(MAX),
     label NVARCHAR(100) COLLATE Latin1_General_CS_AS, flag BIT, ratio FLOAT, real_ REAL, place GEOGRAPHY, doc XML, big BIGINT, tiny TINYINT,
     txt VARCHAR(50), fixed NCHAR(3), twice AS (amount * 2) PERSISTED, stamp ROWVERSION)`,
  'CREATE TABLE sales.audit (id INT IDENTITY PRIMARY KEY, what NVARCHAR(50))',
  `INSERT INTO sales.kinds (amount, price, at, at_tz, day, clock, old, small, guid, bytes, label, flag, ratio, real_, place, doc, big, tiny, txt, fixed) VALUES
     (12345678901234.5678, 922337203685477.5807, '2026-10-29T15:53:50.1234567', '2026-10-29T15:53:50.1234567+02:00', '2026-10-29', '23:59:59.9999999',
      '2026-10-29T15:53:50.997', '2026-10-29T15:54:00', '6F9619FF-8B86-D011-B42D-00C04FC964FF', 0x00FF10, N'Zoé 🎉 Ünïcödé', 1, 0.1, 3.5,
      geography::Point(48.8566, 2.3522, 4326), '<a b="1">x</a>', 9007199254740993, 255, 'plain', N'abc')`,
  'INSERT INTO sales.kinds (label) VALUES (NULL)',
  "INSERT INTO sales.kinds (label) VALUES (N'gone')",
  // Its id (30) was given: the copy must not give it again
  "DELETE FROM sales.kinds WHERE label = N'gone'",
  'SELECT NEXT VALUE FOR sales.ticket',
  'SELECT NEXT VALUE FOR sales.ticket',
  'CREATE FUNCTION sales.double_it(@x INT) RETURNS INT AS BEGIN RETURN @x * 2 END',
  "CREATE VIEW sales.paid_orders AS SELECT id, sales.double_it(id) AS twice FROM dbo.orders WHERE status = 'paid'",
  'CREATE PROCEDURE sales.count_orders AS SELECT COUNT(*) AS n FROM dbo.orders',
  "CREATE TRIGGER sales.kinds_audit ON sales.kinds AFTER INSERT AS INSERT INTO sales.audit (what) SELECT 'kind' FROM inserted",
  "INSERT INTO sales.kinds (label) VALUES (N'after the trigger')",
];

/** Every column of sales.kinds as exact text: the same in the source and its copies */
const KINDS = `SELECT id, CONVERT(varchar(60), amount) AS a, CONVERT(varchar(60), price, 2) AS p, CONVERT(varchar(40), at, 126) AS t,
  CAST(at_tz AS varchar(50)) AS tz, DATEPART(tzoffset, at_tz) AS offset, CONVERT(varchar(10), day, 23) AS d, CONVERT(varchar(20), clock) AS c, CONVERT(varchar(40), old, 126) AS o,
  CONVERT(varchar(40), small, 126) AS s, CAST(guid AS char(36)) AS g, CONVERT(varchar(max), bytes, 1) AS b, label, flag, ratio, real_,
  place.STAsText() AS pl, place.STSrid AS srid, CONVERT(nvarchar(max), doc) AS x, CAST(big AS varchar(30)) AS big, tiny, txt, fixed,
  CONVERT(varchar(60), twice) AS tw FROM sales.kinds ORDER BY id`;

let mssql, registry, program, examples, cfg;
const ids = { source: 'ms1', copy: 'ms2' };

async function admin(statements, database = 'master') {
  const pool = await new mssql.ConnectionPool({ server: host, port: Number(port), user: 'sa', password, database, options: { encrypt: true, trustServerCertificate: true } }).connect();
  try {
    for (const sql of statements) await pool.request().batch(sql);
  } finally {
    await pool.close();
  }
}

describe('SQL Server for real', { skip: server ? false : 'BBDUMP_TEST_SQLSERVER is not set (host:port of a throwaway server)' }, () => {
  before(async () => {
    mssql = require(path.join(root, 'node_modules/mssql'));
    await admin([`CREATE DATABASE [${name}]`, `CREATE DATABASE [${name}_copy]`, `ALTER DATABASE [${name}] SET ALLOW_SNAPSHOT_ISOLATION ON`]);
    const seed = [...SEED];
    const identity = (table, rows, columns) => [
      `SET IDENTITY_INSERT ${table} ON`,
      ...rows.map(r => `INSERT INTO ${table} (${columns}) VALUES (${r.map(v => (v === null ? 'NULL' : typeof v === 'number' ? v : `N'${String(v).replace(/'/g, "''")}'`)).join(', ')})`),
      `SET IDENTITY_INSERT ${table} OFF`,
    ].join('\n');
    seed.splice(4, 0,
      identity('customers', SHOP.customers, 'id, name, email, city'),
      identity('users', SHOP.users, 'id, name, email, phone, created_at'),
      identity('orders', SHOP.orders, 'id, customer_id, user_id, total, status, created_at'));
    await admin(seed, name);
    await admin(['CREATE TABLE leftover (id INT)'], `${name}_copy`);

    process.chdir(tmp);
    const base = { cron: '0 0 * * *', output: tmp, encrypted: false, engine: 'sqlserver', host, port: Number(port), user: 'sa', password, sslMode: 'require' };
    fs.writeFileSync('config.json', JSON.stringify({ databases: [
      { ...base, id: ids.source, name },
      { ...base, id: ids.copy, name: `${name}_copy` },
    ] }));
    require('./electronStub.cjs');
    cfg = require(path.join(root, 'dist/main/ipc/configIpc.js'));
    cfg.loadConfig();
    registry = require(path.join(root, 'dist/main/engines/registry.js'));
    program = load('src/renderer/src/dashboards/dashboardProgram.ts');
    examples = load('src/renderer/src/dashboards/sqlDashboard.ts');
  });

  after(async () => {
    await require(path.join(root, 'dist/main/engines/sqlserver.js')).closeSqlServerPools();
    for (const db of [name, `${name}_copy`, `${name}_new`, `${name}_broken`]) {
      await admin([`IF DB_ID(N'${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`]).catch(() => {});
    }
    process.chdir(root);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('connection test: the version and the tables', async () => {
    const connection = await registry.facetFor('sqlserver', 'connection.test', 'connection');
    const result = await connection.test({ host, port: Number(port), user: 'sa', password, database: name, sslMode: 'require' });
    assert.match(result.version, /^20\d\d \(\d+\./);
    assert.equal(result.tables, 5);
    // A certificate that is not trusted, verified: refused with what to choose
    await assert.rejects(connection.test({ host, port: Number(port), user: 'sa', password, database: name, sslMode: 'verify-full' }), /TrustServerCertificate|certificate/i);
  });

  test('explorer: schemas, tables with exact counts, columns, keys, a sorted page, an edit rolled back on failure', async () => {
    const catalog = await registry.facetForDb(ids.source, 'explorer.browse', 'catalog');
    const records = await registry.facetForDb(ids.source, 'explorer.browse', 'records');
    const edit = await registry.facetForDb(ids.source, 'explorer.edit', 'records');
    assert.deepEqual((await catalog.listNamespaces(ids.source)).schemas.map(s => s.name), ['dbo', 'sales']);
    assert.deepEqual((await catalog.listEntities(ids.source, 'dbo')).tables.map(t => `${t.name}:${t.row_count}`), ['customers:3', 'orders:12', 'users:2']);
    const orders = await catalog.describeEntity(ids.source, { schema: 'dbo', table: 'orders' });
    const fk = orders.columns.find(c => c.column_name === 'customer_id');
    assert.deepEqual([fk.is_foreign, fk.foreign_key.table], [true, 'customers']);
    assert.equal(orders.columns.find(c => c.column_name === 'id').is_identity, 'YES');
    const kinds = await catalog.describeEntity(ids.source, { schema: 'sales', table: 'kinds' });
    assert.equal(kinds.columns.find(c => c.column_name === 'twice').is_generated, 'ALWAYS');
    assert.equal(kinds.columns.find(c => c.column_name === 'flag').udt_name, 'bool');
    assert.equal(kinds.columns.find(c => c.column_name === 'at').data_type, 'datetime2(7)');
    const page = await records.page(ids.source, { schema: 'dbo', table: 'customers', limit: 2, sortBy: 'email', sortOrder: 'desc' });
    assert.deepEqual([page.rows[0].email, page.total, page.hasMore], ['odd@example.com', 3, true]);
    // % is text in a search, never a pattern
    assert.equal((await records.page(ids.source, { schema: 'dbo', table: 'customers', limit: 10, search: '%' })).total, 1);
    const failed = await edit.update(ids.source, { schema: 'dbo', table: 'customers', changes: [
      { rowId: 1, primaryKeyColumn: 'id', column: 'name', oldValue: 'Alice', newValue: 'changed' },
      { rowId: 1, primaryKeyColumn: 'id', column: 'email', oldValue: 'alice@example.com', newValue: null },
    ] });
    assert.equal(failed.success, false);
    assert.equal((await records.lookup(ids.source, { schema: 'dbo', table: 'customers', column: 'id', value: 1 })).row.name, 'Alice');
    const full = await catalog.fullSchema(ids.source);
    assert.ok(full.foreignKeys.some(k => k.source_table === 'orders' && k.target_table === 'customers'));
  });

  test('read-only queries: one reading statement, rolled back, capped and timed', async () => {
    const query = await registry.facetForDb(ids.source, 'explorer.query', 'query');
    const result = await query.run(ids.source, { sql: 'SELECT COUNT(*) AS n FROM orders WHERE total > ?', values: [15], timeoutMs: 5000 });
    assert.equal(Number(result.rows[0].n), 6);
    for (const sql of ['DELETE FROM orders', 'DROP TABLE orders', 'SELECT 1 AS x DELETE FROM orders', 'SELECT 1 AS x; DELETE FROM orders', 'SELECT * INTO #copy FROM orders', 'EXEC sales.count_orders']) {
      await assert.rejects(query.run(ids.source, { sql }), /allowed|statement/, sql);
    }
    const capped = await query.run(ids.source, { sql: 'SELECT a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b', maxRows: 25 });
    assert.deepEqual([capped.rows.length, capped.truncated], [25, true]);
    const started = Date.now();
    await assert.rejects(
      // A recursion the server cannot shortcut (it counts a cross join of catalogs at once)
      query.run(ids.source, { sql: 'WITH c AS (SELECT CAST(1 AS bigint) AS x UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT COUNT_BIG(*) AS n FROM c OPTION (MAXRECURSION 0)', timeoutMs: 1500 }),
      /stopped/);
    assert.ok(Date.now() - started < 6000, `${Date.now() - started} ms`);
    assert.equal(Number((await query.run(ids.source, { sql: 'SELECT COUNT(*) AS n FROM orders' })).rows[0].n), 12);
  });

  test('dashboards: the example queries given to the AI, with their filters', async () => {
    const query = await registry.facetForDb(ids.source, 'explorer.query', 'query');
    const run = async (source, block, values) => {
      const match = source.match(new RegExp(`^${block} = Query\\("sqlserver", \\{query: ("(?:[^"\\\\]|\\\\.)*")\\}`, 'm'));
      assert.ok(match, block);
      const { text, params } = program.bindSqlParams(JSON.parse(match[1]), values);
      return program.toQueryResult(await query.run(ids.source, { sql: text, values: params, maxRows: 1000, timeoutMs: 10000 }));
    };
    const example = examples.SQLSERVER_EXAMPLE;
    const linked = examples.SQLSERVER_EXAMPLE_LINKED;
    const all = { from: '-infinity', to: 'infinity', city: null };
    assert.deepEqual((await run(example, 'cities', all)).rows, [{ value: 'Lyon' }, { value: 'Paris' }]);
    const totals = (await run(example, 'totals', all)).rows[0];
    assert.deepEqual([Number(totals.orders), Number(totals.revenue)], [12, 186]);
    assert.equal(Number((await run(example, 'totals', { ...all, city: 'Paris' })).rows[0].orders), 8);
    const month = program.periodRange('30d', new Date(now));
    assert.equal(Number((await run(example, 'totals', { ...month, city: null })).rows[0].orders), 8);
    const weeks = await run(example, 'perWeek', all);
    assert.deepEqual(weeks.columns, ['week', 'paid', 'cancelled']);
    assert.equal(weeks.rows.reduce((n, r) => n + Number(r.paid) + Number(r.cancelled), 0), 12);
    assert.ok(weeks.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.week))), JSON.stringify(weeks.rows[0]));
    assert.equal((await run(example, 'recent', all)).rows.length, 12);
    assert.deepEqual((await run(linked, 'users', { q: 'alice' })).rows.map(r => r.name), ['Alice Martin']);
    assert.equal((await run(linked, 'users', { q: null })).rows.length, 2);
    assert.equal(Number((await run(linked, 'picked', { user: '1' })).rows[0].orders), 6);
    assert.equal((await run(linked, 'theirOrders', { user: '2' })).rows.length, 6);
  });

  let dumped;
  test('backup restored into another database, twice: types, identities, sequences, modules and triggers come back', async () => {
    const config = cfg.getConfig();
    const backup = await registry.facetForDb(ids.source, 'backup.run', 'backup');
    const restore = await registry.facetForDb(ids.copy, 'restore.replace', 'restore');
    dumped = await backup.dump(config.databases.find(d => d.id === ids.source));
    assert.equal(dumped.success, true, dumped.error);
    const { readArchiveEngine } = require(path.join(root, 'dist/main/backupFormat.js'));
    assert.equal(readArchiveEngine(dumped.filePath), 'sqlserver');
    assert.ok(!zlib.gunzipSync(fs.readFileSync(dumped.filePath)).toString().includes(password));
    const target = config.databases.find(d => d.id === ids.copy);
    const records = await registry.facetForDb(ids.copy, 'explorer.browse', 'records');
    for (let round = 0; round < 2; round++) {
      const restored = await restore.restore(dumped.filePath, target, { replace: true });
      assert.equal(restored.success, true, restored.error);
      assert.equal((await records.count(ids.copy, { schema: 'dbo', table: 'orders' })).count, 12);
    }
    const source = await registry.facetForDb(ids.source, 'explorer.query', 'query');
    const copy = await registry.facetForDb(ids.copy, 'explorer.query', 'query');
    const rows = async (facet, id, sql) => (await facet.run(id, { sql })).rows;
    // Every value exactly (decimals, money, dates to 100 ns, offsets, GUIDs, bytes, emoji, geography, XML, 2^53 + 1)
    assert.deepEqual(await rows(copy, ids.copy, KINDS), await rows(source, ids.source, KINDS));
    assert.equal((await rows(copy, ids.copy, KINDS))[0].big, '9007199254740993');
    const one = async (sql) => (await rows(copy, ids.copy, sql))[0];
    assert.equal((await one("SELECT collation_name AS c FROM sys.columns WHERE object_id = OBJECT_ID('sales.kinds') AND name = 'label'")).c, 'Latin1_General_CS_AS');
    // The leftover table is gone; tables, views, functions, procedures, triggers, the sequence, the check, the filtered index
    assert.equal((await one("SELECT COUNT(*) AS n FROM sys.tables WHERE name = 'leftover'")).n, 0);
    const objects = "SELECT RTRIM(type) AS type, COUNT(*) AS n FROM sys.objects WHERE is_ms_shipped = 0 AND type IN ('U', 'V', 'FN', 'P', 'TR', 'SO', 'C', 'F') GROUP BY type ORDER BY type";
    assert.deepEqual(await rows(copy, ids.copy, objects), await rows(source, ids.source, objects));
    assert.equal((await one("SELECT filter_definition AS f FROM sys.indexes WHERE name = 'orders_by_status'")).f, '([status] IS NOT NULL)');
    assert.equal((await one("SELECT delete_referential_action_desc AS d FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID('dbo.orders')")).d, 'CASCADE');
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM sales.paid_orders')).n), 8);
    // The trigger came after the rows: it did not fire during the restore
    assert.equal(Number((await one('SELECT COUNT(*) AS n FROM sales.audit')).n), 1);
    // Identity and sequence go on where the source was (30 and 1005 were given there)
    assert.equal(Number((await one("SELECT IDENT_CURRENT('sales.kinds') AS n")).n), Number((await rows(source, ids.source, "SELECT IDENT_CURRENT('sales.kinds') AS n"))[0].n));
    const next = await copy.runMutation(ids.copy, { sql: 'SELECT NEXT VALUE FOR sales.ticket AS n' });
    assert.equal(Number(next.rows[0].n), 1010);
  });

  test('a restore that fails halfway changes nothing (one transaction)', async () => {
    // A backup that reads well but holds a view that cannot be created
    const lines = zlib.gunzipSync(fs.readFileSync(dumped.filePath)).toString().split('\n');
    const at = lines.findIndex(l => l.includes('"t":"module"') && l.includes('paid_orders'));
    const module = JSON.parse(lines[at]);
    module.definition = 'CREATE VIEW sales.paid_orders AS SELECT nothing FROM dbo.nowhere';
    lines[at] = JSON.stringify(module);
    const bad = path.join(tmp, 'bad.backup');
    fs.writeFileSync(bad, zlib.gzipSync(lines.join('\n')));
    const restore = await registry.facetForDb(ids.copy, 'restore.replace', 'restore');
    const result = await restore.restore(bad, cfg.getConfig().databases.find(d => d.id === ids.copy), { replace: true });
    assert.equal(result.success, false);
    assert.match(result.error, /nothing was changed/);
    const copy = await registry.facetForDb(ids.copy, 'explorer.query', 'query');
    assert.equal(Number((await copy.run(ids.copy, { sql: 'SELECT COUNT(*) AS n FROM sales.paid_orders' })).rows[0].n), 8);
    // A cut backup is refused before anything
    const cut = path.join(tmp, 'cut.backup');
    fs.writeFileSync(cut, fs.readFileSync(dumped.filePath).subarray(0, 300));
    const refused = await restore.restore(cut, cfg.getConfig().databases.find(d => d.id === ids.copy), { replace: true });
    assert.match(refused.error, /cannot be restored/);
  });

  test('backup restored into a new database, saved in bbdump; a failed one leaves nothing', async () => {
    const { restoreToNewDatabase } = require(path.join(root, 'dist/main/restoreToNew.js'));
    const before = cfg.getConfig().databases.length;
    const result = await restoreToNewDatabase({ backupFile: dumped.filePath, serverOf: ids.source, name: `${name}_new` });
    assert.equal(result.success, true, result.error);
    const saved = cfg.getConfig().databases.find(d => d.id === result.id);
    assert.deepEqual([saved.engine, saved.enabled, saved.connectionString], ['sqlserver', false, undefined]);
    const records = await registry.facetForDb(result.id, 'explorer.browse', 'records');
    assert.equal((await records.count(result.id, { schema: 'dbo', table: 'orders' })).count, 12);
    const again = await restoreToNewDatabase({ backupFile: dumped.filePath, serverOf: ids.source, name: `${name}_new` });
    assert.match(again.error, /already saved|already exists/);
    const broken = path.join(tmp, 'broken.backup');
    fs.writeFileSync(broken, fs.readFileSync(dumped.filePath).subarray(0, 200));
    const failed = await restoreToNewDatabase({ backupFile: broken, serverOf: ids.source, name: `${name}_broken` });
    assert.equal(failed.success, false);
    assert.equal(cfg.getConfig().databases.length, before + 1);
    const query = await registry.facetForDb(ids.source, 'explorer.query', 'query');
    assert.equal((await query.run(ids.source, { sql: `SELECT DB_ID(N'${name}_broken') AS id` })).rows[0].id, null);
  });

  const mcpBuilt = fs.existsSync(path.join(root, 'mcp-postgres', 'build', 'sql', 'client.js'));
  test('MCP server: tables, keys, read-only queries; changes refused', { skip: mcpBuilt ? false : 'mcp-postgres is not built (npm run build:mcp)' }, async () => {
    const saved = process.env.BBDUMP_CONFIG_PATH;
    process.env.BBDUMP_CONFIG_PATH = path.join(tmp, 'config.json');
    const mcp = (file) => import(pathToFileURL(path.join(root, 'mcp-postgres', 'build', file)).href);
    const client = await mcp('sql/client.js');
    const catalog = await mcp('sql/catalog.js');
    try {
      const info = await client.useSql({ id: ids.source, label: name, engine: 'sqlserver', target: { host, port: Number(port), user: 'sa', password, database: name, sslMode: 'require' } });
      assert.equal(info.tables, 5);
      const listed = await catalog.listTables();
      assert.deepEqual(listed.tables.map(t => `${t.name}:${t.rows}`), ['customers:3', 'orders:12', 'users:2', 'sales.audit:1', 'sales.kinds:3']);
      assert.deepEqual(listed.views, ['sales.paid_orders']);
      const orders = await catalog.describeTable('orders');
      assert.deepEqual(orders.primary_key, ['id']);
      assert.deepEqual(orders.foreign_keys.map(k => [k.columns, k.table, k.on_delete]), [[['customer_id'], 'customers', 'CASCADE']]);
      assert.deepEqual((await catalog.describeTable('customers')).referenced_by.map(k => k.table), ['orders']);
      const read = await client.readQuery('SELECT TOP (2) id, name FROM customers WHERE city = ? ORDER BY id', ['Paris'], { maxRows: 10 });
      assert.deepEqual(read.rows.map(r => r.name), ['Alice', 'a.b% (odd)']);
      await assert.rejects(client.readQuery('SELECT 1 AS x DELETE FROM orders'), /allowed/);
      assert.throws(() => client.sqlActive('mcp.write'), /read-only/);
      assert.ok((await client.explainSqlServer('SELECT * FROM orders WHERE id = 1')).rows.length > 0);
    } finally {
      // An open pool keeps the process alive
      await client.clearSql();
      if (saved === undefined) delete process.env.BBDUMP_CONFIG_PATH;
      else process.env.BBDUMP_CONFIG_PATH = saved;
    }
  });
});

// MySQL, MariaDB and SQLite for real: the explorer's facets, read-only queries, the dashboards'
// example queries, backups restored into another database. SQLite always runs (a file); MySQL /
// MariaDB run when BBDUMP_TEST_MYSQL / BBDUMP_TEST_MARIADB give host:port of a throwaway server
// (user root, password BBDUMP_TEST_MYSQL_PASSWORD). Backups need the dump tools in the PATH
// (BBDUMP_TEST_SQL_TOOLS=required makes their absence a failure, as in the CI).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = process.cwd();
const suffix = `${process.pid}_${Date.now()}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-sql-live-'));
const password = process.env.BBDUMP_TEST_MYSQL_PASSWORD ?? '';
const hasTool = (...names) => names.some(name => { try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const toolsRequired = process.env.BBDUMP_TEST_SQL_TOOLS === 'required';

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

const DAY = 86400000;
const now = Date.now();
/** "2026-10-28 09:30:00" in UTC, how the dashboards' filters compare dates */
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The same small shop in every engine: 3 customers in 2 cities, 12 orders (8 in the last 30 days) */
const SHOP = {
  customers: [[1, 'Alice', 'alice@example.com', 'Paris'], [2, 'Bruno', 'bruno@example.com', 'Lyon'], [3, 'a.b% (odd)', 'odd@example.com', 'Paris']],
  users: [[1, 'Alice Martin', 'alice@example.com', '0600000001', utc(now - 90 * DAY)], [2, 'Bruno Petit', 'bruno@example.com', null, utc(now - 60 * DAY)]],
  orders: Array.from({ length: 12 }, (_, i) => [i + 1, (i % 3) + 1, (i % 2) + 1, 10 + i, i % 3 === 0 ? 'cancelled' : 'paid', utc(now - (i < 8 ? i * 3 + 1 : 45 + i) * DAY)]),
};
const schemaSql = (auto, datetime) => [
  `CREATE TABLE customers (id INTEGER PRIMARY KEY ${auto}, name VARCHAR(80), email VARCHAR(120) NOT NULL UNIQUE, city VARCHAR(40))`,
  `CREATE TABLE users (id INTEGER PRIMARY KEY ${auto}, name VARCHAR(80), email VARCHAR(120), phone VARCHAR(20), created_at ${datetime})`,
  `CREATE TABLE orders (id INTEGER PRIMARY KEY ${auto}, customer_id INTEGER NOT NULL, user_id INTEGER, total DECIMAL(10,2), status VARCHAR(20), created_at ${datetime}, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
];
const seedStatements = () => [
  ...SHOP.customers.map(r => ['INSERT INTO customers (id, name, email, city) VALUES (?, ?, ?, ?)', r]),
  ...SHOP.users.map(r => ['INSERT INTO users (id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?)', r]),
  ...SHOP.orders.map(r => ['INSERT INTO orders (id, customer_id, user_id, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', r]),
];

let registry, program, examples;
const engines = [];
before(() => {
  process.chdir(tmp);
  const databases = [];
  const sqliteFile = path.join(tmp, 'shop.sqlite');
  const sqliteCopy = path.join(tmp, 'copy.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(sqliteFile);
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of schemaSql('', 'TEXT')) db.exec(sql);
  for (const [sql, values] of seedStatements()) db.prepare(sql).run(...values);
  db.close();
  new DatabaseSync(sqliteCopy).close();
  const base = { cron: '0 0 * * *', output: tmp, encrypted: false, user: '', password: '' };
  databases.push({ ...base, id: 's1', engine: 'sqlite', name: 'shop', host: '', port: 0, sqlite: { path: sqliteFile } });
  databases.push({ ...base, id: 's2', engine: 'sqlite', name: 'copy', host: '', port: 0, sqlite: { path: sqliteCopy } });
  engines.push({ id: 's1', copy: 's2', engine: 'sqlite', label: 'SQLite' });
  for (const [engine, env] of [['mysql', 'BBDUMP_TEST_MYSQL'], ['mariadb', 'BBDUMP_TEST_MARIADB']]) {
    const server = process.env[env];
    if (!server) continue;
    const [host, port] = server.split(':');
    const name = `bbdump_ci_${suffix}`;
    databases.push({ ...base, id: `${engine}1`, engine, name, host, port: Number(port), user: 'root', password });
    databases.push({ ...base, id: `${engine}2`, engine, name: `${name}_copy`, host, port: Number(port), user: 'root', password });
    engines.push({ id: `${engine}1`, copy: `${engine}2`, engine, label: engine === 'mysql' ? 'MySQL' : 'MariaDB', host, port: Number(port), name });
  }
  fs.writeFileSync('config.json', JSON.stringify({ databases }));
  require('./electronStub.cjs');
  require(path.join(root, 'dist/main/ipc/configIpc.js')).loadConfig();
  registry = require(path.join(root, 'dist/main/engines/registry.js'));
  program = load('src/renderer/src/dashboards/dashboardProgram.ts');
  examples = load('src/renderer/src/dashboards/sqlDashboard.ts');
});

after(async () => {
  const mysql = require(path.join(root, 'node_modules/mysql2/promise'));
  for (const e of engines.filter(x => x.host)) {
    const c = await mysql.createConnection({ host: e.host, port: e.port, user: 'root', password }).catch(() => null);
    if (!c) continue;
    await c.query(`DROP DATABASE IF EXISTS \`${e.name}\``).catch(() => {});
    await c.query(`DROP DATABASE IF EXISTS \`${e.name}_copy\``).catch(() => {});
    await c.end();
  }
  await require(path.join(root, 'dist/main/engines/mysql.js')).closeMysqlPools();
  process.chdir(root);
});
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/** Creates and fills a MySQL / MariaDB database for an engine entry */
async function seedServer(e) {
  const mysql = require(path.join(root, 'node_modules/mysql2/promise'));
  const c = await mysql.createConnection({ host: e.host, port: e.port, user: 'root', password, multipleStatements: true });
  await c.query(`CREATE DATABASE \`${e.name}\`; CREATE DATABASE \`${e.name}_copy\`; USE \`${e.name}\`;`);
  for (const sql of schemaSql('AUTO_INCREMENT', 'DATETIME')) await c.query(sql);
  for (const [sql, values] of seedStatements()) await c.query(sql, values);
  // Something in the copy the restore must replace
  await c.query(`CREATE TABLE \`${e.name}_copy\`.leftover (id INT)`);
  await c.end();
}

const toolsFor = (e) => (e.engine === 'sqlite' ? true : hasTool(e.engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump', 'mysqldump', 'mariadb-dump'));

for (const label of ['SQLite', 'MySQL', 'MariaDB']) {
  const env = label === 'MySQL' ? 'BBDUMP_TEST_MYSQL' : label === 'MariaDB' ? 'BBDUMP_TEST_MARIADB' : null;
  const skip = env && !process.env[env] ? `${env} is not set (host:port of a throwaway server)` : false;

  describe(`${label} for real`, { skip }, () => {
    let e;
    before(async () => {
      e = engines.find(x => x.label === label);
      if (e.host) await seedServer(e);
    });

    test('explorer: tables with exact counts, columns, keys, a sorted page, an edit rolled back on failure', async () => {
      const catalog = await registry.facetForDb(e.id, 'explorer.browse', 'catalog');
      const records = await registry.facetForDb(e.id, 'explorer.browse', 'records');
      const edit = await registry.facetForDb(e.id, 'explorer.edit', 'records');
      const schema = (await catalog.listNamespaces(e.id)).schemas[0].name;
      const tables = (await catalog.listEntities(e.id, schema)).tables;
      assert.deepEqual(tables.map(t => `${t.name}:${t.row_count}`), ['customers:3', 'orders:12', 'users:2']);
      const orders = await catalog.describeEntity(e.id, { schema, table: 'orders' });
      const fk = orders.columns.find(c => c.column_name === 'customer_id');
      assert.deepEqual([fk.is_foreign, fk.foreign_key.table], [true, 'customers']);
      assert.equal(orders.columns.find(c => c.column_name === 'id').is_identity, 'YES');
      const page = await records.page(e.id, { schema, table: 'customers', limit: 2, sortBy: 'email', sortOrder: 'desc' });
      assert.deepEqual([page.rows[0].email, page.total, page.hasMore], ['odd@example.com', 3, true]);
      assert.equal((await records.page(e.id, { schema, table: 'customers', limit: 10, search: '%' })).total, 1);
      const failed = await edit.update(e.id, { schema, table: 'customers', changes: [
        { rowId: 1, primaryKeyColumn: 'id', column: 'name', oldValue: 'Alice', newValue: 'changed' },
        { rowId: 1, primaryKeyColumn: 'id', column: 'email', oldValue: 'alice@example.com', newValue: null },
      ] });
      assert.equal(failed.success, false);
      assert.equal((await records.lookup(e.id, { schema, table: 'customers', column: 'id', value: 1 })).row.name, 'Alice');
    });

    test('read-only queries: one reading statement, timed; writes refused before they run', async () => {
      const query = await registry.facetForDb(e.id, 'explorer.query', 'query');
      const result = await query.run(e.id, { sql: 'SELECT COUNT(*) AS n FROM orders WHERE total > ?', values: [15], timeoutMs: 5000 });
      assert.equal(Number(result.rows[0].n), 6);
      for (const sql of ['DELETE FROM orders', 'DROP TABLE orders', 'SELECT 1; DELETE FROM orders']) {
        await assert.rejects(query.run(e.id, { sql }), /allowed|statement/);
      }
      // Stopped at its time limit: an error, or (MySQL) SLEEP cut short, which then returns 1
      const slow = e.engine === 'sqlite'
        ? 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS s FROM c'
        : 'SELECT SLEEP(5) AS s FROM orders LIMIT 1';
      const started = Date.now();
      const outcome = await query.run(e.id, { sql: slow, timeoutMs: 800 }).then(r => r, error => error);
      assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
      assert.ok(outcome instanceof Error ? /stopped|interrupted|exceeded|timeout/i.test(outcome.message) : Number(outcome.rows[0].s) === 1, String(outcome?.message ?? JSON.stringify(outcome?.rows)));
      assert.equal(Number((await query.run(e.id, { sql: 'SELECT COUNT(*) AS n FROM orders' })).rows[0].n), 12);
    });

    test('dashboards: the example queries given to the AI, with their filters', async () => {
      const query = await registry.facetForDb(e.id, 'explorer.query', 'query');
      const example = e.engine === 'sqlite' ? examples.SQLITE_EXAMPLE : examples.MYSQL_EXAMPLE;
      const linked = e.engine === 'sqlite' ? examples.SQLITE_EXAMPLE_LINKED : examples.MYSQL_EXAMPLE_LINKED;
      const tool = e.engine === 'sqlite' ? 'sqlite' : 'mysql';
      const run = async (source, block, values) => {
        const match = source.match(new RegExp(`^${block} = Query\\("${tool}", \\{query: ("(?:[^"\\\\]|\\\\.)*")\\}`, 'm'));
        assert.ok(match, block);
        const { text, params } = program.bindSqlParams(JSON.parse(match[1]), values);
        return program.toQueryResult(await query.run(e.id, { sql: text, values: params, maxRows: 1000, timeoutMs: 10000 }));
      };
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
      // Search is text, never a pattern of the user
      assert.deepEqual((await run(linked, 'users', { q: 'alice' })).rows.map(r => r.name), ['Alice Martin']);
      assert.equal((await run(linked, 'users', { q: null })).rows.length, 2);
      assert.equal(Number((await run(linked, 'picked', { user: '1' })).rows[0].orders), 6);
      assert.equal((await run(linked, 'theirOrders', { user: '2' })).rows.length, 6);
    });

    test('backup restored into another database, twice (replaces, no duplicate)', async (t) => {
      if (!toolsFor(e)) {
        if (toolsRequired) assert.fail('the dump tools are not in the PATH');
        t.skip('the dump tools are not in the PATH');
        return;
      }
      const config = require(path.join(root, 'dist/main/ipc/configIpc.js')).getConfig();
      const backup = await registry.facetForDb(e.id, 'backup.run', 'backup');
      const restore = await registry.facetForDb(e.copy, 'restore.replace', 'restore');
      const dumped = await backup.dump(config.databases.find(d => d.id === e.id));
      assert.equal(dumped.success, true, dumped.error);
      const { readArchiveEngine } = require(path.join(root, 'dist/main/backupFormat.js'));
      assert.equal(readArchiveEngine(dumped.filePath), e.engine);
      if (e.engine !== 'sqlite' && password) assert.ok(!zlib.gunzipSync(fs.readFileSync(dumped.filePath)).toString().includes(password));
      const target = config.databases.find(d => d.id === e.copy);
      const records = await registry.facetForDb(e.copy, 'explorer.browse', 'records');
      for (let round = 0; round < 2; round++) {
        const restored = await restore.restore(dumped.filePath, target, { replace: true });
        assert.equal(restored.success, true, restored.error);
        assert.equal((await records.count(e.copy, { table: 'orders' })).count, 12);
      }
      const catalog = await registry.facetForDb(e.copy, 'explorer.browse', 'catalog');
      const schema = (await catalog.listNamespaces(e.copy)).schemas[0].name;
      assert.deepEqual((await catalog.listEntities(e.copy, schema)).tables.map(x => x.name), ['customers', 'orders', 'users']);
    });
  });
}

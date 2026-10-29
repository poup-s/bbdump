// The local server installed for real by bbdump, on a machine without it: Linux (the
// distribution's packages, through BBDUMP_PKEXEC=sudo in place of pkexec) or Windows (winget).
// It installs software: only run on a throwaway machine (the CI). Skipped unless
// BBDUMP_TEST_LOCAL_INSTALL names the engine (mariadb, mysql, mongodb).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const engine = process.env.BBDUMP_TEST_LOCAL_INSTALL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-local-install-'));
const log = (line) => console.log(`  | ${line}`);

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
after(async () => {
  await require(path.join(root, 'dist/main/engines/mysql.js')).closeMysqlPools().catch(() => {});
  process.chdir(root);
});

/** Stops the installed server with the system's own tools (to check bbdump starts it again) */
function stopService() {
  if (process.platform === 'win32') execFileSync('net', ['stop', 'MongoDB'], { stdio: 'inherit' });
  else execFileSync('sudo', ['systemctl', 'stop', engine === 'mysql' ? 'mysql' : 'mariadb'], { stdio: 'inherit' });
}

describe(`local ${engine} server installed by bbdump`, { skip: engine ? false : 'BBDUMP_TEST_LOCAL_INSTALL is not set (it installs software)' }, () => {
  test('not there, installed, then ready: a database created, used and deleted', { timeout: 30 * 60 * 1000 }, async () => {
    const initial = await server.localServerState(engine);
    log(`before: ${JSON.stringify(initial)}`);
    assert.equal(initial.running, false, 'the machine must not run the server yet');
    assert.equal(initial.canInstall, true, `bbdump can install it here (${initial.installCommand})`);

    const installed = await server.installLocalServer(engine, log);
    assert.equal(installed.success, true, installed.error);

    const state = await server.localServerState(engine);
    log(`after: ${JSON.stringify(state)}`);
    assert.deepEqual([state.installed, state.running, state.answering, state.account], [true, true, engine, 'ready']);

    const name = `bbdump_install_${process.pid}`;
    const created = await server.createLocalEngineDatabase(engine, name);
    assert.equal(created.success, true, created.error);
    const entry = cfg.getConfig().databases.find(d => d.id === created.id);
    assert.deepEqual([entry.engine, entry.host, entry.isLocalBbdump], [engine, '127.0.0.1', true]);
    if (engine === 'mongodb') {
      const { MongoClient } = require(path.join(root, 'node_modules/mongodb'));
      const client = new MongoClient(`mongodb://127.0.0.1:${entry.port}/?directConnection=true`);
      await client.connect();
      await client.db(name).collection('items').insertOne({ a: 1 });
      assert.equal(await client.db(name).collection('items').countDocuments(), 1);
      await client.close();
    } else {
      // Through bbdump's own facets, with the account the install created
      assert.equal(entry.user, 'bbdump');
      const registry = require(path.join(root, 'dist/main/engines/registry.js'));
      const query = await registry.facetForDb(created.id, 'explorer.query', 'query');
      assert.deepEqual((await query.run(created.id, { sql: 'SELECT DATABASE() AS db' })).rows[0], { db: name });
    }
    const dropped = await server.dropLocalEngineDatabase(created.id);
    assert.equal(dropped.success, true, dropped.error);
  });

  test('stopped by the system, started again by bbdump', { timeout: 5 * 60 * 1000 }, async () => {
    stopService();
    const stopped = await server.localServerState(engine);
    assert.deepEqual([stopped.running, stopped.installed, stopped.canStart], [false, true, true]);
    const started = await server.startLocalServer(engine);
    assert.equal(started.success, true, started.error);
    assert.equal((await server.localServerState(engine)).account, 'ready');
  });
});

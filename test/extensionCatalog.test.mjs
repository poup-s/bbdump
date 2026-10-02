// Extension catalog: package commands and shared_preload_libraries handling.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const catalog = require(path.join(process.cwd(), 'dist/main/extensionCatalog.js'));
const format = require('pg-format');

describe('extension catalog', () => {
  test('names are unique', () => {
    const names = catalog.EXTENSION_CATALOG.map(entry => entry.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('third-party entries say how to get them; contrib ones ship with the server', () => {
    for (const entry of catalog.EXTENSION_CATALOG) {
      if (entry.contrib) {
        assert.ok(!entry.brew && !entry.apt && !entry.dnf, `${entry.name}: contrib has no package`);
      } else {
        assert.ok(entry.brew || entry.apt || entry.dnf, `${entry.name}: a package`);
        assert.ok(entry.homepage?.startsWith('https://'), `${entry.name}: a homepage`);
      }
    }
  });

  test('package commands follow each repository naming', () => {
    const vector = catalog.catalogEntry('vector');
    assert.equal(catalog.packageInstallCommand(vector, 'brew', 17), 'brew install pgvector');
    assert.equal(catalog.packageInstallCommand(vector, 'apt', 17), 'sudo apt install postgresql-17-pgvector');
    assert.equal(catalog.packageInstallCommand(vector, 'dnf', 18), 'sudo dnf install pgvector_18');
    assert.equal(catalog.packageInstallCommand(catalog.catalogEntry('postgis'), 'apt', 17), 'sudo apt install postgresql-17-postgis-3');
    assert.equal(catalog.packageInstallCommand(catalog.catalogEntry('pgaudit'), 'brew', 17), null);
    assert.equal(catalog.packageInstallCommand(vector, 'fedora', 16), 'sudo dnf install pgvector');
    assert.equal(catalog.packageInstallCommand(catalog.catalogEntry('ip4r'), 'fedora', 16), 'sudo dnf install postgresql-ip4r');
    assert.equal(catalog.packageInstallCommand(catalog.catalogEntry('pg_cron'), 'fedora', 16), null);
  });

  test('Linux root script: one package from the catalog, steps for the progress', () => {
    const script = catalog.linuxExtensionScript(catalog.catalogEntry('vector'), 'apt', 16);
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /set -euo pipefail/);
    assert.match(script, /apt-get -o DPkg::Lock::Timeout=120 install -y -q postgresql-16-pgvector\n/);
    assert.match(script, /step 100 /);
    assert.match(catalog.linuxExtensionScript(catalog.catalogEntry('vector'), 'dnf', 17), /dnf install -y pgvector_17\n/);
    assert.throws(() => catalog.linuxExtensionScript(catalog.catalogEntry('pg_cron'), 'fedora', 16), /No fedora package/);
    assert.throws(() => catalog.linuxExtensionScript({ name: 'x', category: 'other', apt: 'a; rm -rf /' }, 'apt', 16), /No apt package/);
  });
});

describe('shared_preload_libraries', () => {
  test('lists are parsed with their quotes', () => {
    assert.deepEqual(catalog.parseLibraryList(''), []);
    assert.deepEqual(catalog.parseLibraryList('pg_cron, pg_stat_statements'), ['pg_cron', 'pg_stat_statements']);
    assert.deepEqual(catalog.parseLibraryList('"pg_cron,pg_stat_statements"'), ['pg_cron,pg_stat_statements']);
    assert.deepEqual(catalog.parseLibraryList('a, "b c"'), ['a', 'b c']);
  });

  test('adding keeps the others, citus goes first', () => {
    assert.deepEqual(catalog.withPreloadLibrary(['pg_cron'], 'pg_stat_statements'), ['pg_cron', 'pg_stat_statements']);
    assert.deepEqual(catalog.withPreloadLibrary(['pg_cron'], 'pg_cron'), ['pg_cron']);
    assert.deepEqual(catalog.withPreloadLibrary(['pg_cron'], 'citus'), ['citus', 'pg_cron']);
  });

  test('ALTER SYSTEM gets one literal per library (one "a,b" string would stop the server)', () => {
    assert.equal(catalog.preloadLiterals(['pg_cron', 'pg_stat_statements'], format), "'pg_cron', 'pg_stat_statements'");
    assert.equal(catalog.preloadLiterals([], format), "''");
  });
});

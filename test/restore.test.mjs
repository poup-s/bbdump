// Restoring replaces the target's content: which schemas a backup holds, and emptying them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { schemasInToc, emptySchemasSql, restoreErrors } = require(path.join(process.cwd(), 'dist/main/restorePlan.js'));

// Excerpt of a real `pg_restore -l`
const LISTING = `;
; Archive created at 2026-10-01 20:38:59 UTC
;     dbname: appdb
;
; Selected TOC Entries:
;
6; 2615 16400 SCHEMA - billing app
2; 3079 16385 EXTENSION - pgcrypto
3456; 0 0 COMMENT - EXTENSION pgcrypto
218; 1259 16390 TABLE public customers app
217; 1259 16389 SEQUENCE public customers_id_seq app
3460; 0 0 SEQUENCE OWNED BY public customers_id_seq app
219; 1259 16401 TABLE billing invoices app
3434; 0 16390 TABLE DATA public customers app
3435; 0 16401 TABLE DATA billing invoices app
3461; 0 0 SEQUENCE SET public customers_id_seq app
3285; 2606 16401 CONSTRAINT public customers customers_pkey app
3286; 2606 16402 FK CONSTRAINT billing invoices invoices_customer_id_fkey app
220; 1259 16410 MATERIALIZED VIEW public monthly app
3470; 0 16410 MATERIALIZED VIEW DATA public monthly app
3480; 0 0 DEFAULT ACL - DEFAULT PRIVILEGES FOR TABLES app
`;

describe('schemas in a backup', () => {
  test('from objects and schema entries, without the system ones', () => {
    assert.deepEqual(schemasInToc(LISTING).sort(), ['billing', 'public']);
  });
  test('a schema created by the dump but still empty counts', () => {
    assert.deepEqual(schemasInToc('6; 2615 16400 SCHEMA - empty_one app\n'), ['empty_one']);
  });
  test('pg_catalog, information_schema and unknown lines are ignored', () => {
    assert.deepEqual(schemasInToc('5; 1255 1 FUNCTION pg_catalog f() app\n7; 0 0 WHATEVER x y z\n'), []);
  });
});

describe('emptying the target', () => {
  test('one transaction, stopping at the first error, every schema dropped', () => {
    const sql = emptySchemasSql(['public', 'billing']);
    const lines = sql.split('\n');
    assert.equal(lines[0], '\\set ON_ERROR_STOP on');
    assert.ok(lines.indexOf('BEGIN;') < lines.indexOf('DROP SCHEMA IF EXISTS "public" CASCADE;'));
    assert.ok(sql.includes('DROP SCHEMA IF EXISTS "billing" CASCADE;'));
    assert.ok(sql.includes('CREATE SCHEMA IF NOT EXISTS public;'));
    assert.ok(sql.trim().endsWith('COMMIT;'));
    assert.ok(sql.includes("lock_timeout = '15s'"));
  });
  test('public is recreated only when emptied; names are quoted', () => {
    const sql = emptySchemasSql(['we"ird']);
    assert.ok(sql.includes('DROP SCHEMA IF EXISTS "we""ird" CASCADE;'));
    assert.ok(!sql.includes('CREATE SCHEMA'));
  });
  test('nothing to empty, no script', () => {
    assert.equal(emptySchemasSql([]), '');
  });
});

test("pg_restore's errors are reported, not the summary line", () => {
  const stderr = [
    'pg_restore: processing data for table "public.orders"',
    'pg_restore: error: COPY failed for table "orders": ERROR:  duplicate key value violates unique constraint "orders_pkey"',
    'pg_restore: error: could not execute query: ERROR:  permission denied for schema auth',
    'pg_restore: warning: errors ignored on restore: 2',
  ].join('\n');
  const { count, lines } = restoreErrors(stderr);
  assert.equal(count, 2);
  assert.ok(lines[0].startsWith('error: COPY failed'));
});

// "Update from another database": schema diff and data-copy helpers (no database needed).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { diffSchemas } = require(path.join(process.cwd(), 'dist/main/sync/schemaDiff.js'));
const { anonymizationCandidates, dependencyOrder, timeColumn, anonymizedExpression } = require(path.join(process.cwd(), 'dist/main/sync/dataSync.js'));

const col = (name, type, extra = {}) => ({ name, type, notNull: false, default: null, identity: '', generated: false, ...extra });
const table = (schema, name, columns, extra = {}) => ({
  schema, name, key: `${schema}.${name}`, partitioned: false, partitionKey: null, estimate: 0, columns,
  primaryKey: null, constraints: [], indexes: [], triggers: [], comment: null, ...extra,
});
const catalog = (tables, extra = {}) => ({
  serverVersion: 170000, schemas: ['public'], extensions: [], enums: new Map(), sequences: new Set(),
  views: new Map(), functions: new Map(), tables: new Map(tables.map(t => [t.key, t])), ...extra,
});

const customers = table('public', 'customers', [
  col('id', 'integer', { notNull: true, default: "nextval('customers_id_seq'::regclass)" }),
  col('email', 'text', { notNull: true }),
], { primaryKey: ['id'], constraints: [{ name: 'customers_pkey', type: 'p', definition: 'PRIMARY KEY (id)', columns: ['id'], refColumns: [] }] });
const orders = table('public', 'orders', [
  col('id', 'bigint', { notNull: true, identity: 'a' }),
  col('customer_id', 'integer', { notNull: true }),
], {
  primaryKey: ['id'],
  constraints: [
    { name: 'orders_pkey', type: 'p', definition: 'PRIMARY KEY (id)', columns: ['id'], refColumns: [] },
    { name: 'orders_customer_id_fkey', type: 'f', definition: 'FOREIGN KEY (customer_id) REFERENCES customers(id)', references: 'public.customers', columns: ['customer_id'], refColumns: ['id'] },
  ],
});

describe('schema diff', () => {
  test('identical catalogs: nothing to do', () => {
    assert.deepEqual(diffSchemas(catalog([customers, orders]), catalog([customers, orders])), []);
  });

  test('new tables: sequence, CREATE TABLE, OWNED BY; foreign keys after every table', () => {
    const changes = diffSchemas(catalog([customers, orders]), catalog([]));
    const create = changes.find(c => c.id === 'table:public.customers');
    assert.deepEqual(create.sql[0], 'CREATE SEQUENCE IF NOT EXISTS customers_id_seq');
    assert.match(create.sql[1], /^CREATE TABLE public\.customers \(\n {2}id integer DEFAULT nextval\('customers_id_seq'::regclass\) NOT NULL,\n {2}email text NOT NULL,\n {2}CONSTRAINT customers_pkey PRIMARY KEY \(id\)\n\)$/);
    assert.equal(create.sql[2], 'ALTER SEQUENCE customers_id_seq OWNED BY public.customers.id');
    assert.match(changes.find(c => c.id === 'table:public.orders').sql[0], /id bigint GENERATED ALWAYS AS IDENTITY NOT NULL/);
    const fk = changes.find(c => c.kind === 'foreign_key');
    assert.ok(changes.indexOf(fk) > changes.findIndex(c => c.kind === 'table' && c.object === 'public.orders'), 'foreign keys come after the tables');
    assert.ok(changes.every(c => c.defaultSelected));
  });

  test('new NOT NULL column without default is added nullable, with a note', () => {
    const source = table('public', 'customers', [...customers.columns, col('country', 'text', { notNull: true })], { primaryKey: ['id'], constraints: customers.constraints });
    const [change] = diffSchemas(catalog([source]), catalog([customers]));
    assert.equal(change.sql.at(-1), 'ALTER TABLE public.customers ADD COLUMN country text');
    assert.equal(change.noteCode, 'added_nullable');
  });

  test('enum values keep their place; destructive changes are not selected', () => {
    const local = table('public', 'customers', [...customers.columns, col('legacy', 'boolean')], { primaryKey: ['id'], constraints: customers.constraints });
    const changes = diffSchemas(
      catalog([customers], { enums: new Map([['public.status', ['a', 'b', 'c']]]) }),
      catalog([local, table('public', 'scratch', [col('x', 'int')])], { enums: new Map([['public.status', ['a', 'c']]]) }),
    );
    assert.equal(changes.find(c => c.kind === 'enum_value').sql[0], "ALTER TYPE public.status ADD VALUE IF NOT EXISTS 'b' AFTER 'a'");
    for (const id of ['drop_column:public.customers.legacy', 'local_only_table:public.scratch']) {
      const change = changes.find(c => c.id === id);
      assert.equal(change.destructive, true);
      assert.equal(change.defaultSelected, false);
    }
  });
});

describe('data copy helpers', () => {
  test('personal data detected by column name; a product name is not a person', () => {
    const users = table('public', 'users', [col('id', 'integer'), col('email', 'citext'), col('first_name', 'text'), col('phone_number', 'varchar(20)'), col('name', 'text'), col('last_ip', 'inet'), col('age', 'integer')], { primaryKey: ['id'] });
    assert.deepEqual(anonymizationCandidates(users).map(c => `${c.column}:${c.kind}`), ['email:email', 'first_name:name', 'phone_number:phone', 'name:name', 'last_ip:ip']);
    assert.deepEqual(anonymizationCandidates(table('public', 'products', [col('sku', 'text'), col('name', 'text')], { primaryKey: ['sku'] })), []);
    assert.match(anonymizedExpression('email', 'email'), /^CASE WHEN t\.email IS NULL THEN NULL ELSE 'user_' \|\| left\(md5\(t\.email::text\), 12\) \|\| '@example\.com' END$/);
  });

  test('parents before children, cycles do not loop', () => {
    assert.deepEqual(dependencyOrder([orders, customers]).map(t => t.name), ['customers', 'orders']);
    const a = table('public', 'a', [], { constraints: [{ name: 'f', type: 'f', references: 'public.b', columns: [], refColumns: [], definition: '' }] });
    const b = table('public', 'b', [], { constraints: [{ name: 'f', type: 'f', references: 'public.a', columns: [], refColumns: [], definition: '' }] });
    assert.equal(dependencyOrder([a, b]).length, 2);
  });

  test('time column for "recent rows": created_at first', () => {
    assert.equal(timeColumn(table('public', 't', [col('updated_at', 'timestamp with time zone'), col('created_at', 'timestamp with time zone')])), 'created_at');
    assert.equal(timeColumn(table('public', 't', [col('issued_on', 'date')])), 'issued_on');
    assert.equal(timeColumn(table('public', 't', [col('label', 'text')])), undefined);
  });
});

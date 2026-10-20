// Anonymized duplicate: what can be replaced, what follows foreign keys, what gets emptied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { buildAnonymizePlan, emptiedTables, resolveAnonymization, columnLength, isUnique } = require(path.join(process.cwd(), 'dist/main/sync/anonymizedCopy.js'));
const { anonymizedExpression } = require(path.join(process.cwd(), 'dist/main/sync/dataSync.js'));

const col = (name, type = 'text', extra = {}) => ({ name, type, notNull: false, default: null, identity: '', generated: false, ...extra });
const table = (name, columns, extra = {}) => ({
  schema: 'public', name, key: `public.${name}`, partitioned: false, partitionKey: null, estimate: 10,
  columns, primaryKey: ['id'], constraints: [], indexes: [], triggers: [], comment: null, ...extra,
});
const fk = (columns, references, refColumns) => ({ name: 'fk', type: 'f', definition: '', references, columns, refColumns });

const users = table('users', [col('id', 'integer', { notNull: true }), col('email', 'character varying(40)', { notNull: true }), col('notes', 'jsonb'), col('age', 'integer', { notNull: true }), col('last_ip', 'inet')], {
  constraints: [{ name: 'users_email_key', type: 'u', definition: '', columns: ['email'], refColumns: [] }],
});
const orders = table('orders', [col('id', 'integer', { notNull: true }), col('user_id', 'integer'), col('contact_email', 'text')], {
  constraints: [fk(['user_id'], 'public.users', ['id']), fk(['contact_email'], 'public.users', ['email'])],
});
const sessions = table('sessions', [col('id', 'text', { notNull: true }), col('user_id', 'integer')], { constraints: [fk(['user_id'], 'public.users', ['id'])] });
const catalog = { tables: new Map([users, orders, sessions].map(t => [t.key, t])), sequences: new Set(), views: new Map() };
const plan = buildAnonymizePlan(catalog, new Map([['public.orders', 3]]));
const column = (t, c) => plan.tables.find(x => x.key === `public.${t}`).columns.find(x => x.name === c);

test('detected columns, and what each type can become', () => {
  assert.equal(column('users', 'email').detected, 'email');
  assert.deepEqual(column('users', 'notes').kinds, ['null']);
  // Not null: no NULL; a number: noise only
  assert.deepEqual(column('users', 'age').kinds, ['noise']);
  assert.deepEqual(column('users', 'last_ip').kinds, ['ip', 'null']);
  assert.equal(plan.tables.find(t => t.key === 'public.orders').rows, 3);
});

test('primary keys and columns tied to one cannot change', () => {
  assert.deepEqual(column('users', 'id').kinds, []);
  assert.deepEqual(column('orders', 'user_id').kinds, []);
});

test('a column follows the columns tied to it by a foreign key', () => {
  assert.deepEqual(column('users', 'email').linked, ['public.orders.contact_email']);
  const resolved = resolveAnonymization(plan, [{ table: 'public.users', column: 'email', kind: 'email' }]);
  assert.equal(resolved.get('public.orders.contact_email'), 'email');
  assert.throws(() => resolveAnonymization(plan, [{ table: 'public.users', column: 'id', kind: 'secret' }]), /cannot be anonymized/);
  assert.throws(() => resolveAnonymization(plan, [{ table: 'public.users', column: 'nope', kind: 'email' }]), /Unknown column/);
});

test('emptying a table empties the tables pointing to it; session tables are suggested', () => {
  assert.deepEqual([...emptiedTables(plan, ['public.users'])].sort(), ['public.orders', 'public.sessions', 'public.users']);
  assert.deepEqual([...emptiedTables(plan, ['public.sessions'])], ['public.sessions']);
  assert.deepEqual(plan.tables.filter(t => t.suggestEmpty).map(t => t.key), ['public.sessions']);
});

test('fakes fit the column and stay distinct on unique columns', () => {
  assert.equal(columnLength('character varying(40)'), 40);
  assert.equal(columnLength('text'), undefined);
  assert.equal(isUnique(users, 'email'), true);
  assert.equal(isUnique({ ...users, constraints: [], indexes: [{ name: 'i', definition: 'CREATE UNIQUE INDEX i ON public.users USING btree (lower(email), "phone")' }] }, 'phone'), true);
  assert.equal(isUnique(users, 'notes'), false);
  assert.match(anonymizedExpression('code', 'secret', 't', { maxLength: 12 }), /left\('XXXX' \|\| upper\(left\(md5\(t\.code::text\), 8\)\), 12\)/);
  assert.match(anonymizedExpression('phone', 'phone', 't', { wide: true }), /bit\(48\)/);
  assert.equal(anonymizedExpression('notes', 'null'), 'NULL');
});

test('a unique column and the columns pointing to it get the same distinct fakes', async () => {
  const { distinctFakes } = require(path.join(process.cwd(), 'dist/main/sync/anonymizedCopy.js'));
  assert.equal(distinctFakes(users, 'email'), true);
  assert.equal(distinctFakes(orders, 'contact_email'), true);
  assert.equal(distinctFakes(users, 'notes'), false);
  const a = anonymizedExpression('email', 'partial', 't', { wide: distinctFakes(users, 'email') });
  const b = anonymizedExpression('contact_email', 'partial', 't', { wide: distinctFakes(orders, 'contact_email') });
  assert.equal(a.replaceAll('email', 'X'), b.replaceAll('contact_email', 'X'));
});

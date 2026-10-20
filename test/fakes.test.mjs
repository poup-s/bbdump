// Realistic fakes, noise and rounding: the same lists and rules in the app (SQL) and the MCP server (JS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cwd = process.cwd();
const appLists = require(path.join(cwd, 'dist/main/sync/fakeData.js'));
const { anonymizationCandidates, anonymizedExpression, valueClass } = require(path.join(cwd, 'dist/main/sync/dataSync.js'));
const { buildAnonymizePlan } = require(path.join(cwd, 'dist/main/sync/anonymizedCopy.js'));
const mcpLists = await import(pathToFileURL(path.join(cwd, 'mcp-postgres/build/fakeData.js')).href);
const { fakeValue } = await import(pathToFileURL(path.join(cwd, 'mcp-postgres/build/masking.js')).href);

const col = (name, type = 'text', extra = {}) => ({ name, type, notNull: false, default: null, identity: '', generated: false, ...extra });
const table = (name, columns, extra = {}) => ({
  schema: 'public', name, key: `public.${name}`, partitioned: false, partitionKey: null, estimate: 10,
  columns, primaryKey: ['id'], constraints: [], indexes: [], triggers: [], comment: null, ...extra,
});

test('the app and the MCP server use the same word lists, safe in SQL and emails', () => {
  for (const name of ['FIRST_NAMES', 'LAST_NAMES', 'CITIES', 'STREETS']) {
    assert.deepEqual(mcpLists[name], appLists[name], name);
    for (const word of appLists[name]) assert.match(word, /^[A-Za-z ]+$/, `${name}: ${word}`);
  }
});

test('realistic fakes: the same value gives the same fake', () => {
  const name = fakeValue('Sebastien Poupineau', 'name');
  assert.equal(name, fakeValue('Sebastien Poupineau', 'name'));
  const [first, last] = name.split(' ');
  assert.ok(appLists.FIRST_NAMES.includes(first) && appLists.LAST_NAMES.includes(last), name);
  assert.ok(appLists.FIRST_NAMES.includes(fakeValue('Sebastien', 'first_name')));
  assert.ok(appLists.LAST_NAMES.includes(fakeValue('Poupineau', 'last_name')));
  assert.ok(appLists.CITIES.includes(fakeValue('Nantes', 'city')));
  assert.match(fakeValue('12 rue Réelle', 'address'), /^\d{1,3} [a-z]+ .+$/);
  assert.match(fakeValue('bob1234@email.fr', 'email'), /^[a-z]+\.[a-z]+\.[0-9a-f]{4}@example\.com$/);
});

test('noise: numbers within 10 %, decimals kept, dates within 30 days or rounded', () => {
  for (const v of [100, 4250, 37]) {
    const n = fakeValue(v, 'noise');
    assert.ok(Number.isInteger(n) && Math.abs(n - v) <= Math.ceil(v * 0.1), `${v} → ${n}`);
  }
  assert.match(fakeValue('1234.50', 'noise'), /^\d+\.\d{2}$/);
  const shifted = fakeValue('2024-05-15', 'noise');
  const days = Math.abs((new Date(`${shifted}T00:00:00`) - new Date('2024-05-15T00:00:00')) / 86400000);
  assert.ok(days <= 30, shifted);
  assert.equal(fakeValue('1984-07-23', 'year'), '1984-01-01');
  // A timestamp without time zone arrives as PostgreSQL writes it: its time part is kept
  assert.equal(fakeValue('2024-05-15 10:20:00', 'month'), '2024-05-01 00:00:00');
  assert.match(fakeValue('2024-05-15 10:20:00', 'noise'), /^\d{4}-\d{2}-\d{2} 10:20:00$/);
  const d = fakeValue(new Date(1984, 6, 23, 15), 'year');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [1984, 0, 1]);
  assert.equal(fakeValue(null, 'noise'), null);
});

test('detected: birth dates rounded to the year, salaries with noise, cities; never on a unique column', () => {
  const people = table('people', [
    col('id', 'integer'), col('birth_date', 'date'), col('salary', 'numeric(10,2)'), col('city', 'text'), col('prenom', 'text'), col('nom', 'text'),
    col('badge', 'integer'),
  ], { constraints: [{ name: 'u', type: 'u', definition: '', columns: ['badge'], refColumns: [] }] });
  assert.deepEqual(anonymizationCandidates(people).map(c => `${c.column}:${c.kind}`),
    ['birth_date:year', 'salary:noise', 'city:city', 'prenom:first_name', 'nom:last_name']);
  const unique = table('t', [col('id', 'integer'), col('salary', 'integer')], { constraints: [{ name: 'u', type: 'u', definition: '', columns: ['salary'], refColumns: [] }] });
  assert.deepEqual(anonymizationCandidates(unique), []);
  const plan = buildAnonymizePlan({ tables: new Map([[people.key, people]]), sequences: new Set(), views: new Map() }, new Map());
  const kinds = name => plan.tables[0].columns.find(c => c.name === name).kinds;
  assert.deepEqual(kinds('birth_date'), ['noise', 'month', 'year', 'null']);
  assert.deepEqual(kinds('salary'), ['noise', 'null']);
  assert.deepEqual(kinds('badge'), ['null']);
});

test('SQL for numbers and dates follows the column type', () => {
  assert.equal(valueClass('timestamp with time zone'), 'timestamp');
  assert.equal(valueClass('integer[]'), 'other');
  assert.match(anonymizedExpression('age', 'noise', 't', { type: 'smallint' }), /greatest\(-32768, least\(32767, round\(t\.age \* /);
  assert.match(anonymizedExpression('price', 'noise', 't', { type: 'numeric(10,2)' }), /round\(t\.price \* .*, scale\(t\.price\)\)/);
  assert.match(anonymizedExpression('born', 'year', 't', { type: 'date' }), /date_trunc\('year', t\.born\)::date/);
  assert.match(anonymizedExpression('at', 'noise', 't', { type: 'timestamp without time zone' }), /\* interval '1 day'/);
  assert.throws(() => anonymizedExpression('tags', 'noise', 't', { type: 'text[]' }));
});

test('a computed column made only of values written in the query is not data from the database', async () => {
  const { sqlLiterals, onlyQueryLiterals } = await import(pathToFileURL(path.join(cwd, 'mcp-postgres/build/masking.js')).href);
  assert.deepEqual([...sqlLiterals("select 'events' as t union all select 'it''s' as t")], ['events', "it's"]);
  const sql = "select 'events' as t, count(*) n from events union all select 'photos', count(*) from photos";
  assert.equal(onlyQueryLiterals([{ t: 'events', n: 47 }, { t: 'photos', n: 8094 }], 't', sql), true);
  // A value the query did not write comes from the database
  assert.equal(onlyQueryLiterals([{ t: 'events' }, { t: 'alice@x.org' }], 't', sql), false);
  assert.equal(onlyQueryLiterals([{ t: 'events' }], 't', undefined), false);
  assert.equal(onlyQueryLiterals([{ t: null }], 't', sql), false);
});

test('a computed column is asked about only when its query can read a chosen column', async () => {
  const { planMayReadRules } = await import(pathToFileURL(path.join(cwd, 'mcp-postgres/build/masking.js')).href);
  const rules = new Map([['public.customers.email', 'email']]);
  const scan = (schema, name, output = []) => ({ 'Node Type': 'Seq Scan', Schema: schema, 'Relation Name': name, Output: output });
  // A view over orders, months as text: nothing personal can be in it
  const months = [{ Plan: { 'Node Type': 'Sort', Plans: [scan('public', 'orders', ["to_char(orders.placed_at, 'YYYY-MM'::text)"])] } }];
  assert.equal(planMayReadRules(months, rules, []), false);
  // The customers table, even only in a subquery
  const sub = [{ Plan: { 'Node Type': 'Hash Join', Plans: [scan('public', 'orders'), { 'Node Type': 'Hash', Plans: [scan('public', 'customers')] }] } }];
  assert.equal(planMayReadRules(sub, rules, []), true);
  // Same table name in another schema: not the chosen one
  assert.equal(planMayReadRules([{ Plan: scan('archive', 'customers') }], rules, []), false);
  // A function of the database could read customers out of sight
  const called = [{ Plan: scan('public', 'orders', ['"Owner_Of"(orders.id)']) }];
  assert.equal(planMayReadRules(called, rules, ['Owner_Of']), true);
  assert.equal(planMayReadRules([{ Plan: { 'Node Type': 'Function Scan', 'Function Name': 'people' } }], rules, ['people']), true);
  assert.equal(planMayReadRules(months, rules, ['char']), false);
});

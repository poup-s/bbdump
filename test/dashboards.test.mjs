// Dashboards: kept encrypted apart from config.json, the AI's patches merged into the
// program, and query results shaped for the components.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const { DashboardStore, sanitizeDashboard, MAX_VERSIONS, toDashboardFile, fromDashboardFile } = require(path.join(root, 'dist/main/dashboards/dashboardStore.js'));

// Renderer modules are TypeScript compiled by Vite: transform them on the fly (imports resolved relative to them)
const { transformSync } = require('esbuild');
const load = (file) => {
  const full = path.join(root, file);
  const compiled = transformSync(fs.readFileSync(full, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  const localRequire = (id) => (id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(full), `${id}.ts`))) : require(id));
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, localRequire);
  return mod.exports;
};
const program = load('src/renderer/src/dashboards/dashboardProgram.ts');
const edit = load('src/renderer/src/dashboards/programEdit.ts');
const values = load('src/renderer/src/dashboards/valueFormat.ts');
const sheets = load('src/renderer/src/dashboards/spreadsheet.ts');

const cipher = { encrypt: t => Buffer.from(t).toString('base64'), decrypt: t => Buffer.from(t, 'base64').toString() };
const NOW = '2026-10-22T10:00:00.000Z';
const sample = (extra = {}) => ({
  id: 'dash-1', databaseId: 'db-1', title: 'Sales', program: 'root = Dashboard([t])\nt = Heading("Sales")',
  refreshSeconds: 300, createdAt: NOW, updatedAt: NOW, versions: [],
  chat: { provider: 'claude', sessionId: 'abc-1', messages: [{ role: 'user', text: 'secret question' }] },
  ...extra,
});

describe('storage', () => {
  test('encrypted on disk, listed newest first, read back, deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-dashboards-'));
    try {
      const store = new DashboardStore(dir, cipher);
      store.save(sample());
      store.save(sample({ id: 'dash-2', title: 'Users', updatedAt: '2026-10-22T11:00:00.000Z', program: '' }));
      store.save(sample({ id: 'dash-3', databaseId: 'db-2' }));
      const raw = fs.readFileSync(path.join(dir, 'db-1', 'dash-1.json'), 'utf8');
      assert.ok(!raw.includes('secret question') && !raw.includes('Heading'));
      // Only the databases asked for (a removed database's files are not listed)
      assert.deepEqual(store.list(['db-1']).map(d => [d.id, d.empty]), [['dash-2', true], ['dash-1', false]]);
      assert.equal(store.list(['db-1', 'db-2']).length, 3);
      assert.equal(store.get('db-1', 'dash-1').chat.messages[0].text, 'secret question');
      // The creation date survives a save that changes it
      store.save(sample({ createdAt: '2030-01-01T00:00:00.000Z', title: 'Renamed' }));
      assert.equal(store.get('db-1', 'dash-1').createdAt, NOW);
      assert.equal(store.get('db-1', 'dash-1').title, 'Renamed');
      store.delete('db-1', 'dash-1');
      assert.equal(store.get('db-1', 'dash-1'), null);
      store.clear('db-2');
      assert.deepEqual(store.list(['db-2']), []);
      // No path outside the folder
      assert.throws(() => store.get('../x', 'dash-1'));
      assert.throws(() => store.save(sample({ id: '../../evil' })));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('only what is expected is saved', () => {
    assert.equal(sanitizeDashboard(null, NOW), null);
    assert.equal(sanitizeDashboard(sample({ id: 'a/b' }), NOW), null);
    assert.equal(sanitizeDashboard(sample({ program: 'x'.repeat(100_001) }), NOW), null);
    const d = sanitizeDashboard({ ...sample({ refreshSeconds: 7, title: `  ${'t'.repeat(200)} ` }), extra: 'dropped' }, '2026-10-23T00:00:00.000Z');
    assert.equal(d.refreshSeconds, 0);
    assert.equal(d.title.length, 120);
    assert.equal(d.updatedAt, '2026-10-23T00:00:00.000Z');
    assert.equal('extra' in d, false);
    const versions = Array.from({ length: 15 }, (_, i) => ({ program: `v${i}`, at: NOW }));
    const kept = sanitizeDashboard(sample({ versions, chat: { provider: 'codex', sessionId: 'bad id;rm', messages: [] } }), NOW);
    assert.equal(kept.versions.length, MAX_VERSIONS);
    assert.equal(kept.versions.at(-1).program, 'v14');
    assert.equal('sessionId' in kept.chat, false);
  });
});

describe('program', () => {
  test('the AI gets the current program with the request', () => {
    assert.match(program.dashboardRequest('', 'Sales per day'), /^The dashboard is empty: create it\.\n\nRequest: Sales per day$/);
    const msg = program.dashboardRequest('root = Dashboard([])', ' Add a chart ');
    assert.ok(msg.includes('```openui-lang\nroot = Dashboard([])\n```'));
    assert.ok(msg.endsWith('Request: Add a chart'));
  });

  test('every complete OpenUI block of an answer is a patch, in order', () => {
    assert.deepEqual(program.patchesFromAnswer(['Only text, no change.']), []);
    const answer = ['I added a chart.\n```openui-lang\nroot = Dashboard([a, c])\nc = Text("x")\n```\nDone.'];
    assert.deepEqual(program.patchesFromAnswer(answer), ['root = Dashboard([a, c])\nc = Text("x")']);
    // A block still open (stopped mid-way) is not used
    assert.deepEqual(program.patchesFromAnswer(['```openui\nroot = Dashboard([a])\n```', 'then\n```openui\nroot = Dash']), ['root = Dashboard([a])']);
    // The program, then a correction in a second block: both, in order, and the result holds both
    const two = program.patchesFromAnswer(['```openui-lang\nroot = Dashboard([a])\na = Text("x")\n```\nOne more:\n```openui-lang\nroot = Dashboard([a, b])\nb = Text("y")\n```']);
    assert.equal(two.length, 2);
    const merged = two.reduce((p, patch) => program.applyPatch(p, patch), '');
    assert.ok(merged.includes('a = Text("x")') && merged.includes('b = Text("y")') && merged.startsWith('root = Dashboard([a, b])'));
  });

  test('a patch replaces statements by name and adds new ones', () => {
    const first = 'root = Dashboard([t, k])\nt = Heading("A")\nq = Query("sql", {query: "SELECT 1 AS n"}, {columns: [], rows: []})\nk = Kpis([{label: "N", value: @First(q.rows.n)}])';
    assert.equal(program.applyPatch('', first), first);
    const merged = program.applyPatch(first, 'root = Dashboard([t, k, c])\nc = Text("hi")\nt = Heading("B")');
    assert.ok(merged.includes('t = Heading("B")'));
    assert.ok(merged.includes('q = Query("sql"'));
    assert.ok(merged.includes('c = Text("hi")'));
    assert.ok(merged.startsWith('root = Dashboard([t, k, c])'));
  });

  test('versions keep the last ones, an empty program is not one', () => {
    let v = [];
    v = program.withVersion(v, '', NOW);
    assert.equal(v.length, 0);
    for (let i = 0; i < 12; i++) v = program.withVersion(v, `p${i}`, NOW, 10);
    assert.equal(v.length, 10);
    assert.equal(v[0].program, 'p2');
  });

  test('query results: bigint and numeric as numbers, dates as text, the rest as is', () => {
    const r = program.toQueryResult({
      fields: ['n', 'total', 'zip', 'day', 'at', 'meta', 'none'],
      types: [20, 1700, 25, 1082, 1114, 3802, 25],
      rows: [{ n: '42', total: '12.50', zip: '01234', day: new Date(2026, 9, 22), at: new Date(2026, 9, 22, 14, 5), meta: { a: 1 }, none: null }],
      truncated: true,
    });
    assert.deepEqual(r.columns, ['n', 'total', 'zip', 'day', 'at', 'meta', 'none']);
    assert.deepEqual(r.rows[0], { n: 42, total: 12.5, zip: '01234', day: '2026-10-22', at: '2026-10-22T14:05:00', meta: '{"a":1}', none: null });
    assert.equal(r.truncated, true);
    assert.deepEqual(program.toQueryResult(null), { columns: [], rows: [], truncated: false });
  });
});

describe('settings, kept results, files', () => {
  test('layout, theme, filters, pin and kept results are saved when valid', () => {
    const d = sanitizeDashboard(sample({
      layout: { chart: { span: 6, hidden: true }, bad: { span: 40 }, 'a b': { span: 6 }, kpis: { span: 4.5 }, tall: { height: 320 }, huge: { height: 99999 } },
      theme: { accent: 'violet', density: 'compact' },
      filters: { period: { preset: 'custom', from: '2026-01-01', to: 'nope' }, values: { city: 'Lyon', '1x': 'y', status: null }, labels: { user: 'a@b.c', bad: 7 } },
      pinned: true, cacheResults: 'yes',
    }), NOW);
    assert.deepEqual(d.layout, { chart: { span: 6, hidden: true }, tall: { height: 320 } });
    assert.deepEqual(d.theme, { accent: 'violet', density: 'compact' });
    assert.deepEqual(d.filters, { period: { preset: 'custom', from: '2026-01-01' }, values: { city: 'Lyon', status: null }, labels: { user: 'a@b.c' } });
    assert.equal(d.pinned, true);
    assert.equal('cacheResults' in d, false);
    assert.deepEqual(sanitizeDashboard(sample({ theme: { accent: 'neon' } }), NOW).theme, { accent: 'emerald', density: 'comfortable' });
  });

  test('kept results: encrypted, apart from the list, removed with the dashboard', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-dashboards-'));
    try {
      const store = new DashboardStore(dir, cipher);
      store.save(sample({ pinned: true }));
      store.setCache('db-1', 'dash-1', { q: { columns: ['n'], rows: [{ n: 'secret value' }] } });
      assert.ok(!fs.readFileSync(path.join(dir, 'db-1', 'dash-1.cache'), 'utf8').includes('secret value'));
      assert.equal(store.list(['db-1']).length, 1);
      assert.equal(store.list(['db-1'])[0].pinned, true);
      assert.equal(store.getCache('db-1', 'dash-1').q.rows[0].n, 'secret value');
      store.setCache('db-1', 'dash-1', null);
      assert.equal(store.getCache('db-1', 'dash-1'), null);
      store.setCache('db-1', 'dash-1', { q: 1 });
      store.delete('db-1', 'dash-1');
      assert.equal(store.getCache('db-1', 'dash-1'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dashboard file holds the program and settings, never the conversation', () => {
    const file = toDashboardFile(sanitizeDashboard(sample({ layout: { t: { span: 6 } } }), NOW));
    assert.equal(file.format, 'bbdump-dashboard');
    assert.equal('chat' in file || 'versions' in file || 'id' in file, false);
    assert.deepEqual(file.layout, { t: { span: 6 } });
    const back = fromDashboardFile(JSON.parse(JSON.stringify(file)));
    assert.equal(back.program, sample().program);
    assert.equal(fromDashboardFile({ format: 'other', program: 'x' }), null);
    assert.equal(fromDashboardFile({ format: 'bbdump-dashboard', version: 1, program: 'x'.repeat(100_001) }), null);
  });
});

describe('editing blocks by hand', () => {
  const P = [
    'root = Dashboard([title, figures, charts, latest])',
    'q1 = Query("sql", {query: "SELECT city AS label, count(*)::int AS value FROM t GROUP BY 1"}, {columns: [], rows: []})',
    'q2 = Query("sql", {query: "SELECT * FROM t WHERE note = \\"a, b\\" LIMIT 5"}, {columns: [], rows: []})',
    'title = Heading("Sales")',
    'figures = Kpis([{label: "N", value: @First(q1.rows.value)}])',
    'charts = Row([cityChart, donut])',
    'cityChart = BarChart(q1.rows.label, q1.rows.value, "By city", "EUR")',
    'donut = DonutChart(q1.rows.label, q1.rows.value, "Shares")',
    'latest = Table(q2.columns, q2.rows, "Latest", ["A", "B"])',
  ].join('\n');

  test('arguments are split outside strings and brackets', () => {
    assert.deepEqual(edit.splitTopLevel('a, [b, c], "d, \\"e\\"", {x: 1, y: 2}'), ['a', '[b, c]', '"d, \\"e\\""', '{x: 1, y: 2}']);
    assert.deepEqual(edit.parseCall('BarChart(q.rows.a, q.rows.b, "T, u")'), { callee: 'BarChart', args: ['q.rows.a', 'q.rows.b', '"T, u"'] });
    assert.deepEqual(edit.references('Kpis([{label: "q2 x", value: @First(q1.rows.value)}])'), ['q1']);
  });

  test('move, within its container only', () => {
    const moved = edit.moveBlock(P, 'donut', -1);
    assert.match(moved, /charts = Row\(\[donut, cityChart\]\)/);
    assert.equal(edit.moveBlock(P, 'title', -1), P);
    assert.match(edit.moveBlock(P, 'title', 1), /root = Dashboard\(\[figures, title, charts, latest\]\)/);
  });

  test('drag and drop: before or after another block, across rows; an emptied row goes away', () => {
    assert.match(edit.moveBlockTo(P, 'donut', 'cityChart', 'before'), /charts = Row\(\[donut, cityChart\]\)/);
    // Out of the row, under the title
    const out = edit.moveBlockTo(P, 'donut', 'title', 'after');
    assert.match(out, /root = Dashboard\(\[title, donut, figures, charts, latest\]\)/);
    assert.match(out, /charts = Row\(\[cityChart\]\)/);
    // Into a row
    assert.match(edit.moveBlockTo(P, 'latest', 'cityChart', 'after'), /charts = Row\(\[cityChart, latest, donut\]\)/);
    // The last block of a row leaves: the row goes too
    const twice = edit.moveBlockTo(edit.moveBlockTo(P, 'donut', 'title', 'after'), 'cityChart', 'latest', 'after');
    assert.match(twice, /root = Dashboard\(\[title, donut, figures, latest, cityChart\]\)/);
    assert.ok(!twice.includes('charts = '));
    // A row cannot go into itself; a block onto itself changes nothing
    assert.equal(edit.moveBlockTo(P, 'charts', 'donut', 'before'), P);
    assert.equal(edit.moveBlockTo(P, 'title', 'title', 'after'), P);
  });

  test('a block of figures splits into one card per figure, in a row keeping its name', () => {
    const prog = 'root = Dashboard([kpis, other])\nkpis = Kpis([{label: "A, b", value: 1}, {label: "C", value: @First(q.rows.n)}])\nkpis1 = Text("taken")\nother = Text("x")';
    assert.deepEqual(edit.kpiItems(prog, 'kpis'), ['{label: "A, b", value: 1}', '{label: "C", value: @First(q.rows.n)}']);
    const { program: out, ids } = edit.splitKpis(prog, 'kpis');
    assert.deepEqual(ids, ['kpis2', 'kpis3']);
    assert.match(out, /kpis = Row\(\[kpis2, kpis3\]\)\nkpis2 = Kpis\(\[\{label: "A, b", value: 1\}\]\)\nkpis3 = Kpis\(\[\{label: "C", value: @First\(q\.rows\.n\)\}\]\)/);
    // One figure: nothing to split
    assert.equal(edit.splitKpis('root = Dashboard([k])\nk = Kpis([{label: "A", value: 1}])', 'k').ids.length, 0);
  });

  test('remove takes away what only the block used', () => {
    const out = edit.removeBlock(P, 'latest');
    assert.match(out, /root = Dashboard\(\[title, figures, charts\]\)/);
    assert.ok(!out.includes('q2 = ') && !out.includes('latest = '));
    // q1 is still used by others
    assert.ok(edit.removeBlock(P, 'donut').includes('q1 = '));
  });

  test('duplicate places a copy right after, with a free name', () => {
    const { program: out, id } = edit.duplicateBlock(P, 'cityChart');
    assert.equal(id, 'cityChart2');
    assert.match(out, /charts = Row\(\[cityChart, cityChart2, donut\]\)/);
    assert.match(out, /cityChart2 = BarChart\(q1\.rows\.label/);
  });

  test('change of type keeps the data; a chart can become a table', () => {
    assert.deepEqual(edit.typeChoices(P, 'cityChart'), ['LineChart', 'AreaChart', 'DonutChart', 'Table']);
    assert.match(edit.changeType(P, 'cityChart', 'LineChart'), /cityChart = LineChart\(q1\.rows\.label, q1\.rows\.value, "By city", "EUR"\)/);
    assert.match(edit.changeType(P, 'donut', 'Table'), /donut = Table\(q1\.columns, q1\.rows, "Shares"\)/);
    assert.equal(edit.changeType(P, 'latest', 'BarChart'), P);
    assert.deepEqual(edit.typeChoices(P, 'latest'), []);
    // A detail card can be renamed too
    assert.equal(edit.blockTitle('x = Record(q.columns, q.rows, "Fiche")', 'x'), 'Fiche');
  });

  test('titles are read and written in the right argument', () => {
    assert.equal(edit.blockTitle(P, 'cityChart'), 'By city');
    assert.equal(edit.blockTitle(P, 'figures'), null);
    const out = edit.setBlockTitle(P, 'latest', 'Les "dernières"');
    assert.match(out, /latest = Table\(q2\.columns, q2\.rows, "Les \\"dernières\\"", \["A", "B"\]\)/);
    assert.equal(edit.blockTitle(out, 'latest'), 'Les "dernières"');
  });

  test('the SQL of a block, read and replaced', () => {
    assert.deepEqual(edit.blockQueries(P, 'figures'), ['q1']);
    assert.deepEqual(edit.blockQueries(P, 'charts'), ['q1']);
    assert.equal(edit.querySql(P, 'q2'), 'SELECT * FROM t WHERE note = "a, b" LIMIT 5');
    const out = edit.setQuerySql(P, 'q2', 'SELECT 1 AS "x"');
    assert.equal(edit.querySql(out, 'q2'), 'SELECT 1 AS "x"');
    assert.match(out, /q2 = Query\("sql", \{query: "SELECT 1 AS \\"x\\""\}, \{columns: \[\], rows: \[\]\}\)/);
  });
});

describe('formats, filters, suggestions', () => {
  test('values in the user\'s language', () => {
    assert.equal(values.formatValue(null, undefined, 'fr'), '—');
    assert.equal(values.formatValue(1234.5, 'money:EUR', 'fr').replace(/\s/g, ' '), '1 234,50 €');
    assert.equal(values.formatValue(12.345, 'percent', 'en'), '12.3 %');
    assert.equal(values.formatValue(3725, 'duration', 'fr'), '1 h 02');
    assert.equal(values.formatValue(2048, 'bytes', 'fr'), '2 ko');
    assert.equal(values.formatValue('2026-10-22', undefined, 'en'), 'Oct 22, 2026');
    assert.match(values.formatValue('2026-10-22T14:05:00', undefined, 'fr'), /22 oct\. 2026.*14:05/);
    assert.equal(values.formatValue('01234', undefined, 'fr'), '01234');
    assert.equal(values.change(110, 100), 10);
    assert.equal(values.change(1, 0), null);
    assert.equal(values.toCsv(['a', 'b'], [{ a: 1.5, b: 'x;y' }], 'fr'), 'a;b\r\n1,5;"x;y"');
    assert.equal(values.toCsv(['a', 'b'], [{ a: 1, b: 2 }], 'en', ['Name', '']), 'Name,b\r\n1,2');
  });

  test('filters become bound parameters, never SQL text', () => {
    const { text, params } = program.bindFilters("SELECT 1 FROM t WHERE at >= {{from}} AND at < {{to}} AND ({{city}} IS NULL OR city = {{city}})", { from: 'F', to: 'T', city: "Lyon'; DROP" });
    assert.equal(text, 'SELECT 1 FROM t WHERE at >= $1::timestamptz AND at < $2::timestamptz AND ($3::text IS NULL OR city = $3::text)');
    assert.deepEqual(params, ['F', 'T', "Lyon'; DROP"]);
    assert.deepEqual(program.bindFilters('SELECT {{from}}, {{x}}', {}).params, ['-infinity', null]);
  });

  test('periods', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    assert.equal(program.periodRange('7d', now).from, '2026-10-15T12:00:00.000Z');
    assert.deepEqual(program.periodRange('all', now), { from: '-infinity', to: 'infinity' });
    const custom = program.periodRange('custom', now, { from: '2026-01-01', to: '2026-01-31' });
    assert.ok(Date.parse(custom.to) - Date.parse(custom.from) >= 30 * 86400000);
  });

  test('the AI\'s next steps become buttons, out of the text', () => {
    const answer = 'Done.\n```suggestions\n- Add a filter\n2. Show per week\n\n```';
    assert.deepEqual(program.suggestionsIn(answer), ['Add a filter', 'Show per week']);
    assert.equal(program.withoutSuggestions(answer), 'Done.');
    assert.match(program.dashboardRequest('root = Dashboard([])', 'Bigger', 'cityChart'), /about the block "cityChart"/);
  });

  test('check_query accepts dashboard placeholders', async () => {
    const { withPlaceholderDefaults } = await import(new URL(`file://${path.join(root, 'mcp-postgres/build/tools/query.js')}`).href);
    assert.equal(withPlaceholderDefaults('a >= {{from}} AND a < {{ to }} AND ({{city}} IS NULL)'), "a >= (now() - interval '30 days') AND a < now() AND (NULL::text IS NULL)");
  });
});

describe('spreadsheets', () => {
  const sheet = { name: 'Ventes: "2026"/Q3', columns: ['city', 'total', 'day', 'at', 'note'], labels: ['Ville', 'Total', 'Jour', 'Quand', 'Note'],
    rows: [{ city: 'Lyon & co', total: 1234.5, day: '2026-10-22', at: '2026-10-22T14:05:00', note: null }, { city: '<b>', total: 2, day: null, at: null, note: 'a\tb' }] };

  test('an Excel workbook: valid parts, numbers as numbers, dates as Excel dates', () => {
    const { unzipSync, strFromU8 } = require('fflate');
    const files = unzipSync(sheets.toXlsx([sheet, { ...sheet, name: 'Ventes: "2026"/Q3' }]));
    assert.ok(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].every(f => files[f]));
    const workbook = strFromU8(files['xl/workbook.xml']);
    // Names cleaned and made different
    assert.match(workbook, /name="Ventes &quot;2026&quot; Q3"/);
    assert.match(workbook, /name="Ventes &quot;2026&quot; Q3 2"/);
    const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
    assert.match(xml, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Ville<\/t>/);
    assert.match(xml, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Lyon &amp; co<\/t>/);
    assert.match(xml, /<c r="B2"><v>1234.5<\/v><\/c>/);
    assert.match(xml, /<c r="C2" s="2"><v>46317<\/v><\/c>/);
    assert.match(xml, /<c r="D2" s="3"><v>46317\.58680555/);
    assert.ok(!xml.includes('<b>') && xml.includes('&lt;b&gt;'));
  });

  test('helpers', () => {
    assert.deepEqual([0, 25, 26, 701].map(sheets.columnName), ['A', 'Z', 'AA', 'ZZ']);
    assert.deepEqual(sheets.excelDate('1900-03-01'), { serial: 61, time: false });
    assert.equal(sheets.excelDate('Lyon'), null);
    assert.equal(sheets.sheetNames(['x'.repeat(40)])[0].length, 31);
    assert.equal(sheets.toTsv(sheet, 'fr'), 'Ville\tTotal\tJour\tQuand\tNote\nLyon & co\t1234,5\t2026-10-22\t2026-10-22T14:05:00\t\n<b>\t2\t\t\ta b');
  });

  test('a table\'s headers are read from its labels', () => {
    assert.deepEqual(edit.blockLabels('t = Table(q.columns, q.rows, "T", ["", "Nom, prénom"])', 't'), ['', 'Nom, prénom']);
    assert.equal(edit.blockLabels('t = BarChart(q.rows.a, q.rows.b)', 't'), null);
  });
});

describe('review fixes', () => {
  test('Excel keeps characters beyond the basic plane (emoji)', () => {
    const { unzipSync, strFromU8 } = require('fflate');
    const files = unzipSync(sheets.toXlsx([{ name: 'S', columns: ['n'], rows: [{ n: 'Café ☕ 🥐' }] }]));
    assert.ok(strFromU8(files['xl/worksheets/sheet1.xml']).includes('Café ☕ 🥐'));
  });

  test('cleanup keeps what a ternary uses, skips object keys', () => {
    assert.deepEqual(edit.references('Heading(n > 0 ? labelA : labelB)').sort(), ['labelA', 'labelB', 'n']);
    assert.deepEqual(edit.references('Kpis([{label: "x", value: @First(q.rows.v)}])'), ['q']);
    const prog = 'root = Dashboard([t, x])\nt = Text(n > 0 ? labelA : labelB)\nlabelA = "a"\nlabelB = "b"\nn = 1\nx = Text("x")';
    const out = edit.removeBlock(prog, 'x');
    assert.ok(out.includes('labelA = ') && out.includes('labelB = '));
  });

  test('filters are saved without changing the dashboard\'s date', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-dashboards-'));
    try {
      const store = new DashboardStore(dir, cipher);
      store.save(sample());
      assert.equal(store.saveFilters('db-1', 'dash-1', { values: { q: 'dupont' } }), true);
      const d = store.get('db-1', 'dash-1');
      assert.equal(d.updatedAt, NOW);
      assert.deepEqual(d.filters, { values: { q: 'dupont' } });
      assert.equal(d.chat.messages[0].text, 'secret question');
      assert.equal(store.saveFilters('db-1', 'missing', {}), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MongoDB dashboards', () => {
  const mongo = load('src/renderer/src/dashboards/mongoDashboard.ts');
  const shared = require(path.join(root, 'dist/shared/engines/documents.js'));

  test('a block query: collection and pipeline, refused when it is something else', () => {
    assert.deepEqual(program.mongoDashboardQuery('{"collection": "orders", "pipeline": [{"$limit": 5}]}'), { collection: 'orders', pipeline: '[{"$limit":5}]' });
    assert.throws(() => program.mongoDashboardQuery('SELECT 1'), /not valid JSON/);
    assert.throws(() => program.mongoDashboardQuery('{"pipeline": []}'), /collection/);
    assert.throws(() => program.mongoDashboardQuery('{"collection": "orders", "pipeline": {}}'), /array/);
  });

  test('filters become values: dates, text, null for "all", escaped text inside a regex', () => {
    const text = '{"collection": "o", "pipeline": [{"$match": {"at": {"$gte": "{{from}}", "$lt": "{{to}}"}, "$expr": {"$eq": ["$city", "{{city}}"]}, "name": {"$regex": "(?i){{q}}"}}}]}';
    const bound = JSON.parse(program.bindMongoFilters(text, { from: '2026-10-01T00:00:00.000Z', to: 'infinity', city: 'Paris "16e"', q: 'a.b*' }));
    const match = bound.pipeline[0].$match;
    assert.deepEqual(match.at.$gte, { $date: '2026-10-01T00:00:00.000Z' });
    assert.deepEqual(match.at.$lt, { $date: { $numberLong: '253402300799999' } });
    assert.equal(match.$expr.$eq[1], 'Paris "16e"');
    assert.equal(match.name.$regex, '(?i)a\\.b\\*');
    const all = JSON.parse(program.bindMongoFilters(text, { from: '-infinity', to: 'infinity', city: null }));
    assert.equal(all.pipeline[0].$match.$expr.$eq[1], null);
    assert.equal(all.pipeline[0].$match.name.$regex, '(?i)');
    assert.deepEqual(all.pipeline[0].$match.at.$gte, { $date: { $numberLong: '-62135596800000' } });
    // A value cannot add stages or operators: it stays a string
    const sneaky = JSON.parse(program.bindMongoFilters(text, { city: '"}, {"$out": "x"}, {"a": "' }));
    assert.equal(sneaky.pipeline.length, 1);
  });

  test('aggregation results as rows: dates, ObjectIds, numbers, compound group keys', () => {
    const result = program.toMongoQueryResult({
      documents: [
        { _id: { city: 'Paris', year: 2026 }, total: { $numberDecimal: '12.50' }, n: 3, last: { $date: '2026-10-01T00:00:00Z' } },
        { _id: { city: 'Lyon', year: 2026 }, total: 4, id: { $oid: '6ae12f57004ee79b229bc04b' }, tags: ['a'] },
      ],
      truncated: true,
    });
    assert.deepEqual(result.columns, ['city', 'year', 'total', 'n', 'last', 'id', 'tags']);
    assert.equal(result.rows[0].total, 12.5);
    assert.equal(result.rows[0].last, '2026-10-01');
    assert.equal(result.rows[1].id, '6ae12f57004ee79b229bc04b');
    assert.equal(result.rows[1].tags, '["a"]');
    assert.equal(result.rows[1].n, null);
    assert.equal(result.truncated, true);
  });

  test('the examples shown to the AI are valid: every query reads, binds and passes the read-only check', () => {
    for (const example of [mongo.MONGO_EXAMPLE, mongo.MONGO_EXAMPLE_LINKED]) {
      const statements = edit.parseStatements(example);
      const queries = statements.filter(s => /^Query\("mongo"/.test(s.expr.trim()));
      assert.ok(queries.length >= 3);
      for (const q of queries) {
        const text = edit.querySql(example, q.name);
        const { pipeline } = program.mongoDashboardQuery(program.bindMongoFilters(text, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', city: null, user: null, q: '' }));
        assert.equal(shared.pipelineProblem(JSON.parse(pipeline)), undefined, q.name);
        // Fields written as expressions ("status": "$status"): the columns follow the labels' order
        for (const stage of JSON.parse(pipeline).filter(st => st.$project)) {
          for (const [field, value] of Object.entries(stage.$project)) if (field !== '_id') assert.notEqual(value, 1, `${q.name}.${field}`);
        }
      }
    }
    assert.equal(mongo.MONGO_TOOL.name, 'mongo');
  });
});

describe('the engine of a dashboard program', () => {
  test('from its queries; none yet: any database', () => {
    assert.equal(program.programEngine('root = Dashboard([a])\nq = Query("mongo", {query: "{}"}, {columns: [], rows: []})'), 'mongodb');
    assert.equal(program.programEngine('q = Query("sql", {query: "SELECT 1"}, {columns: [], rows: []})'), 'postgresql');
    assert.equal(program.programEngine('root = Dashboard([t])\nt = Heading("Sales")'), null);
  });
});

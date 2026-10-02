// Neon API client (adding a Neon database with an API key), against a local mock of the API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as http from 'node:http';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const neon = require(path.join(process.cwd(), 'dist/main/neonApi.js'));

const KEY = 'napi_test_key';
const requests = [];
let server;

// Personal key: two organizations, the projects of each only listed with its org_id
const routes = {
  '/users/me/organizations': () => ({ organizations: [{ id: 'org-a', name: 'Perso' }, { id: 'org-b', name: 'Team' }] }),
  '/projects': (q) => ({
    projects: q.get('org_id') === 'org-a' ? [{ id: 'calm-sun-123', name: 'shop', region_id: 'aws-eu-central-1' }]
      : q.get('org_id') === 'org-b' ? [{ id: 'red-moon-456', name: 'crm', region_id: 'aws-us-east-2', org_name: 'Team' }]
        : [],
    pagination: { cursor: 'x' },
  }),
  '/projects/calm-sun-123/branches': () => ({
    branches: [
      { id: 'br-dev-1', name: 'dev', default: false, current_state: 'ready' },
      { id: 'br-main-1', name: 'main', default: true, current_state: 'ready' },
    ],
  }),
  '/projects/calm-sun-123/branches/br-main-1/databases': () => ({ databases: [{ id: 1, name: 'neondb', owner_name: 'neondb_owner' }] }),
  '/projects/calm-sun-123/connection_uri': (q) => ({
    uri: `postgresql://${q.get('role_name')}:npg_secret@ep-x-1${q.get('pooled') === 'true' ? '-pooler' : ''}.eu-central-1.aws.neon.tech/${q.get('database_name')}?sslmode=require`,
  }),
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ path: url.pathname, query: url.searchParams, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end('{"message":"unauthorized"}'); return; }
    const route = routes[url.pathname.replace(/^\/api\/v2/, '')];
    if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"message":"not found"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(route(url.searchParams)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  neon.setNeonApiBase(`http://127.0.0.1:${server.address().port}/api/v2`);
});
after(() => { server.close(); neon.setNeonApiBase(undefined); });

describe('Neon API', () => {
  test('projects of every organization of a personal key', async () => {
    const projects = await neon.listProjects(KEY);
    assert.deepEqual(projects, [
      { id: 'calm-sun-123', name: 'shop', region: 'aws-eu-central-1', org: 'Perso' },
      { id: 'red-moon-456', name: 'crm', region: 'aws-us-east-2', org: 'Team' },
    ]);
    assert.ok(requests.every(r => r.auth === `Bearer ${KEY}`));
  });

  test('a refused key is reported as such', async () => {
    await assert.rejects(neon.listProjects('wrong'), (e) => e instanceof neon.NeonApiError && e.code === 'invalid_key');
  });

  test('an unreachable API is a network error', async () => {
    neon.setNeonApiBase('http://127.0.0.1:1/api/v2');
    try {
      await assert.rejects(neon.listProjects(KEY), (e) => e.code === 'network');
    } finally {
      neon.setNeonApiBase(`http://127.0.0.1:${server.address().port}/api/v2`);
    }
  });

  test('branches: the default one first', async () => {
    const branches = await neon.listBranches(KEY, 'calm-sun-123');
    assert.deepEqual(branches.map(b => b.name), ['main', 'dev']);
  });

  test('databases with their owner role', async () => {
    assert.deepEqual(await neon.listDatabases(KEY, 'calm-sun-123', 'br-main-1'), [{ name: 'neondb', owner: 'neondb_owner' }]);
  });

  test('connection URI: direct endpoint, not pooled', async () => {
    const uri = await neon.connectionUri(KEY, 'calm-sun-123', 'br-main-1', 'neondb', 'neondb_owner');
    assert.equal(uri, 'postgresql://neondb_owner:npg_secret@ep-x-1.eu-central-1.aws.neon.tech/neondb?sslmode=require');
    const last = requests.at(-1);
    assert.equal(last.query.get('pooled'), 'false');
    assert.equal(last.query.get('branch_id'), 'br-main-1');
  });

  test('ids that could change the request path are refused before any call', async () => {
    const count = requests.length;
    await assert.rejects(neon.listBranches(KEY, '../users/me'), /Invalid project id/);
    await assert.rejects(neon.listDatabases(KEY, 'calm-sun-123', 'br-1?x=1'), /Invalid branch id/);
    assert.equal(requests.length, count);
  });
});

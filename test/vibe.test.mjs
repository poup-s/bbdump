// Mistral Vibe as an MCP client: bbdump's server added to (and removed from) ~/.vibe/config.toml,
// the user's own settings kept as they were.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const clients = require(path.join(process.cwd(), 'dist/main/mcpClients.js'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-vibe-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

describe('MCP client: ~/.vibe/config.toml', () => {
  const spec = { command: '/Applications/bbdump.app/Contents/MacOS/bbdump', args: ['/Applications/bbdump.app/Contents/Resources/mcp-postgres/index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const ctx = { home, platform: 'darwin' };
  const file = path.join(home, '.vibe', 'config.toml');
  const original = [
    'theme = "auto"',
    'active_model = "mistral-medium-3.5"',
    '',
    '[[mcp_servers]]',
    'name = "linear"',
    'transport = "streamable-http"',
    'url = "https://mcp.linear.app/mcp"',
    '',
    '[mcp_servers.auth]',
    'type = "oauth"',
    '',
    '[tools.bash]',
    'permission = "ask"',
    '',
  ].join('\n');

  test('added after the user\'s settings, which stay as they were; detected once ~/.vibe exists', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    const before = clients.getClientStatus('vibe', ctx, spec);
    assert.equal(before.detected, true);
    assert.equal(before.state, 'not-installed');
    assert.equal(before.configPath, file);
    clients.installClient('vibe', ctx, spec);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original.trimEnd()), 'the user\'s file is kept byte for byte');
    assert.match(text, /\[\[mcp_servers\]\]\nname = "bbdump-postgres"\ntransport = "stdio"\ncommand = "\/Applications\/bbdump.app\/Contents\/MacOS\/bbdump"\nargs = \["\/Applications\/bbdump.app\/Contents\/Resources\/mcp-postgres\/index.js"\]\nenv = \{ "ELECTRON_RUN_AS_NODE" = "1" \}\n$/);
    assert.equal(clients.getClientStatus('vibe', ctx, spec).state, 'installed');
  });
  test('installing again replaces it; a moved app reads as outdated', () => {
    clients.installClient('vibe', ctx, spec);
    assert.equal(fs.readFileSync(file, 'utf8').match(/name = "bbdump-postgres"/g).length, 1);
    assert.equal(clients.getClientStatus('vibe', ctx, { ...spec, command: '/Other/bbdump' }).state, 'outdated');
  });
  test('our entry in the middle of the file, with a sub-table: removed alone', () => {
    const text = fs.readFileSync(file, 'utf8');
    const ours = text.slice(text.indexOf('[[mcp_servers]]\nname = "bbdump-postgres"'));
    fs.writeFileSync(file, `${original}\n${ours.trimEnd()}\n\n[mcp_servers.auth]\ntype = "static"\n\n[[mcp_servers]]\nname = "docs"\ntransport = "http"\nurl = "http://localhost:8000"\n`);
    clients.uninstallClient('vibe', ctx);
    const left = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(left, /bbdump-postgres|type = "static"/);
    assert.match(left, /name = "linear"[\s\S]*type = "oauth"[\s\S]*\[tools\.bash\][\s\S]*name = "docs"/);
    assert.equal(clients.getClientStatus('vibe', ctx, spec).state, 'not-installed');
  });
  test('$VIBE_HOME is honoured', () => {
    assert.equal(clients.getClientStatus('vibe', { ...ctx, vibeHome: '/srv/vibe' }, spec).configPath, path.join('/srv/vibe', 'config.toml'));
  });
});

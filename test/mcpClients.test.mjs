// AI clients on Windows: Claude Desktop from the Microsoft Store, and the claude.exe of Claude Code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const clients = require(path.join(process.cwd(), 'dist/main/mcpClients.js'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-mcp-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

const spec = { command: 'C:\\bbdump\\bbdump.exe', args: ['C:\\bbdump\\resources\\mcp-postgres\\index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
const ctx = { home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming') };

test('Claude Desktop: %APPDATA%\\Claude, or the Store package folder when it is installed from the Store', () => {
  assert.equal(clients.getClientStatus('claude-desktop', ctx, spec).configPath, path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  const store = path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  fs.mkdirSync(store, { recursive: true });
  const status = clients.getClientStatus('claude-desktop', ctx, spec);
  assert.equal(status.configPath, path.join(store, 'claude_desktop_config.json'));
  assert.equal(status.detected, true);
});

test("Claude Code: the native claude.exe when it is there", () => {
  assert.equal(clients.findClaudeCli(home, 'win32'), null);
  const exe = path.join(home, '.local', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  assert.equal(clients.findClaudeCli(home, 'win32'), exe);
});

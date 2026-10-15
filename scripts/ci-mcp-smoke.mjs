// CI (Windows): the packaged MCP server, launched the way AI assistants launch it (bbdump.exe with
// ELECTRON_RUN_AS_NODE), against a bbdump configuration with an encrypted password, the app running.
// Reads, then a backup through the app. Usage: node scripts/ci-mcp-smoke.mjs <bbdump.exe> <mcp index.js>
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [exe, entry] = process.argv.slice(2);
const password = process.env.BBDUMP_TEST_PW;
if (!exe || !entry || !password) throw new Error('usage: ci-mcp-smoke.mjs <bbdump.exe> <index.js> (BBDUMP_TEST_PW set)');

const userData = path.join(process.env.APPDATA, 'bbdump');
const backups = path.join(process.env.RUNNER_TEMP || process.cwd(), 'bbdump-mcp-backups');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(backups, { recursive: true });

// The app's key and encryption format (AES-256-GCM, iv:authTag:ciphertext in hex)
const key = crypto.randomBytes(32);
fs.writeFileSync(path.join(userData, '.encryption.key'), key.toString('hex'));
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
const configPath = path.join(userData, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  databases: [{
    id: 'mcp-ci', name: 'bbdump_mcp_ci', displayName: 'bbdump_mcp_ci', host: 'localhost', port: 5432, user: 'postgres',
    password: `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`, encrypted: true,
    ssl: false, cron: '0 0 * * *', enabled: false, encryptBackups: false, output: backups, isLocalBbdump: true,
  }],
  projects: [],
  onboardingCompleted: true,
  usageMode: 'local',
  language: 'en',
  defaultBackupPath: backups,
}, null, 2));

const portFile = path.join(userData, '.mcp-confirm-port');
fs.rmSync(portFile, { force: true });
const app = spawn(exe, ['--hidden'], { stdio: 'ignore' });
const deadline = Date.now() + 60000;
while (!fs.existsSync(portFile)) {
  if (Date.now() > deadline) throw new Error('bbdump did not start its local server (no .mcp-confirm-port)');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log('bbdump is running, local server port file present');

const mcp = spawn(exe, [entry], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BBDUMP_CONFIG_PATH: configPath,
    BBDUMP_KEY_PATH: path.join(userData, '.encryption.key'),
    MCP_CONFIRM_PORT_FILE: portFile,
    BBDUMP_APP_PATH: exe,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
mcp.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method}: no answer in ${timeoutMs} ms`)), timeoutMs);
    pending.set(id, message => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args = {}, timeoutMs) {
  const result = await request('tools/call', { name, arguments: args }, timeoutMs);
  const text = (result.content || []).map(c => c.text || '').join('\n');
  console.log(`--- ${name}: ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

let failed = false;
try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci', version: '1.0.0' } });
  console.log(`server: ${init.serverInfo?.name} ${init.serverInfo?.version}`);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { tools } = await request('tools/list', {});
  console.log(`${tools.length} tools`);
  expect(tools.length >= 40, `only ${tools.length} tools`);

  expect((await call('list_connections')).includes('bbdump_mcp_ci'), 'list_connections does not show the saved database');
  await call('use_connection', { name: 'bbdump_mcp_ci' });
  expect((await call('get_schema_overview')).includes('items'), 'the schema overview misses the table');
  expect(/\b3\b/.test(await call('execute_query', { sql: 'select count(*) as n from items' })), 'the row count is wrong');
  await call('describe_table', { table: 'items' });
  // Through the running app: pg_dump of the Windows server, read back and kept
  await call('create_backup', {}, 5 * 60 * 1000);
  expect((await call('list_backups')).includes('bbdump_mcp_ci'), 'the backup is not listed');
  const files = fs.readdirSync(backups, { recursive: true }).map(String);
  console.log(`backup folder: ${files.join(', ')}`);
  expect(files.some(f => f.includes('bbdump_mcp_ci')), 'no backup file');
  console.log('MCP on Windows: OK');
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  mcp.kill();
  app.kill();
}
process.exit(failed ? 1 : 0);

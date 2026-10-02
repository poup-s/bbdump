/**
 * Talks to the bbdump app's local HTTP server (127.0.0.1, random port, per-launch token
 * read from MCP_CONFIRM_PORT_FILE): write confirmations, backups. Starts the app when it
 * is not running.
 */
import * as http from 'http';
import * as fs from 'fs';
import { spawn } from 'child_process';

interface ConfirmationDetails {
  tool: string;
  database: string;
  table?: string;
  schema?: string;
  sql: string;
  description: string;
}

export type ConfirmationOutcome =
  | { approved: true }
  | { approved: false; reason: 'refused' | 'timeout' | 'no_window' | 'unavailable' | 'not_configured' };

const TOKEN_HEADER = 'x-bbdump-token';

interface AppEndpoint {
  port: number;
  token: string;
}

/**
 * Port file format (written 0600 by the bbdump app): port on the first line,
 * auth token on the second. A port-only file (bbdump <= 1.0.2) yields an empty
 * token, which the app rejects.
 */
function readEndpointFromFile(): AppEndpoint | null {
  const portFile = process.env.MCP_CONFIRM_PORT_FILE;
  if (!portFile) return null;
  try {
    const [portLine = '', tokenLine = ''] = fs.readFileSync(portFile, 'utf-8').split(/\r?\n/);
    const port = parseInt(portLine.trim(), 10);
    return isNaN(port) ? null : { port, token: tokenLine.trim() };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AppResponse {
  reachable: boolean;
  status?: number;
  body?: any;
}

/** One request to the app; `reachable: false` when nothing answers on the port */
function appRequest({ port, token }: AppEndpoint, method: 'GET' | 'POST', path: string, payload: unknown, timeoutMs: number): Promise<AppResponse> {
  return new Promise((resolve) => {
    const data = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          [TOKEN_HEADER]: token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          let parsed: any = undefined;
          try { parsed = body ? JSON.parse(body) : undefined; } catch { /* not JSON */ }
          resolve({ reachable: true, status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', () => resolve({ reachable: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false });
    });
    if (data) req.write(data);
    req.end();
  });
}

function tryLaunchApp(): void {
  const appPath = process.env.BBDUMP_APP_PATH;
  if (!appPath) return;

  // This server may itself run on bbdump's binary in Node mode: the launched app
  // must not inherit ELECTRON_RUN_AS_NODE, or it would start as plain Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', appPath, '--args', '--mcp-confirm'], { detached: true, stdio: 'ignore', env }).unref();
    } else if (process.platform === 'linux') {
      spawn(appPath, ['--mcp-confirm'], { detached: true, stdio: 'ignore', env }).unref();
    }
  } catch {
    // Ignore launch errors
  }
}

/** Sends a request to the app, starting it (up to 15 s) when it is not running */
async function callApp(method: 'GET' | 'POST', path: string, payload: unknown, timeoutMs: number): Promise<AppResponse | null> {
  const endpoint = readEndpointFromFile();
  if (!endpoint) return null;
  const first = await appRequest(endpoint, method, path, payload, timeoutMs);
  if (first.reachable) return first;

  tryLaunchApp();
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const fresh = readEndpointFromFile();
    if (!fresh) continue;
    const health = await appRequest(fresh, 'GET', '/health', undefined, 2000);
    if (health.reachable && health.status === 200) return appRequest(fresh, method, path, payload, timeoutMs);
  }
  return { reachable: false };
}

/**
 * Asks the user to approve a write in the bbdump app (or auto-approves when the user
 * turned confirmations off there). Denied unless the app answers yes.
 */
export async function requestConfirmation(details: ConfirmationDetails): Promise<ConfirmationOutcome> {
  const response = await callApp('POST', '/confirm', details, 65000);
  if (!response) return { approved: false, reason: 'not_configured' };
  if (!response.reachable || response.status === 401 || response.status === 403) return { approved: false, reason: 'unavailable' };
  if (response.body?.approved === true) return { approved: true };
  const reason = response.body?.reason;
  return { approved: false, reason: reason === 'timeout' || reason === 'no_window' ? reason : 'refused' };
}

/** Message for a write that did not happen, telling the model what to do next */
export function refusalMessage(outcome: Exclude<ConfirmationOutcome, { approved: true }>): string {
  switch (outcome.reason) {
    case 'refused': return 'The user refused this change in bbdump. Do not retry it as is: ask the user what they want instead.';
    case 'timeout': return 'Nobody answered the confirmation in bbdump within 60 seconds. Ask the user to watch the bbdump window, then retry.';
    case 'no_window': return 'bbdump could not show the confirmation window. Ask the user to open bbdump, then retry.';
    case 'unavailable': return 'The bbdump app is not reachable to confirm this change. Ask the user to start bbdump (version 1.1 or later), then retry.';
    case 'not_configured': return 'Writes need confirmation in the bbdump app, and this MCP server was not set up by bbdump. Reinstall it from bbdump Settings → MCP.';
  }
}

/** GET/POST to the app for non-confirmation features (backups). Throws with a readable message */
export async function appApi<T>(method: 'GET' | 'POST', path: string, payload?: unknown, timeoutMs = 30000): Promise<T> {
  const response = await callApp(method, path, payload, timeoutMs);
  if (!response) throw new Error('This MCP server was not set up by bbdump: reinstall it from bbdump Settings → MCP.');
  if (!response.reachable) throw new Error('The bbdump app is not reachable. Ask the user to start bbdump, then retry.');
  if (response.status === 404) throw new Error('This bbdump version does not support this feature: update bbdump to 1.1 or later.');
  if (response.status && response.status >= 400) {
    throw new Error(response.body?.error || `bbdump answered HTTP ${response.status}`);
  }
  return response.body as T;
}

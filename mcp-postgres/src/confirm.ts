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

function readPortFromFile(): number | null {
  const portFile = process.env.MCP_CONFIRM_PORT_FILE;
  if (!portFile) return null;
  try {
    const content = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(content, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a confirmation request to the Electron app's HTTP server.
 * Returns { approved, reachable }.
 */
function doConfirmRequest(
  port: number,
  details: ConfirmationDetails
): Promise<{ approved: boolean; reachable: boolean }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(details);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/confirm',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 65000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            resolve({ approved: result.approved === true, reachable: true });
          } catch {
            resolve({ approved: false, reachable: true });
          }
        });
      }
    );
    req.on('error', () => resolve({ approved: false, reachable: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ approved: false, reachable: false });
    });
    req.write(data);
    req.end();
  });
}

function checkServerReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 2000,
      },
      () => resolve(true)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function tryLaunchApp(): void {
  const appPath = process.env.BBDUMP_APP_PATH;
  if (!appPath) return;

  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', appPath, '--args', '--mcp-confirm'], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'linux') {
      spawn(appPath, ['--mcp-confirm'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Ignore launch errors
  }
}

/**
 * Request user confirmation for a mutation via the Electron app.
 *
 * Flow:
 * 1. Read port file -> if missing, deny (not configured)
 * 2. Try to send confirmation request
 * 3. If server reachable -> return the user's decision
 * 4. If server unreachable -> launch app, wait for server, retry
 * 5. If still unreachable after retries -> deny
 */
export async function requestConfirmation(details: ConfirmationDetails): Promise<boolean> {
  const port = readPortFromFile();
  if (!port) return false;

  // First attempt
  const firstAttempt = await doConfirmRequest(port, details);
  if (firstAttempt.reachable) {
    return firstAttempt.approved;
  }

  // Server not reachable — try to launch the app
  tryLaunchApp();

  // Wait for the app to start (check every second, up to 15 seconds)
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const newPort = readPortFromFile();
    if (newPort && (await checkServerReachable(newPort))) {
      const retryResult = await doConfirmRequest(newPort, details);
      return retryResult.approved;
    }
  }

  // App didn't start in time — deny
  return false;
}

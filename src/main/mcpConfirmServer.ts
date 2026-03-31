import * as http from 'http';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { getConfig } from './ipc/configIpc';

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

type ShowConfirmCallback = (data: any) => BrowserWindow | null | Promise<BrowserWindow | null>;

let server: http.Server | null = null;
let port: number = 0;
let showConfirmUI: ShowConfirmCallback | null = null;
const pendingConfirmations = new Map<string, PendingConfirmation>();

const CONFIRMATION_TIMEOUT_MS = 60000;

/**
 * Register a callback that will be called when a confirmation request arrives.
 * The callback should show the appropriate UI (e.g. tray popup) and return
 * the BrowserWindow whose webContents will receive the IPC events.
 */
export function onConfirmRequest(callback: ShowConfirmCallback) {
  showConfirmUI = callback;
}

export function getConfirmPort(): number {
  return port;
}

export function startConfirmServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);
    server.on('error', (err) => {
      logger.error(`MCP confirm server error: ${err.message}`);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (address && typeof address !== 'string') {
        port = address.port;
      }
      logger.info(`MCP confirm server listening on 127.0.0.1:${port}`);
      resolve(port);
    });
  });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Health check endpoint for the MCP client to verify server is running
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/confirm') {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approved: false, reason: 'invalid_json' }));
      return;
    }

    // Auto-approve if mcpSkipConfirmation is enabled
    const config = getConfig();
    if (config.mcpSkipConfirmation) {
      logger.info('MCP mutation auto-approved (mcpSkipConfirmation enabled)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approved: true }));
      return;
    }

    const id = crypto.randomUUID();

    // Call the registered callback to show the UI and get the target window
    const callbackResult = showConfirmUI ? showConfirmUI({ id, ...data }) : null;
    const targetWindow = callbackResult instanceof Promise ? await callbackResult : callbackResult;

    if (!targetWindow || targetWindow.isDestroyed()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approved: false, reason: 'no_window' }));
      return;
    }

    // Send the confirmation data to the target window
    targetWindow.webContents.send('mcp-confirm-request', { id, ...data });

    // Wait for user response with timeout
    const timeout = setTimeout(() => {
      pendingConfirmations.delete(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approved: false, reason: 'timeout' }));
      if (!targetWindow.isDestroyed()) {
        targetWindow.webContents.send('mcp-confirm-timeout', id);
      }
    }, CONFIRMATION_TIMEOUT_MS);

    pendingConfirmations.set(id, {
      resolve: (approved: boolean) => {
        clearTimeout(timeout);
        pendingConfirmations.delete(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ approved }));
      },
      timeout
    });
  });
}

export function resolveConfirmation(id: string, approved: boolean) {
  const pending = pendingConfirmations.get(id);
  if (pending) {
    pending.resolve(approved);
  }
}

export function stopConfirmServer() {
  if (server) {
    server.close();
    server = null;
  }
  pendingConfirmations.forEach((p) => {
    clearTimeout(p.timeout);
    p.resolve(false);
  });
  pendingConfirmations.clear();
  port = 0;
}

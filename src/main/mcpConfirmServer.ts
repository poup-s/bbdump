import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { getConfig } from './ipc/configIpc';

/** The user's answer; `mask`: for a disclosure, the result columns to mask */
interface ConfirmAnswer { approved: boolean; mask?: string[] }

interface PendingConfirmation {
  resolve: (answer: ConfirmAnswer) => void;
  timeout: NodeJS.Timeout;
}

// Body posted by the MCP server (see mcp-postgres/src/confirm.ts), forwarded as-is to the UI
type ConfirmRequestData = Record<string, unknown>;

type ShowConfirmCallback = (data: ConfirmRequestData & { id: string }) => BrowserWindow | null | Promise<BrowserWindow | null>;

let server: http.Server | null = null;
let port: number = 0;
// Shared secret written (0600) to the port file next to the port. The MCP server
// sends it back in TOKEN_HEADER; anything without it (e.g. a web page POSTing to
// 127.0.0.1) is rejected.
let token: string = '';
export const TOKEN_HEADER = 'x-bbdump-token';
const MAX_BODY_BYTES = 64 * 1024;
let showConfirmUI: ShowConfirmCallback | null = null;
/** A database chat that can take the question itself (it returns false when that chat is not open) */
type ChatConfirmCallback = (data: ConfirmRequestData & { id: string; chatId: string }) => boolean;
let showInChat: ChatConfirmCallback | null = null;
let onChatTimeout: ((chatId: string, id: string) => void) | null = null;

/** The database chat asks the user itself the questions its own MCP server raises */
export function onChatConfirmRequest(show: ChatConfirmCallback, timedOut: (chatId: string, id: string) => void) {
  showInChat = show;
  onChatTimeout = timedOut;
}
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

export function getConfirmToken(): string {
  return token;
}

/**
 * Content of the port file: the port on the first line (what v1.0.x MCP servers
 * parse with parseInt), the auth token on the second line.
 */
export function formatPortFile(p: number, t: string): string {
  return `${p}\n${t}\n`;
}

/**
 * Write the port file atomically with mode 0600 (tmp + rename, so a v1.0.x file
 * created 0644 is replaced rather than rewritten in place).
 */
export function writePortFile(filePath: string, p: number, t: string): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, formatPortFile(p, t), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const provided = req.headers[TOKEN_HEADER];
  if (typeof provided !== 'string' || !token) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startConfirmServer(): Promise<number> {
  token = crypto.randomBytes(32).toString('hex');
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
  // Browsers always send Origin on cross-origin POSTs; the MCP server never does.
  if (req.headers.origin !== undefined) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401);
    res.end();
    return;
  }

  // Health check endpoint for the MCP client to verify server is running
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const pathname = (req.url || '/').split('?')[0];

  // Backups for the MCP server's list_backups (optionally one database's)
  if (req.method === 'GET' && pathname === '/backups') {
    const databaseId = new URLSearchParams((req.url || '').split('?')[1] || '').get('database') || undefined;
    import('./backupActions')
      .then(({ listBackupEntries }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backups: listBackupEntries(getConfig(), databaseId) }));
      })
      .catch((error) => {
        logger.error(`MCP backups listing failed: ${error}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      });
    return;
  }

  if (req.method !== 'POST' || !['/confirm', '/disclose', '/backup', '/undo', '/compare', '/tunnel'].includes(pathname)) {
    res.writeHead(404);
    res.end();
    return;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    res.writeHead(413, { Connection: 'close' });
    res.end();
    req.destroy();
    return;
  }

  let body = '';
  let received = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { Connection: 'close' });
      res.end();
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('end', async () => {
    if (aborted) return;
    let data: ConfirmRequestData;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ approved: false, reason: 'invalid_json' }));
      return;
    }

    // Back up now for the MCP server's create_backup: not destructive, no confirmation
    if (pathname === '/backup') {
      const databaseId = (data as unknown as { database?: unknown }).database;
      if (typeof databaseId !== 'string' || !getConfig().databases.some(d => d.id === databaseId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unknown database id' }));
        return;
      }
      logger.info(`MCP backup requested for ${databaseId}`);
      const started = Date.now();
      const { runBackupNow } = await import('./backupActions');
      const result = await runBackupNow(databaseId, (channel, payload) => {
        BrowserWindow.getAllWindows().forEach(w => { if (!w.isDestroyed()) w.webContents.send(channel, payload); });
      });
      let size: number | undefined;
      try {
        if (result.filePath) size = fs.statSync(result.filePath).size;
      } catch { /* removed meanwhile */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: result.success, error: result.error, path: result.filePath, size, duration: Date.now() - started }));
      return;
    }

    // MCP connection to a saved database behind SSH: open (or reuse) its tunnel
    if (pathname === '/tunnel') {
      const databaseId = (data as { database?: unknown }).database;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const db = typeof databaseId === 'string' ? getConfig().databases.find(d => d.id === databaseId) : undefined;
      if (!db?.ssh) {
        res.end(JSON.stringify({ success: false, error: 'Unknown database, or not reached through SSH' }));
        return;
      }
      try {
        const { ensureTunnel } = await import('./sshTunnel');
        const endpoint = await ensureTunnel(db.ssh);
        res.end(JSON.stringify({ success: true, ...endpoint }));
      } catch (error) {
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // MCP compare_databases: both databases only read, no confirmation
    if (pathname === '/compare') {
      const { source, target } = data as { source?: unknown; target?: unknown };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (typeof source !== 'string' || typeof target !== 'string') {
        res.end(JSON.stringify({ success: false, error: 'source and target ids are required' }));
        return;
      }
      try {
        const { compareDatabases } = await import('./sync/syncEngine');
        res.end(JSON.stringify({ success: true, analysis: await compareDatabases(source, target) }));
      } catch (error) {
        res.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    // Undo of an AI change (MCP undo_change): the user confirms, then bbdump restores the rows
    if (pathname === '/undo') {
      const changeId = (data as { id?: unknown }).id;
      const reply = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (typeof changeId !== 'string') return reply({ success: false, error: 'Missing change id' });
      const journal = await import('./aiJournal');
      let summary;
      try {
        summary = journal.journalEntrySummary(changeId);
      } catch (error) {
        return reply({ success: false, error: String(error instanceof Error ? error.message : error) });
      }
      if (summary.undoneAt) return reply({ success: false, error: `Already undone on ${summary.undoneAt}` });
      if (!summary.undo.available) return reply({ success: false, error: `This change has no undo point: ${summary.undo.reason ?? 'not captured'}` });
      const answer = await askUser({
        tool: 'undo_change',
        database: summary.connection.label ?? summary.connection.database,
        sql: summary.sql,
        description: `UNDO ${summary.tool} of ${new Date(summary.createdAt).toLocaleString()}: ${summary.description}. The ${summary.undo.rows} row(s) it touched get their previous state back.`,
      });
      if (!answer.approved) return reply({ success: false, refused: answer.reason !== 'timeout' && answer.reason !== 'no_window', error: answer.reason ?? 'refused' });
      return reply(await journal.undoChange(changeId));
    }

    // A result that may hold personal data, about to go to the AI: the user chooses what is masked
    if (pathname === '/disclose') {
      const answer = await showToUser({ ...data, kind: 'disclose' });
      // Nobody answered: the MCP server keeps its safe default (personal and unknown columns masked)
      const body = answer.reason ? { approved: true } : { approved: answer.approved, mask: answer.mask };
      logger.info(`MCP disclosure: ${answer.reason ?? (answer.approved ? `sent, ${answer.mask?.length ?? 0} column(s) masked` : 'blocked')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    const answer = await askUser(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
}

/**
 * Asks the user in the app (tray popup) to approve an AI write, or approves it when the
 * user turned confirmations off. Refused when nobody answers within 60 seconds.
 */
async function askUser(data: ConfirmRequestData): Promise<{ approved: boolean; reason?: 'timeout' | 'no_window' }> {
  if (getConfig().mcpSkipConfirmation) {
    logger.info('MCP mutation auto-approved (mcpSkipConfirmation enabled)');
    return { approved: true };
  }
  const { approved, reason } = await showToUser(data);
  return reason ? { approved, reason } : { approved };
}

/** Shows a request in the tray popup and waits for the answer (60 seconds at most) */
async function showToUser(data: ConfirmRequestData): Promise<ConfirmAnswer & { reason?: 'timeout' | 'no_window' }> {
  const id = crypto.randomUUID();
  // From a database chat that is open: asked in that chat, not in the tray
  const chatId = typeof data.chatId === 'string' ? data.chatId : '';
  if (chatId && showInChat?.({ id, ...data, chatId })) {
    return waitForAnswer(id, () => onChatTimeout?.(chatId, id));
  }
  // Call the registered callback to show the UI and get the target window
  const callbackResult = showConfirmUI ? showConfirmUI({ id, ...data }) : null;
  const targetWindow = callbackResult instanceof Promise ? await callbackResult : callbackResult;
  if (!targetWindow || targetWindow.isDestroyed()) return { approved: false, reason: 'no_window' };

  targetWindow.webContents.send('mcp-confirm-request', { id, ...data });
  return waitForAnswer(id, () => {
    if (!targetWindow.isDestroyed()) targetWindow.webContents.send('mcp-confirm-timeout', id);
  });
}

/** The answer to a request shown somewhere (tray or chat), or none after 60 seconds */
function waitForAnswer(id: string, onTimeout: () => void): Promise<ConfirmAnswer & { reason?: 'timeout' }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingConfirmations.delete(id);
      onTimeout();
      resolve({ approved: false, reason: 'timeout' });
    }, CONFIRMATION_TIMEOUT_MS);

    pendingConfirmations.set(id, {
      resolve: (answer: ConfirmAnswer) => {
        clearTimeout(timeout);
        pendingConfirmations.delete(id);
        resolve(answer);
      },
      timeout,
    });
  });
}

export function resolveConfirmation(id: string, approved: boolean, mask?: unknown) {
  const pending = pendingConfirmations.get(id);
  if (pending) {
    const columns = Array.isArray(mask) ? mask.filter((m): m is string => typeof m === 'string') : undefined;
    pending.resolve({ approved, mask: columns });
  }
}

export function stopConfirmServer() {
  if (server) {
    server.close();
    server = null;
  }
  token = '';
  pendingConfirmations.forEach((p) => {
    clearTimeout(p.timeout);
    p.resolve({ approved: false });
  });
  pendingConfirmations.clear();
  port = 0;
}

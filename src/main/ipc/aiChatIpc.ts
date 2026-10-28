/**
 * Database chat: runs the user's AI tool (Claude Code, Codex, OpenCode) with bbdump's MCP
 * server limited to one database and to reading, and streams what it does to the window
 * ('ai-chat-event'). Conversations are kept by the tool itself (its session id). With a local
 * model (Ollama, LM Studio) bbdump runs the conversation and keeps it while it runs.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathManager } from '../paths';
import { logger } from '../logger';
import { getConfig } from './configIpc';
import { getMcpLaunchSpec } from '../mcpLaunch';
import {
  CHAT_PROVIDERS, CLAUDE_MODELS, MODEL_RE, chatCommand, chatParser, chatPath, findBinary, parseOpencodeModels, type ChatEvent, type ChatProviderId,
} from '../aiChat/providers';
import {
  LOCAL_PROVIDERS, isLocalProvider, listLocalModels, runLocalChat, toOpenAiTools, type ChatMessage, type LocalProviderId,
} from '../aiChat/localModels';
import { McpStdioClient } from '../aiChat/mcpStdioClient';
import { onChatConfirmRequest } from '../mcpConfirmServer';
import { featureState } from '../featureFlags';
import { engineOf } from '../../shared/engines/features';
import { encryptionManager } from '../encryption';
import { ChatHistory, type ChatConversation } from '../aiChat/chatHistory';

type AnyProvider = ChatProviderId | LocalProviderId;

interface SendRequest {
  chatId: string;
  databaseId: string;
  provider: AnyProvider;
  message: string;
  systemPrompt: string;
  sessionId?: string;
  model?: string;
}

const running = new Map<string, { kill: () => void }>();
/** Local models: the conversations bbdump keeps (system message first), by session id */
const localSessions = new Map<string, ChatMessage[]>();
const MAX_LOCAL_SESSIONS = 30;
const MAX_LOCAL_HISTORY = 60;

/** Conversations kept (encrypted, 30 days unless pinned), apart from config.json */
let history: ChatHistory | null = null;
function chatHistory(): ChatHistory {
  history ??= new ChatHistory(path.join(pathManager.appDataPath, 'ai-chat-history'), {
    encrypt: text => encryptionManager.encrypt(text),
    decrypt: text => encryptionManager.decrypt(text),
  });
  return history;
}

/** A database removed from bbdump: its conversations go with it */
export function forgetChatHistory(databaseId: string): void {
  try {
    chatHistory().clear(databaseId);
  } catch (error) {
    logger.warn(`Chat history of ${databaseId} not removed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** A dashboard edit sends the dashboard's program with the request */
const MAX_MESSAGE = 120000;
const MAX_PROMPT = 60000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** An empty folder for the tools to run in: no project files around them */
function workspace(): string {
  const dir = path.join(pathManager.appDataPath, 'ai-chat');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isProvider(value: unknown): value is AnyProvider {
  return isLocalProvider(value) || (typeof value === 'string' && (CHAT_PROVIDERS as readonly string[]).includes(value));
}

const localLabel = (provider: LocalProviderId) => (provider === 'ollama' ? 'Ollama' : 'LM Studio');

export function stopAllChats(): void {
  for (const child of running.values()) child.kill();
  running.clear();
}

export function registerAiChatHandlers(getMainWindow: () => BrowserWindow | null) {
  const send = (chatId: string, event: ChatEvent) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('ai-chat-event', { chatId, ...event });
  };

  // What may reach the AI: asked in the chat whose MCP server raises the question (while it answers)
  onChatConfirmRequest((data) => {
    if (data.kind !== 'disclose' || !running.has(data.chatId)) return false;
    const columns = Array.isArray(data.columns) ? (data.columns as Array<Record<string, unknown>>).map(c => ({
      name: String(c.name ?? ''),
      origin: String(c.origin ?? 'unknown'),
      ...(typeof c.source === 'string' ? { source: c.source } : {}),
      samples: Array.isArray(c.samples) ? c.samples.map(String).slice(0, 3) : [],
      ...(Array.isArray(c.anonymized) ? { anonymized: c.anonymized.map(String).slice(0, 3) } : {}),
    })) : [];
    send(data.chatId, { type: 'disclose', requestId: data.id, rows: Number(data.rows) || 0, sql: typeof data.sql === 'string' ? data.sql : undefined, ...(data.engine === 'mongodb' ? { engine: 'mongodb' as const } : {}), columns });
    return true;
  }, (chatId, id) => send(chatId, { type: 'disclose-timeout', requestId: id }));

  /** AI tools found on this computer; a local model server counts when it is running */
  ipcMain.handle('ai-chat-providers', async () => [
    ...CHAT_PROVIDERS.map(id => ({ id, installed: !!findBinary(id), kind: 'cli' as const })),
    ...await Promise.all(LOCAL_PROVIDERS.map(async id => ({ id, installed: (await listLocalModels(id, 1500)).running, kind: 'local' as const }))),
  ]);

  /**
   * A local model: bbdump runs its MCP server (this database, reading only), gives the model
   * a few of its tools, runs the ones it asks for, until it answers
   */
  const startLocalChat = async (request: SendRequest & { provider: LocalProviderId }, mcp: { command: string; args: string[]; env: Record<string, string> }) => {
    const { chatId, provider, message, systemPrompt, sessionId, model } = request;
    const server = await listLocalModels(provider);
    if (!server.running) return { success: false, code: 'not_running', error: `${localLabel(provider)} is not running on this computer` };
    const chosen = model || server.models[0];
    if (!chosen) return { success: false, code: 'no_model', error: `${localLabel(provider)} has no model to chat with: download one first` };

    // A conversation reopened from the history after a restart: its messages come from there
    if (sessionId && !localSessions.has(sessionId)) {
      const saved = chatHistory().get(request.databaseId, chatId)?.localMessages;
      if (Array.isArray(saved) && saved.length) localSessions.set(sessionId, saved as ChatMessage[]);
    }
    const id = sessionId && localSessions.has(sessionId) ? sessionId : crypto.randomUUID();
    const messages: ChatMessage[] = localSessions.get(id) ?? [{ role: 'system', content: systemPrompt }];
    messages[0] = { role: 'system', content: systemPrompt };
    const before = messages.length;
    messages.push({ role: 'user', content: message });

    const controller = new AbortController();
    running.set(chatId, { kill: () => controller.abort() });
    send(chatId, { type: 'session', sessionId: id });
    logger.info(`AI chat: ${provider} (${chosen})${sessionId ? ' (continued)' : ''}`);
    const startedAt = Date.now();

    void (async () => {
      const client = new McpStdioClient(mcp.command, mcp.args, { ...process.env, ...mcp.env });
      try {
        await client.initialize();
        const tools = toOpenAiTools(await client.listTools());
        await runLocalChat({
          provider, model: chosen, messages, tools, signal: controller.signal,
          callTool: (name, args) => client.callTool(name, args),
          emit: event => send(chatId, event),
        });
      } catch (error) {
        // A stopped or failed turn leaves no half answer in the conversation
        messages.length = before;
        if (!controller.signal.aborted) send(chatId, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        client.close();
        running.delete(chatId);
        if (messages.length > MAX_LOCAL_HISTORY) messages.splice(1, messages.length - MAX_LOCAL_HISTORY);
        localSessions.delete(id);
        localSessions.set(id, messages);
        while (localSessions.size > MAX_LOCAL_SESSIONS) localSessions.delete(localSessions.keys().next().value!);
        send(chatId, { type: 'done' });
        logger.info(`AI chat: ${provider} answered in ${Math.round((Date.now() - startedAt) / 1000)} s`);
      }
    })();
    return { success: true };
  };

  ipcMain.handle('ai-chat-send', async (_e, request: SendRequest) => {
    const { chatId, databaseId, provider, message, systemPrompt, sessionId, model } = request ?? {} as SendRequest;
    if (typeof chatId !== 'string' || !chatId || running.has(chatId)) return { success: false, error: 'This chat is already answering' };
    if (!isProvider(provider)) return { success: false, error: 'Unknown AI tool' };
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE) return { success: false, error: 'Invalid message' };
    if (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_PROMPT) return { success: false, error: 'Invalid instructions' };
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId))) return { success: false, error: 'Invalid session' };
    if (model !== undefined && model !== '' && (typeof model !== 'string' || !MODEL_RE.test(model))) return { success: false, error: 'Invalid model' };
    const database = getConfig().databases.find(db => db.id === databaseId);
    if (!database) return { success: false, error: 'Database not found' };
    // A MongoDB database has the chat only while MongoDB is on
    const chatState = featureState(engineOf(database), 'chat');
    if (!chatState.enabled) return { success: false, error: 'The chat is not available for this database' };
    // bbdump's MCP server, as the AI assistants run it, limited to this database and to reading
    const spec = getMcpLaunchSpec();
    const mcp = { command: spec.command, args: spec.args, env: { ...spec.env, BBDUMP_MCP_DATABASE: database.id, BBDUMP_MCP_READ_ONLY: '1', BBDUMP_MCP_CHAT_ID: chatId } };
    if (isLocalProvider(provider)) return startLocalChat({ ...request, provider }, mcp);

    const binary = findBinary(provider);
    if (!binary) return { success: false, code: 'not_installed', error: `${provider} is not installed` };
    const command = chatCommand(provider, { message, systemPrompt, sessionId, model: model || undefined, mcp });

    const child = spawn(binary, command.args, {
      cwd: workspace(),
      env: { ...process.env, ...command.env, PATH: chatPath(binary) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    running.set(chatId, child);
    const startedAt = Date.now();
    logger.info(`AI chat: ${provider}${model ? ` (${model})` : ''} on ${database.displayName || database.name}${sessionId ? ' (continued)' : ''}`);

    const parse = chatParser(provider);
    let buffer = '';
    let stderr = '';
    let finished = false;
    let failed = false;
    const emit = (event: ChatEvent) => {
      if (event.type === 'done') return; // sent once, when the process ends
      if (event.type === 'error') failed = true;
      send(chatId, event);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        for (const event of parse(line)) emit(event);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);
    const finish = (code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.delete(chatId);
      for (const event of parse(buffer)) emit(event);
      if (error) emit({ type: 'error', message: error });
      else if (code !== 0 && !failed && !child.killed) {
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
        emit({ type: 'error', message: tail || `${provider} stopped (code ${code})` });
      }
      send(chatId, { type: 'done' });
      logger.info(`AI chat: ${provider} answered in ${Math.round((Date.now() - startedAt) / 1000)} s${code ? ` (code ${code})` : ''}`);
    };
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => { /* the tool may exit before reading */ });
    child.stdin?.end(command.stdin ?? '');
    return { success: true };
  });

  /** Models offered for a tool: Claude Code's aliases, OpenCode's configured models; Codex takes any name */
  ipcMain.handle('ai-chat-models', async (_e, provider: unknown) => {
    if (!isProvider(provider)) return { models: [] };
    if (isLocalProvider(provider)) return { models: (await listLocalModels(provider)).models };
    if (provider === 'claude') return { models: CLAUDE_MODELS };
    if (provider === 'codex') return { models: [] };
    const binary = findBinary('opencode');
    if (!binary) return { models: [] };
    const output = await new Promise<string>((resolve) => {
      execFile(binary, ['models'], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: chatPath(binary) }, windowsHide: true },
        (_error, stdout) => resolve(String(stdout || '')));
    });
    return { models: parseOpencodeModels(output) };
  });

  // --- History -------------------------------------------------------------------------
  const knownDatabase = (id: unknown): id is string => typeof id === 'string' && getConfig().databases.some(db => db.id === id);

  ipcMain.handle('ai-chat-history-list', (_e, databaseId: unknown) => (knownDatabase(databaseId) ? chatHistory().list(databaseId) : []));

  ipcMain.handle('ai-chat-history-get', (_e, databaseId: unknown, id: unknown) =>
    (knownDatabase(databaseId) && typeof id === 'string' ? chatHistory().get(databaseId, id) : null));

  ipcMain.handle('ai-chat-history-save', (_e, conversation: ChatConversation) => {
    if (!conversation || !knownDatabase(conversation.databaseId) || typeof conversation.id !== 'string' || !Array.isArray(conversation.messages)) return false;
    try {
      // A local model's conversation, to continue it after a restart
      const local = isLocalProvider(conversation.provider) && conversation.sessionId ? localSessions.get(conversation.sessionId) : undefined;
      chatHistory().save({
        id: conversation.id,
        databaseId: conversation.databaseId,
        provider: String(conversation.provider),
        ...(typeof conversation.model === 'string' && conversation.model ? { model: conversation.model } : {}),
        ...(typeof conversation.sessionId === 'string' ? { sessionId: conversation.sessionId } : {}),
        title: String(conversation.title || '').slice(0, 120),
        createdAt: String(conversation.createdAt || new Date().toISOString()),
        updatedAt: new Date().toISOString(),
        messages: conversation.messages,
        ...(local ? { localMessages: local } : {}),
      });
      return true;
    } catch (error) {
      logger.warn(`Chat conversation not kept: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });

  ipcMain.handle('ai-chat-history-pin', (_e, databaseId: unknown, id: unknown, pinned: unknown) =>
    (knownDatabase(databaseId) && typeof id === 'string' ? chatHistory().pin(databaseId, id, pinned === true) : false));

  ipcMain.handle('ai-chat-history-delete', (_e, databaseId: unknown, id: unknown) => {
    if (knownDatabase(databaseId) && typeof id === 'string') chatHistory().delete(databaseId, id);
    return true;
  });

  ipcMain.handle('ai-chat-history-clear', (_e, databaseId: unknown) => {
    if (databaseId === '*') chatHistory().clearAll();
    else if (knownDatabase(databaseId)) chatHistory().clear(databaseId);
    return true;
  });

  ipcMain.handle('ai-chat-stop', (_e, chatId: unknown) => {
    const child = typeof chatId === 'string' ? running.get(chatId) : undefined;
    if (!child) return false;
    child.kill();
    return true;
  });
}

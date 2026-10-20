/**
 * Chat with a local model (Ollama, LM Studio). These are model servers, not agents: bbdump
 * runs the conversation itself. It sends the question with the tools of its MCP server (a
 * short list of reading tools, enough for a small model), runs the tools the model asks for,
 * and sends their results back until the model answers. Both speak the OpenAI chat API on
 * this computer. No Electron import.
 */
import { masks, type ChatEvent } from './providers';
import type { McpTool } from './mcpStdioClient';

export type LocalProviderId = 'ollama' | 'lmstudio';
export const LOCAL_PROVIDERS: readonly LocalProviderId[] = ['ollama', 'lmstudio'];

export function isLocalProvider(value: unknown): value is LocalProviderId {
  return value === 'ollama' || value === 'lmstudio';
}

/** Where each server listens by default (OLLAMA_HOST is honoured, as by Ollama itself) */
export function localBaseUrl(provider: LocalProviderId, env: NodeJS.ProcessEnv = process.env): string {
  if (provider === 'lmstudio') return 'http://127.0.0.1:1234';
  const host = (env.OLLAMA_HOST || '').trim();
  if (!host) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return /:\d+$/.test(withScheme) ? withScheme : `${withScheme}:11434`;
}

/** The tools a local model is given: the ones that answer most questions, with short schemas */
export const LOCAL_TOOLS = [
  'get_schema_overview', 'list_tables', 'describe_table', 'execute_query', 'read_rows', 'count_rows',
  'search_table', 'find_column', 'profile_table', 'get_table_stats', 'get_database_size',
];

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toOpenAiTools(tools: McpTool[], allowed: readonly string[] = LOCAL_TOOLS): OpenAiTool[] {
  return tools.filter(t => allowed.includes(t.name)).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description ?? '').slice(0, 600),
      parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
    },
  }));
}

/** Models the server has: Ollama's installed models, LM Studio's available ones */
export function parseModelList(provider: LocalProviderId, body: unknown): string[] {
  const data = body as { models?: Array<{ name?: string; model?: string }>; data?: Array<{ id?: string }> } | null;
  const names = provider === 'ollama'
    ? (data?.models ?? []).map(m => m.name || m.model || '')
    : (data?.data ?? []).map(m => m.id || '');
  // Embedding models cannot chat
  return [...new Set(names.filter(n => n && !/embed/i.test(n)))];
}

export async function listLocalModels(provider: LocalProviderId, timeoutMs = 2500): Promise<{ running: boolean; models: string[] }> {
  const url = `${localBaseUrl(provider)}${provider === 'ollama' ? '/api/tags' : '/v1/models'}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { running: false, models: [] };
    return { running: true, models: parseModelList(provider, await response.json()) };
  } catch {
    return { running: false, models: [] };
  }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

interface PendingCall { id: string; name: string; arguments: string }

/**
 * Reads an OpenAI streamed answer ("data: {...}" lines): text as it comes, tool calls put
 * together from their pieces. Returns what the model said and asked.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<{ text: string; calls: PendingCall[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const calls: PendingCall[] = [];
  const handle = (line: string) => {
    const data = line.replace(/^data:\s*/, '').trim();
    if (!data || data === '[DONE]' || !data.startsWith('{')) return;
    const chunk = JSON.parse(data);
    const delta = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const piece of delta.tool_calls ?? []) {
      const index = typeof piece.index === 'number' ? piece.index : calls.length;
      calls[index] ??= { id: '', name: '', arguments: '' };
      if (piece.id) calls[index].id = piece.id;
      if (piece.function?.name) calls[index].name += piece.function.name;
      if (piece.function?.arguments) {
        calls[index].arguments += typeof piece.function.arguments === 'string' ? piece.function.arguments : JSON.stringify(piece.function.arguments);
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { handle(line); } catch { /* a line that is not JSON */ }
    }
  }
  if (buffer.trim()) {
    try { handle(buffer); } catch { /* ignore */ }
  }
  return { text, calls: calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}_${Date.now()}` })) };
}

export interface LocalChatRun {
  provider: LocalProviderId;
  model: string;
  /** The conversation so far, system message first; the new messages are added to it */
  messages: ChatMessage[];
  tools: OpenAiTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  maxSteps?: number;
}

const TOOL_RESULT_MAX = 12000;

/** One answer: model, tools, model… until it stops asking for tools */
export async function runLocalChat(run: LocalChatRun): Promise<void> {
  const url = `${localBaseUrl(run.provider)}/v1/chat/completions`;
  const steps = run.maxSteps ?? 12;
  for (let step = 0; step < steps; step++) {
    run.emit({ type: 'step' });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: run.model, messages: run.messages, tools: run.tools, stream: true }),
      signal: run.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`${run.provider === 'ollama' ? 'Ollama' : 'LM Studio'} answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const { text, calls } = await readStream(response.body, chunk => run.emit({ type: 'text', text: chunk, append: true }));
    run.messages.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })) } : {}),
    });
    if (!calls.length) return;
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      run.emit({ type: 'tool', id: call.id, name: call.name, input: args, status: 'running' });
      let result: { text: string; isError: boolean };
      try {
        result = LOCAL_TOOLS.includes(call.name)
          ? await run.callTool(call.name, args)
          : { text: `Unknown tool ${call.name}`, isError: true };
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true };
      }
      const content = result.text.length > TOOL_RESULT_MAX ? `${result.text.slice(0, TOOL_RESULT_MAX)}\n…(cut)` : result.text;
      run.emit({ type: 'tool', id: call.id, name: '', status: result.isError ? 'error' : 'done', output: content.slice(0, 2000), ...masks(result.text) });
      run.messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  run.emit({ type: 'error', message: 'The model kept asking for tools without answering: ask a narrower question.' });
}

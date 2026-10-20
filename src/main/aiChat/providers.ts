/**
 * The AI tools the database chat drives: Claude Code (`claude -p`), Codex (`codex exec`)
 * and OpenCode (`opencode run`). Each is given bbdump's MCP server alone, limited to the
 * chat's database and to reading, without its own tools (shell, files, web). This module
 * builds the command and reads the tool's JSON output into common events. No Electron
 * import: tested as is.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ChatProviderId = 'claude' | 'codex' | 'opencode';
export const CHAT_PROVIDERS: readonly ChatProviderId[] = ['claude', 'codex', 'opencode'];

export interface McpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ChatRunInput {
  message: string;
  /** bbdump's instructions and the display rules (OpenUI) */
  systemPrompt: string;
  /** The tool's own session id, to continue a conversation */
  sessionId?: string;
  /** A model of the tool (sonnet, openai/gpt-5…); its default when absent */
  model?: string;
  mcp: McpSpec;
}

/** What a model name may hold: names, ids and provider/model pairs, nothing a shell could read */
export const MODEL_RE = /^[\w.:@/-]{1,120}$/;

/** Claude Code's model aliases (any full model id works too) */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

/** `opencode models`: one provider/model per line */
export function parseOpencodeModels(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map(l => l.trim()).filter(l => /^[\w.-]+\/\S+$/.test(l) && MODEL_RE.test(l)))];
}

export interface ChatCommand {
  args: string[];
  env: Record<string, string>;
  /** Written to the tool's standard input (the message, so it is never read as an option) */
  stdin?: string;
}

/** What the chat shows, the same for every tool */
export type ChatEvent =
  | { type: 'session'; sessionId: string }
  /** A new assistant message: following text starts a new block */
  | { type: 'step' }
  | { type: 'text'; text: string; append: boolean }
  /** masked: columns bbdump's MCP server anonymized in this result ("Anonymize for AI") */
  | { type: 'tool'; id: string; name: string; input?: unknown; status: 'running' | 'done' | 'error'; output?: string; masked?: string[] }
  | { type: 'error'; message: string }
  /** bbdump asks the user before a result of unknown origin reaches the AI ("Anonymize for AI") */
  | { type: 'disclose'; requestId: string; rows: number; sql?: string; columns: Array<{ name: string; origin: string; source?: string; samples: string[]; anonymized?: string[] }> }
  | { type: 'disclose-timeout'; requestId: string }
  | { type: 'done' };

/** The MCP server's name in every tool's configuration (its tools: mcp__bbdump__x, bbdump_x…) */
export const MCP_NAME = 'bbdump';

const clip = (value: unknown, max = 2000): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Columns a bbdump MCP result says it anonymized: "masked_columns": [...] (JSON results) or
 * "masked_columns: a,b · …" (Markdown and CSV results). Read before the result is cut.
 */
export function maskedColumnsIn(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const json = /"masked_columns"\s*:\s*(\[[^\]]*\])/.exec(text);
  if (json) {
    try {
      const list = JSON.parse(json[1]);
      if (Array.isArray(list) && list.length) return list.map(String);
    } catch {
      // fall through
    }
  }
  const plain = /(?:^|[\s·])masked_columns: ([^·\n]+)/.exec(text);
  const list = plain?.[1].split(',').map(c => c.trim()).filter(Boolean);
  return list?.length ? list : undefined;
}

/** { masked } when the result anonymized columns, else nothing (events stay small) */
export function masks(text: string | undefined): { masked?: string[] } {
  const masked = maskedColumnsIn(text);
  return masked ? { masked } : {};
}

/** A tool name without its MCP prefix: mcp__bbdump__execute_query, bbdump_execute_query → execute_query */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(new RegExp(`^${MCP_NAME}_`), '');
}

// --- Claude Code ---------------------------------------------------------------------

function claudeCommand(input: ChatRunInput): ChatCommand {
  const mcpConfig = JSON.stringify({ mcpServers: { [MCP_NAME]: input.mcp } });
  return {
    args: [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      // No shell, files or web: bbdump's MCP tools only
      '--tools', '',
      '--allowedTools', `mcp__${MCP_NAME}`,
      // Not the user's settings, hooks or project instructions
      '--setting-sources', '',
      '--append-system-prompt', input.systemPrompt,
      ...(input.model ? ['--model', input.model] : []),
      ...(input.sessionId ? ['--resume', input.sessionId] : []),
    ],
    // Nor the user's memory (it is loaded even without settings): the chat starts clean
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    stdin: input.message,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return clip(content);
}

function claudeParser(): (line: string) => ChatEvent[] {
  let streamed = false;
  return (line) => {
    const m = JSON.parse(line);
    const out: ChatEvent[] = [];
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) out.push({ type: 'session', sessionId: m.session_id });
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start') out.push({ type: 'step' });
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        streamed = true;
        out.push({ type: 'text', text: e.delta.text, append: true });
      }
    }
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') out.push({ type: 'tool', id: block.id, name: shortToolName(block.name), input: block.input, status: 'running' });
        // Without partial messages (older versions), the text comes whole
        if (block.type === 'text' && !streamed) out.push({ type: 'text', text: block.text, append: false });
      }
    }
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content);
          out.push({ type: 'tool', id: block.tool_use_id, name: '', status: block.is_error ? 'error' : 'done', output: clip(text), ...masks(text) });
        }
      }
    }
    if (m.type === 'result') {
      if (m.is_error) out.push({ type: 'error', message: String(m.result || m.subtype || 'Claude Code failed') });
      out.push({ type: 'done' });
    }
    return out;
  };
}

// --- Codex -----------------------------------------------------------------------------

/** A TOML value (Codex -c overrides): JSON strings are valid TOML basic strings */
export function toml(value: string | string[] | Record<string, string>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`;
}

function codexCommand(input: ChatRunInput): ChatCommand {
  const server = `mcp_servers.${MCP_NAME}`;
  const flags = [
    '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
    ...(input.model ? ['-m', input.model] : []),
    '-c', `${server}.command=${toml(input.mcp.command)}`,
    '-c', `${server}.args=${toml(input.mcp.args)}`,
    '-c', `${server}.env=${toml(input.mcp.env)}`,
    '-c', `${server}.required=true`,
  ];
  // Codex has no option for extra instructions: they open the first message
  const message = input.sessionId ? input.message : `${input.systemPrompt}\n\n---\n\n${input.message}`;
  return {
    args: input.sessionId ? ['exec', ...flags, 'resume', input.sessionId, '-'] : ['exec', ...flags, '-'],
    env: {},
    stdin: message,
  };
}

function codexParser(): (line: string) => ChatEvent[] {
  return (line) => {
    const m = JSON.parse(line);
    const out: ChatEvent[] = [];
    if (m.type === 'thread.started' && m.thread_id) out.push({ type: 'session', sessionId: m.thread_id });
    const item = m.item;
    if (item?.type === 'mcp_tool_call') {
      const status = m.type === 'item.started' ? 'running' : item.status === 'failed' || item.error ? 'error' : 'done';
      const text = item.result ? toolResultText(item.result.content ?? item.result) : undefined;
      const output = item.error ? clip(item.error.message ?? item.error) : text !== undefined ? clip(text) : undefined;
      out.push({ type: 'tool', id: String(item.id), name: shortToolName(String(item.tool ?? '')), input: item.arguments, status, output, ...masks(text) });
    }
    if (item?.type === 'agent_message' && m.type === 'item.completed') out.push({ type: 'step' }, { type: 'text', text: String(item.text ?? ''), append: false });
    if (m.type === 'turn.failed') out.push({ type: 'error', message: String(m.error?.message ?? 'Codex failed') });
    if (m.type === 'error') out.push({ type: 'error', message: String(m.message ?? 'Codex failed') });
    if (m.type === 'turn.completed' || m.type === 'turn.failed') out.push({ type: 'done' });
    return out;
  };
}

// --- OpenCode --------------------------------------------------------------------------

function opencodeCommand(input: ChatRunInput): ChatCommand {
  const onlyBbdump = { '*': false, [`${MCP_NAME}_*`]: true };
  const config = {
    mcp: { [MCP_NAME]: { type: 'local', command: [input.mcp.command, ...input.mcp.args], environment: input.mcp.env, enabled: true } },
    tools: onlyBbdump,
    agent: { bbdump: { description: 'bbdump database chat', mode: 'primary', prompt: input.systemPrompt, tools: onlyBbdump } },
  };
  return {
    args: ['run', '--format', 'json', '--agent', 'bbdump', ...(input.model ? ['--model', input.model] : []), ...(input.sessionId ? ['--session', input.sessionId] : []), '--', input.message],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  };
}

function opencodeParser(): (line: string) => ChatEvent[] {
  let session = '';
  return (line) => {
    const m = JSON.parse(line);
    const out: ChatEvent[] = [];
    if (m.sessionID && m.sessionID !== session) {
      session = m.sessionID;
      out.push({ type: 'session', sessionId: session });
    }
    const part = m.part ?? {};
    if (m.type === 'step_start') out.push({ type: 'step' });
    if (m.type === 'text' && part.text) out.push({ type: 'text', text: String(part.text), append: false });
    if (m.type === 'tool_use') {
      const state = part.state ?? {};
      const status = state.status === 'error' ? 'error' : state.status === 'completed' ? 'done' : 'running';
      const output = state.error ? clip(state.error) : state.output ? clip(state.output) : undefined;
      out.push({ type: 'tool', id: String(part.callID ?? part.id ?? ''), name: shortToolName(String(part.tool ?? '')), input: state.input, status, output, ...masks(typeof state.output === 'string' ? state.output : undefined) });
    }
    if (m.type === 'error') out.push({ type: 'error', message: String(m.error?.data?.message ?? m.error?.message ?? m.error?.name ?? 'OpenCode failed') });
    return out;
  };
}

// --- Common ----------------------------------------------------------------------------

export function chatCommand(provider: ChatProviderId, input: ChatRunInput): ChatCommand {
  if (provider === 'claude') return claudeCommand(input);
  if (provider === 'codex') return codexCommand(input);
  return opencodeCommand(input);
}

/** Reads the tool's output line by line; a line that is not JSON is ignored */
export function chatParser(provider: ChatProviderId): (line: string) => ChatEvent[] {
  const parse = provider === 'claude' ? claudeParser() : provider === 'codex' ? codexParser() : opencodeParser();
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    try {
      return parse(trimmed);
    } catch {
      return [];
    }
  };
}

/** Where each tool usually lives (a GUI app gets a short PATH), before PATH itself */
export function binaryCandidates(provider: ChatProviderId, home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const exe = platform === 'win32' ? '.exe' : '';
  const dirs = platform === 'win32'
    ? [path.join(home, '.local', 'bin'), path.join(home, `.${provider}`, 'bin')]
    : [
      path.join(home, '.local', 'bin'), path.join(home, `.${provider}`, 'bin'), path.join(home, '.claude', 'local'),
      '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'),
    ];
  return dirs.map(dir => path.join(dir, provider + exe));
}

export function findBinary(provider: ChatProviderId, pathEnv = process.env.PATH || '', home = os.homedir(), platform: NodeJS.Platform = process.platform): string | null {
  const exe = platform === 'win32' ? '.exe' : '';
  const fromPath = pathEnv.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, provider + exe));
  for (const candidate of [...binaryCandidates(provider, home, platform), ...fromPath]) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** PATH for the tool: its own folder and the usual ones first (Codex is a Node script) */
export function chatPath(binary: string, pathEnv = process.env.PATH || '', home = os.homedir()): string {
  const extra = [path.dirname(binary), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin')];
  return [...new Set([...extra, ...pathEnv.split(path.delimiter)].filter(Boolean))].join(path.delimiter);
}

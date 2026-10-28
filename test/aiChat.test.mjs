// Database chat: the AI tools' commands and output, the MCP server limited to one database
// and to reading, and how answers are split for display.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();
const providers = require(path.join(root, 'dist/main/aiChat/providers.js'));
const scope = await import(pathToFileURL(path.join(root, 'mcp-postgres/build/chatScope.js')).href);

// Renderer modules are TypeScript compiled by Vite: transform them on the fly
const { transformSync } = require('esbuild');
const load = (file) => {
  const compiled = transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
  return mod.exports;
};
const { splitOpenUi } = load('src/renderer/src/chat/messageParts.ts');
const { markdownLite, isSqlBlock } = load('src/renderer/src/chat/markdownLite.ts');
const { applyChatEvent } = load('src/renderer/src/chat/chatEvents.ts');

const mcp = { command: '/Applications/bbdump.app/Contents/MacOS/bbdump', args: ['/x/mcp-postgres/index.js'], env: { ELECTRON_RUN_AS_NODE: '1', BBDUMP_MCP_DATABASE: 'db1', BBDUMP_MCP_READ_ONLY: '1' } };
const input = { message: '--help me', systemPrompt: 'You are bbdump.', mcp };

describe('commands', () => {
  test('Claude Code: bbdump MCP only, no built-in tool, no user settings, message on stdin', () => {
    const c = providers.chatCommand('claude', input);
    assert.equal(c.stdin, '--help me');
    assert.ok(!c.args.includes('--help me'));
    assert.equal(c.args[c.args.indexOf('--tools') + 1], '');
    assert.equal(c.args[c.args.indexOf('--allowedTools') + 1], 'mcp__bbdump');
    assert.equal(c.args[c.args.indexOf('--setting-sources') + 1], '');
    // The user's memory stays out of the chat
    assert.equal(c.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.ok(c.args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(c.args[c.args.indexOf('--mcp-config') + 1]), { mcpServers: { bbdump: mcp } });
    assert.ok(!c.args.includes('--resume'));
    const next = providers.chatCommand('claude', { ...input, sessionId: 'abc-123' });
    assert.equal(next.args[next.args.indexOf('--resume') + 1], 'abc-123');
  });

  test('Codex: read-only sandbox, the MCP server as TOML overrides, instructions in the first message only', () => {
    const c = providers.chatCommand('codex', input);
    assert.deepEqual(c.args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']);
    assert.ok(c.args.includes(`mcp_servers.bbdump.command="${mcp.command}"`));
    assert.ok(c.args.includes('mcp_servers.bbdump.args=["/x/mcp-postgres/index.js"]'));
    assert.ok(c.args.includes('mcp_servers.bbdump.env={ "ELECTRON_RUN_AS_NODE" = "1", "BBDUMP_MCP_DATABASE" = "db1", "BBDUMP_MCP_READ_ONLY" = "1" }'));
    assert.equal(c.args.at(-1), '-');
    assert.match(c.stdin, /^You are bbdump\.\n\n---\n\n--help me$/);
    const next = providers.chatCommand('codex', { ...input, sessionId: 'th_1' });
    assert.deepEqual(next.args.slice(-3), ['resume', 'th_1', '-']);
    assert.equal(next.stdin, '--help me');
  });

  test('OpenCode: an agent with the instructions, bbdump tools only, the message after --', () => {
    const c = providers.chatCommand('opencode', { ...input, sessionId: 'ses_1' });
    assert.deepEqual(c.args.slice(-2), ['--', '--help me']);
    assert.equal(c.args[c.args.indexOf('--session') + 1], 'ses_1');
    const config = JSON.parse(c.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.mcp.bbdump.command, [mcp.command, ...mcp.args]);
    assert.deepEqual(config.tools, { '*': false, 'bbdump_*': true });
    assert.equal(config.agent.bbdump.prompt, 'You are bbdump.');
  });

  test('tool names without their MCP prefix', () => {
    assert.equal(providers.shortToolName('mcp__bbdump__execute_query'), 'execute_query');
    assert.equal(providers.shortToolName('bbdump_get_schema_overview'), 'get_schema_overview');
    assert.equal(providers.toml(['a"b']), '["a\\"b"]');
  });
});

describe('reading the tools\' output', () => {
  test('Claude Code stream-json: session, streamed text, tool call and result, end', () => {
    const parse = providers.chatParser('claude');
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's1', tools: [] },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Look' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Look' }, { type: 'tool_use', id: 't1', name: 'mcp__bbdump__execute_query', input: { sql: 'select 1' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '| n |' }] }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done' },
    ].map(l => JSON.stringify(l));
    const events = lines.flatMap(parse);
    assert.deepEqual(events, [
      { type: 'session', sessionId: 's1' },
      { type: 'step' },
      { type: 'text', text: 'Look', append: true },
      { type: 'tool', id: 't1', name: 'execute_query', input: { sql: 'select 1' }, status: 'running' },
      { type: 'tool', id: 't1', name: '', status: 'done', output: '| n |' },
      { type: 'done' },
    ]);
    assert.deepEqual(parse('not json'), []);
    assert.deepEqual(providers.chatParser('claude')(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })), [{ type: 'error', message: 'Not logged in' }, { type: 'done' }]);
  });

  test('Codex JSONL: thread, MCP tool call, agent message, failure', () => {
    const parse = providers.chatParser('codex');
    const events = [
      { type: 'thread.started', thread_id: 'th_1' },
      { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'bbdump', tool: 'execute_query', arguments: { sql: 'select 1' }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'bbdump', tool: 'execute_query', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Answer' } },
      { type: 'turn.failed', error: { message: 'quota' } },
    ].flatMap(l => parse(JSON.stringify(l)));
    assert.deepEqual(events.map(e => e.type + (e.status ? `:${e.status}` : '')), ['session', 'tool:running', 'tool:done', 'step', 'text', 'error', 'done']);
    assert.equal(events.find(e => e.type === 'text').text, 'Answer');
  });

  test('OpenCode JSON: session from any event, tool states, text, error message', () => {
    const parse = providers.chatParser('opencode');
    const events = [
      { type: 'step_start', sessionID: 'ses_1', part: {} },
      { type: 'tool_use', sessionID: 'ses_1', part: { callID: 'c1', tool: 'bbdump_execute_query', state: { status: 'completed', input: { sql: 'select 1' }, output: 'ok' } } },
      { type: 'text', sessionID: 'ses_1', part: { text: 'Answer' } },
      { type: 'error', sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'Cannot connect to API' } } },
    ].flatMap(l => parse(JSON.stringify(l)));
    assert.deepEqual(events, [
      { type: 'session', sessionId: 'ses_1' },
      { type: 'step' },
      { type: 'tool', id: 'c1', name: 'execute_query', input: { sql: 'select 1' }, status: 'done', output: 'ok' },
      { type: 'text', text: 'Answer', append: false },
      { type: 'error', message: 'Cannot connect to API' },
    ]);
  });
});

test('MCP server in a chat: read tools only, this database only', () => {
  assert.equal(scope.toolAllowed('execute_write_query', { readOnlyHint: false }, true), false);
  assert.equal(scope.toolAllowed('create_backup', { readOnlyHint: false, destructiveHint: false }, true), false);
  assert.equal(scope.toolAllowed('execute_query', { readOnlyHint: true }, true), true);
  assert.equal(scope.toolAllowed('use_connection', { readOnlyHint: false }, true), true);
  assert.equal(scope.toolAllowed('execute_write_query', { readOnlyHint: false }, false), true);
  assert.equal(scope.databaseAllowed('db2', 'db1'), false);
  assert.equal(scope.databaseAllowed('db1', 'db1'), true);
  assert.equal(scope.databaseAllowed('db2', ''), true);
});

describe('display', () => {
  test('answers split into text and OpenUI programs, the last one possibly still streaming', () => {
    assert.deepEqual(splitOpenUi('Here:\n```openui\nroot = Stack([t])\nt = Text("a")\n```\nDone.'), [
      { kind: 'text', text: 'Here:' },
      { kind: 'ui', source: 'root = Stack([t])\nt = Text("a")\n', complete: true },
      { kind: 'text', text: 'Done.' },
    ]);
    assert.deepEqual(splitOpenUi('Wait\n```openui\nroot = Stack(['), [{ kind: 'text', text: 'Wait' }, { kind: 'ui', source: 'root = Stack([', complete: false }]);
    assert.deepEqual(splitOpenUi('root = Stack([])'), [{ kind: 'ui', source: 'root = Stack([])', complete: true }]);
    assert.deepEqual(splitOpenUi('Just text'), [{ kind: 'text', text: 'Just text' }]);
  });

  test('a little Markdown, never HTML', () => {
    assert.deepEqual(markdownLite('# Title\nSome **bold** and `code`\n\n- a\n- b\n1. one\n```\nselect 1\n```\n<b>x</b>'), [
      { type: 'h', inlines: [{ text: 'Title' }] },
      { type: 'p', inlines: [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'code', code: true }] },
      { type: 'ul', items: [[{ text: 'a' }], [{ text: 'b' }]] },
      { type: 'ol', items: [[{ text: 'one' }]] },
      { type: 'code', text: 'select 1' },
      { type: 'p', inlines: [{ text: '<b>x</b>' }] },
    ]);
  });

  test('events fill the answer: streamed text, tool status, a new block after a tool, end', () => {
    const chat = { chatId: 'c', databaseId: 'd', provider: 'claude', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', blocks: [], done: false }], busy: true, newBlock: true };
    const apply = (e) => applyChatEvent(chat, { chatId: 'c', ...e });
    apply({ type: 'session', sessionId: 's1' });
    apply({ type: 'text', text: 'Hel', append: true });
    apply({ type: 'text', text: 'lo', append: true });
    apply({ type: 'tool', id: 't', name: 'execute_query', status: 'running' });
    apply({ type: 'tool', id: 't', name: '', status: 'done', output: 'ok' });
    apply({ type: 'text', text: 'After', append: true });
    apply({ type: 'done' });
    const answer = chat.messages[1];
    assert.equal(chat.sessionId, 's1');
    assert.deepEqual(answer.blocks, [
      { type: 'text', text: 'Hello' },
      { type: 'tool', id: 't', name: 'execute_query', input: undefined, status: 'done', output: 'ok' },
      { type: 'text', text: 'After' },
    ]);
    assert.equal(answer.done, true);
    assert.equal(chat.busy, false);
  });
});

test('a chosen model goes to each tool; OpenCode\'s model list is read from `opencode models`', () => {
  const claude = providers.chatCommand('claude', { ...input, model: 'opus' });
  assert.equal(claude.args[claude.args.indexOf('--model') + 1], 'opus');
  assert.ok(!providers.chatCommand('claude', input).args.includes('--model'));
  const codex = providers.chatCommand('codex', { ...input, model: 'gpt-5' });
  assert.equal(codex.args[codex.args.indexOf('-m') + 1], 'gpt-5');
  const opencode = providers.chatCommand('opencode', { ...input, model: 'lmstudio/qwen/qwen3-coder-30b' });
  assert.equal(opencode.args[opencode.args.indexOf('--model') + 1], 'lmstudio/qwen/qwen3-coder-30b');
  assert.ok(opencode.args.indexOf('--model') < opencode.args.indexOf('--'));
  assert.deepEqual(providers.parseOpencodeModels('opencode/big-pickle\nlmstudio/qwen/qwen3-30b-a3b-2507\n\nWarning: something\nbad model/x y\n'), ['opencode/big-pickle', 'lmstudio/qwen/qwen3-30b-a3b-2507']);
  assert.equal(providers.MODEL_RE.test('claude-sonnet-4-5@20250929'), true);
  assert.equal(providers.MODEL_RE.test('x; rm -rf'), false);
});

describe('local models (Ollama, LM Studio)', () => {
  const local = require(path.join(root, 'dist/main/aiChat/localModels.js'));
  const sse = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

  test('server addresses, model lists without embedding models, a short list of reading tools', () => {
    assert.equal(local.localBaseUrl('lmstudio', {}), 'http://127.0.0.1:1234');
    assert.equal(local.localBaseUrl('ollama', {}), 'http://127.0.0.1:11434');
    assert.equal(local.localBaseUrl('ollama', { OLLAMA_HOST: '0.0.0.0' }), 'http://0.0.0.0:11434');
    assert.deepEqual(local.parseModelList('ollama', { models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] }), ['qwen3:8b']);
    assert.deepEqual(local.parseModelList('lmstudio', { data: [{ id: 'qwen/qwen3-coder-30b' }, { id: 'text-embedding-nomic' }] }), ['qwen/qwen3-coder-30b']);
    const tools = local.toOpenAiTools([{ name: 'execute_query', description: 'Run SQL', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } }, { name: 'list_locks' }]);
    assert.deepEqual(tools.map(t => t.function.name), ['execute_query']);
    assert.equal(tools[0].type, 'function');
  });

  test('a streamed answer: text pieces, and a tool call put together from its pieces', async () => {
    const seen = [];
    const result = await local.readStream(sse([
      data({ choices: [{ delta: { content: 'Let me ' } }] }),
      data({ choices: [{ delta: { content: 'look.' } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'execute_', arguments: '{"sql":' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'query', arguments: '"select 1"}' } }] } }] }),
      'data: [DONE]\n\n',
    ]), t => seen.push(t));
    assert.deepEqual(seen, ['Let me ', 'look.']);
    assert.equal(result.text, 'Let me look.');
    assert.deepEqual(result.calls, [{ id: 'c1', name: 'execute_query', arguments: '{"sql":"select 1"}' }]);
  });

  test('a whole turn: the model asks for a query, bbdump runs it, the model answers', async () => {
    const answers = [
      [data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'execute_query', arguments: '{"sql":"select count(*) from items"}' } }] } }] })],
      [data({ choices: [{ delta: { content: 'There are 3 items.' } }] })],
    ];
    const bodies = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(sse(answers.shift())); };
    try {
      const events = [];
      const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'How many items?' }];
      const calls = [];
      await local.runLocalChat({
        provider: 'lmstudio', model: 'qwen', messages, tools: [], signal: new AbortController().signal,
        callTool: async (name, args) => { calls.push([name, args]); return { text: '| n |\n| 3 |', isError: false }; },
        emit: e => events.push(e),
      });
      assert.deepEqual(calls, [['execute_query', { sql: 'select count(*) from items' }]]);
      assert.deepEqual(events.map(e => e.type + (e.status ? `:${e.status}` : '')), ['step', 'tool:running', 'tool:done', 'step', 'text']);
      assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
      assert.equal(messages[3].content, '| n |\n| 3 |');
      assert.equal(bodies[1].messages.length, 4);
      assert.equal(bodies[0].stream, true);
      // A tool outside the short list is refused, not run
      const refused = [];
      answers.push([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'execute_write_query', arguments: '{}' } }] } }] })], [data({ choices: [{ delta: { content: 'ok' } }] })]);
      await local.runLocalChat({ provider: 'ollama', model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, callTool: async () => { refused.push('ran'); return { text: '', isError: false }; }, emit: e => refused.push(e.type + (e.status ? `:${e.status}` : '')) });
      assert.ok(!refused.includes('ran'));
      assert.ok(refused.includes('tool:error'));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('SQL code blocks are recognised (folded in the chat), other code is not', () => {
  const [sql, other, bare] = markdownLite('```sql\nselect 1\n```\n```json\n{"a":1}\n```\n```\nWITH x AS (select 1) select * from x\n```').filter(b => b.type === 'code');
  assert.equal(sql.lang, 'sql');
  assert.equal(isSqlBlock(sql), true);
  assert.equal(isSqlBlock(other), false);
  assert.equal(isSqlBlock(bare), true);
});

test('columns anonymized in a result are read from the MCP answer (JSON and Markdown)', () => {
  assert.deepEqual(providers.maskedColumnsIn('{"row_count":2,"masked_columns":["email","name"],"masking":"…","rows":[]}'), ['email', 'name']);
  assert.deepEqual(providers.maskedColumnsIn('row_count: 2 · truncated: false · masked_columns: email,name · masking: Some values…\n\n| a |'), ['email', 'name']);
  assert.equal(providers.maskedColumnsIn('row_count: 2 · truncated: false'), undefined);
  // MongoDB results say masked_fields (paths), as JSON or in the Markdown header
  assert.deepEqual(providers.maskedColumnsIn('{"collection":"users","masked_fields":["email","customer.email"],"documents":[]}'), ['email', 'customer.email']);
  assert.deepEqual(providers.maskedColumnsIn('collection: users\nmasked_fields: ["email","phone"]\nreturned: 2\n\n| email |'), ['email', 'phone']);
  assert.deepEqual(providers.masks('{"masked_columns":[]}'), {});
  const event = providers.chatParser('claude')(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'row_count: 1 · masked_columns: email · masking: x\n\n| email |' }] }] } }))[0];
  assert.deepEqual(event.masked, ['email']);
});

test('a question about what may reach the AI shows in the chat, and ends when the turn ends', () => {
  const chat = { chatId: 'c', databaseId: 'd', provider: 'claude', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', blocks: [], done: false }], busy: true, newBlock: true };
  applyChatEvent(chat, { chatId: 'c', type: 'disclose', requestId: 'r1', rows: 3, columns: [{ name: 'e', origin: 'unknown', samples: ['A@X'] }] });
  const block = chat.messages[1].blocks[0];
  assert.equal(block.type, 'disclose');
  assert.equal(block.status, 'pending');
  applyChatEvent(chat, { chatId: 'c', type: 'disclose', requestId: 'r2', rows: 1, engine: 'mongodb', columns: [] });
  assert.equal(chat.messages[1].blocks[1].engine, 'mongodb', 'a MongoDB question says so (fields, documents)');
  assert.equal(block.engine, undefined);
  applyChatEvent(chat, { chatId: 'c', type: 'disclose-timeout', requestId: 'r1' });
  assert.equal(block.status, 'timeout');
  applyChatEvent(chat, { chatId: 'c', type: 'done' });
  assert.equal(chat.messages[1].blocks[1].status, 'timeout');
});

test('the chat previews exactly what the MCP server sends for an anonymized value', async () => {
  const { partialPreview } = load('src/renderer/src/chat/maskPreview.ts');
  const { partialValue } = await import(pathToFileURL(path.join(root, 'mcp-postgres/build/masking.js')).href);
  for (const v of ['ALICE.REAL@EXAMPLE.ORG', 'bob1234@email.fr', '+33 6 12 34 56 78', 'Sebastien Poupi', 'Lyon', 'x']) {
    assert.equal(partialPreview(v), partialValue(v), v);
  }
});

test('chat history: encrypted files, 30 days unless pinned, per database', () => {
  const { ChatHistory, RETENTION_DAYS } = require(path.join(root, 'dist/main/aiChat/chatHistory.js'));
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdump-chat-history-'));
  try {
    let now = Date.parse('2026-10-20T10:00:00Z');
    const cipher = { encrypt: t => Buffer.from(t).toString('base64'), decrypt: t => Buffer.from(t, 'base64').toString() };
    const h = new ChatHistory(dir, cipher, () => now);
    const at = (d) => new Date(d).toISOString();
    const conv = (id, updated, extra = {}) => ({ id, databaseId: 'db-1', provider: 'claude', title: `Q ${id}`, createdAt: at(updated), updatedAt: at(updated), messages: [{ role: 'user', text: 'secret question' }], ...extra });
    h.save(conv('a', now - 1000));
    h.save(conv('b', now - 2000));
    // Encrypted on disk: the question is not readable as is
    const raw = fs.readFileSync(path.join(dir, 'db-1', 'a.json'), 'utf8');
    assert.ok(!raw.includes('secret question'));
    assert.deepEqual(h.list('db-1').map(c => c.id), ['a', 'b']);
    assert.equal(h.get('db-1', 'a').messages[0].text, 'secret question');
    // Pinned first, and kept past the retention; the pin survives a save without it
    assert.equal(h.pin('db-1', 'b', true), true);
    h.save(conv('b', now - 1500));
    assert.deepEqual(h.list('db-1').map(c => [c.id, c.pinned]), [['b', true], ['a', false]]);
    now += (RETENTION_DAYS + 1) * 86400000;
    assert.deepEqual(h.list('db-1').map(c => c.id), ['b']);
    assert.equal(fs.existsSync(path.join(dir, 'db-1', 'a.json')), false);
    h.delete('db-1', 'b');
    assert.deepEqual(h.list('db-1'), []);
    assert.throws(() => h.save(conv('../x', now)));
    assert.throws(() => h.list('../etc'));
    h.save(conv('c', now));
    h.clear('db-1');
    assert.deepEqual(h.list('db-1'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

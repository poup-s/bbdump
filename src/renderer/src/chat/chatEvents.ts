/** A database chat and how the AI tool's events fill it (pure: tested without a window) */
export type ChatProviderId = 'claude' | 'codex' | 'opencode' | 'ollama' | 'lmstudio';

/** masked: columns anonymized in this result ("Anonymize for AI") */
export interface ToolBlock { type: 'tool'; id: string; name: string; input?: unknown; status: 'running' | 'done' | 'error'; output?: string; masked?: string[] }
export interface TextBlock { type: 'text'; text: string }
/** `anonymized`: the samples as the AI gets them once anonymized (computed by the MCP server) */
export interface DisclosedColumn { name: string; origin: string; source?: string; samples: string[]; anonymized?: string[] }
/** bbdump asks before a result of unknown origin reaches the AI; answered in the chat */
export interface DiscloseBlock {
  type: 'disclose';
  id: string;
  rows: number;
  sql?: string;
  columns: DisclosedColumn[];
  status: 'pending' | 'sent' | 'masked' | 'blocked' | 'timeout';
  askedAt: number;
}
export type AssistantBlock = TextBlock | ToolBlock | DiscloseBlock;

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; blocks: AssistantBlock[]; error?: string; done: boolean };

export interface DatabaseChat {
  chatId: string;
  databaseId: string;
  provider: ChatProviderId;
  sessionId?: string;
  messages: ChatMessage[];
  busy: boolean;
  /** The next text starts a new block (a new assistant message began) */
  newBlock: boolean;
  /** When the conversation started (kept in the history) */
  createdAt?: string;
}

export type ChatEvent =
  | { chatId: string; type: 'session'; sessionId: string }
  | { chatId: string; type: 'step' }
  | { chatId: string; type: 'text'; text: string; append: boolean }
  | { chatId: string; type: 'tool'; id: string; name: string; input?: unknown; status: ToolBlock['status']; output?: string; masked?: string[] }
  | { chatId: string; type: 'error'; message: string }
  | { chatId: string; type: 'disclose'; requestId: string; rows: number; sql?: string; columns: DisclosedColumn[] }
  | { chatId: string; type: 'disclose-timeout'; requestId: string }
  | { chatId: string; type: 'done' };

/** Applies one event of the AI tool to the answer being written */
export function applyChatEvent(chat: DatabaseChat, event: ChatEvent): void {
  if (event.type === 'session') {
    chat.sessionId = event.sessionId;
    return;
  }
  const last = chat.messages[chat.messages.length - 1];
  const answer = last?.role === 'assistant' ? last : null;
  if (!answer) return;
  switch (event.type) {
    case 'step':
      chat.newBlock = true;
      break;
    case 'text': {
      const previous = answer.blocks[answer.blocks.length - 1];
      if (event.append && !chat.newBlock && previous?.type === 'text') previous.text += event.text;
      else answer.blocks.push({ type: 'text', text: event.text });
      chat.newBlock = false;
      break;
    }
    case 'tool': {
      const existing = answer.blocks.find((b): b is ToolBlock => b.type === 'tool' && b.id === event.id);
      if (existing) {
        existing.status = event.status;
        if (event.output !== undefined) existing.output = event.output;
        if (event.input !== undefined) existing.input = event.input;
        if (event.masked?.length) existing.masked = event.masked;
      } else {
        answer.blocks.push({ type: 'tool', id: event.id, name: event.name, input: event.input, status: event.status, output: event.output, ...(event.masked?.length ? { masked: event.masked } : {}) });
      }
      chat.newBlock = true;
      break;
    }
    case 'error':
      answer.error = event.message;
      break;
    case 'disclose':
      answer.blocks.push({ type: 'disclose', id: event.requestId, rows: event.rows, sql: event.sql, columns: event.columns, status: 'pending', askedAt: Date.now() });
      chat.newBlock = true;
      break;
    case 'disclose-timeout': {
      const asked = answer.blocks.find((b): b is DiscloseBlock => b.type === 'disclose' && b.id === event.requestId);
      if (asked?.status === 'pending') asked.status = 'timeout';
      break;
    }
    case 'done':
      answer.done = true;
      chat.busy = false;
      for (const block of answer.blocks) {
        if (block.type === 'tool' && block.status === 'running') block.status = 'done';
        // The turn ended (stopped): a question left open has no answer any more
        if (block.type === 'disclose' && block.status === 'pending') block.status = 'timeout';
      }
      break;
  }
}

/**
 * Database chats, one per database, kept while bbdump runs. Messages go to the main
 * process ('ai-chat-send'), which runs the AI tool; its events ('ai-chat-event') fill the
 * assistant's answer. The conversation itself lives in the tool (its session id), so a
 * follow-up question keeps the context.
 */
import { reactive } from 'vue';
import { ipcRenderer } from '../electron';
import { chatSystemPrompt } from './openuiLibrary';
import { applyChatEvent, type ChatEvent, type ChatProviderId, type DatabaseChat } from './chatEvents';
import { chatSettings } from './chatSettings';

const chats = reactive(new Map<string, DatabaseChat>());
let listening = false;

/** A conversation as kept in the history (plain data: the reactive one cannot cross IPC) */
export interface SavedConversation {
  id: string;
  databaseId: string;
  provider: ChatProviderId;
  model?: string;
  sessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  messages: DatabaseChat['messages'];
}

/** After each answer: the conversation goes to the history, unless the history is off */
function persist(chat: DatabaseChat): void {
  if (!chatSettings.history || !chat.messages.length) return;
  const first = chat.messages.find(m => m.role === 'user');
  const conversation = {
    id: chat.chatId,
    databaseId: chat.databaseId,
    provider: chat.provider,
    model: chatSettings.models[chat.provider] || undefined,
    sessionId: chat.sessionId,
    title: first && first.role === 'user' ? first.text.slice(0, 120) : '',
    createdAt: chat.createdAt ?? new Date().toISOString(),
    messages: JSON.parse(JSON.stringify(chat.messages)),
  };
  void ipcRenderer.invoke('ai-chat-history-save', conversation).catch(() => { /* the chat goes on without it */ });
}

function listen(): void {
  if (listening) return;
  listening = true;
  ipcRenderer.on('ai-chat-event', (_event: unknown, payload: ChatEvent) => {
    for (const chat of chats.values()) {
      if (chat.chatId !== payload?.chatId) continue;
      applyChatEvent(chat, payload);
      if (payload.type === 'done') persist(chat);
    }
  });
}

const fresh = (databaseId: string, provider: ChatProviderId): DatabaseChat =>
  ({ chatId: crypto.randomUUID(), databaseId, provider, messages: [], busy: false, newBlock: false, createdAt: new Date().toISOString() });

export function useDatabaseChat() {
  listen();

  const chatFor = (databaseId: string, provider: ChatProviderId): DatabaseChat => {
    if (!chats.has(databaseId)) chats.set(databaseId, fresh(databaseId, provider));
    return chats.get(databaseId)!;
  };

  /** A new conversation (another tool, or a fresh start): the tool's session is dropped */
  const reset = (databaseId: string, provider: ChatProviderId): DatabaseChat => {
    const previous = chats.get(databaseId);
    if (previous?.busy) void ipcRenderer.invoke('ai-chat-stop', previous.chatId);
    chats.set(databaseId, fresh(databaseId, provider));
    return chats.get(databaseId)!;
  };

  /** Sends a question; returns an error code when the tool did not start ('not_installed'…) */
  const send = async (chat: DatabaseChat, text: string, databaseLabel: string): Promise<string | null> => {
    const message = text.trim();
    if (!message || chat.busy) return null;
    chat.messages.push({ role: 'user', text: message });
    chat.messages.push({ role: 'assistant', blocks: [], done: false });
    chat.busy = true;
    chat.newBlock = true;
    const fail = (message: string) => {
      applyChatEvent(chat, { chatId: chat.chatId, type: 'error', message });
      applyChatEvent(chat, { chatId: chat.chatId, type: 'done' });
    };
    try {
      const result = await ipcRenderer.invoke('ai-chat-send', {
        chatId: chat.chatId,
        databaseId: chat.databaseId,
        provider: chat.provider,
        message,
        systemPrompt: chatSystemPrompt(databaseLabel),
        sessionId: chat.sessionId,
        // The model chosen for this tool in the chat settings ('' = the tool's default)
        model: chatSettings.models[chat.provider] || undefined,
      });
      if (result?.success) return null;
      fail(result?.error || 'The AI tool did not start');
      return result?.code ?? 'error';
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return 'error';
    }
  };

  /** A conversation from the history, shown again and ready to continue (same id, same session) */
  const open = (saved: SavedConversation): DatabaseChat => {
    const previous = chats.get(saved.databaseId);
    if (previous?.busy) void ipcRenderer.invoke('ai-chat-stop', previous.chatId);
    const messages = saved.messages.map(m => {
      if (m.role !== 'assistant') return m;
      // A question left open when it was kept has no answer any more
      const blocks = m.blocks.map(b => (b.type === 'disclose' && b.status === 'pending' ? { ...b, status: 'timeout' as const } : b));
      return { ...m, blocks, done: true };
    });
    chats.set(saved.databaseId, {
      chatId: saved.id, databaseId: saved.databaseId, provider: saved.provider, sessionId: saved.sessionId,
      messages, busy: false, newBlock: false, createdAt: saved.createdAt,
    });
    return chats.get(saved.databaseId)!;
  };

  const stop = (chat: DatabaseChat) => {
    if (chat.busy) void ipcRenderer.invoke('ai-chat-stop', chat.chatId);
  };

  return { chatFor, reset, send, stop, open };
}

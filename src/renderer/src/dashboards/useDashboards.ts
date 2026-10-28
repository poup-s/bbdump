/**
 * Dashboards in the window: the list, the dashboards opened (kept while bbdump runs, so the
 * AI can finish while the user looks elsewhere) and their AI conversation. A request goes
 * to the database chat's runner ('ai-chat-send') with the dashboard's instructions; when the
 * answer ends, its patch is merged into the program, checked, and the dashboard saved.
 */
import { reactive } from 'vue';
import { createParser } from '@openuidev/lang-core';
import { ipcRenderer } from '../electron';
import { store } from '../store';
import { engineOf } from '../../../shared/engines/features';
import { applyChatEvent, type ChatEvent, type ChatProviderId, type DatabaseChat } from '../chat/chatEvents';
import { chatSettings } from '../chat/chatSettings';
import { dashboardLibrary, dashboardSystemPrompt } from './dashboardLibrary';
import { applyPatch, dashboardRequest, patchesFromAnswer, withVersion } from './dashboardProgram';

export interface DashboardVersion { program: string; at: string }
export interface BlockLayout { span?: number; hidden?: boolean; height?: number }
export interface DashboardTheme { accent: string; density: 'comfortable' | 'compact' }
export interface DashboardFilters {
  period?: { preset: string; from?: string; to?: string };
  values?: Record<string, string | null>;
  labels?: Record<string, string>;
}
/** What a dashboard file brings (program and settings) */
export type DashboardTemplate = Pick<Dashboard, 'title' | 'program' | 'refreshSeconds' | 'layout' | 'theme' | 'filters'>;

export interface Dashboard {
  id: string;
  databaseId: string;
  title: string;
  program: string;
  refreshSeconds: number;
  createdAt: string;
  updatedAt: string;
  versions: DashboardVersion[];
  chat?: { provider: ChatProviderId; model?: string; sessionId?: string; messages: DatabaseChat['messages'] };
  layout?: Record<string, BlockLayout>;
  theme?: DashboardTheme;
  filters?: DashboardFilters;
  pinned?: boolean;
  cacheResults?: boolean;
}

export interface DashboardSummary {
  id: string;
  databaseId: string;
  title: string;
  refreshSeconds: number;
  createdAt: string;
  updatedAt: string;
  empty: boolean;
  pinned: boolean;
}

export interface DashboardSession {
  dashboard: Dashboard;
  chat: DatabaseChat;
  /** The database's name, given to the AI */
  databaseLabel: string;
  /** The last AI turn changed the program: the view checks its queries (and has them fixed once) */
  justChanged: number;
  /** Fixes already asked for after the last change made by the user */
  repairs: number;
}

export const REFRESH_CHOICES = [0, 60, 300, 900, 3600];

const sessions = reactive(new Map<string, DashboardSession>());
/** Deleted dashboards: a save still on its way (the end of an AI turn) must not bring them back */
const removed = new Set<string>();
let listening = false;

/** A program bbdump can show: it parses and its root is a Dashboard */
export function isUsableProgram(program: string): boolean {
  try {
    const result = createParser(dashboardLibrary.toJSONSchema(), dashboardLibrary.root).parse(program);
    return result.root?.typeName === 'Dashboard';
  } catch {
    return false;
  }
}

/** Plain data for IPC (the reactive objects cannot cross) */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function persist(session: DashboardSession): Promise<boolean> {
  const { dashboard, chat } = session;
  if (removed.has(dashboard.id)) return false;
  dashboard.chat = { provider: chat.provider, model: chatSettings.models[chat.provider] || undefined, sessionId: chat.sessionId, messages: chat.messages };
  try {
    const result = await ipcRenderer.invoke('dashboards-save', plain(dashboard));
    if (result?.success && typeof result.updatedAt === 'string') dashboard.updatedAt = result.updatedAt;
    return !!result?.success;
  } catch {
    return false;
  }
}

/** The answer ended: its patch, if any, goes into the program */
function finishTurn(session: DashboardSession): void {
  const answer = session.chat.messages[session.chat.messages.length - 1];
  if (answer?.role === 'assistant') {
    // Every block of the answer, in order: a block that corrects the previous one applies on top of it
    const patches = patchesFromAnswer(answer.blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text));
    if (patches.length) {
      let next = '';
      try {
        next = patches.reduce((program, patch) => applyPatch(program, patch), session.dashboard.program);
      } catch {
        next = '';
      }
      if (next && isUsableProgram(next)) {
        const now = new Date().toISOString();
        session.dashboard.versions = withVersion(session.dashboard.versions, session.dashboard.program, now);
        session.dashboard.program = next;
        answer.dashboard = 'updated';
        session.justChanged = Date.now();
      } else {
        answer.dashboard = 'invalid';
      }
    }
  }
  void persist(session);
}

function listen(): void {
  if (listening) return;
  listening = true;
  ipcRenderer.on('ai-chat-event', (_event: unknown, payload: ChatEvent) => {
    for (const session of sessions.values()) {
      if (session.chat.chatId !== payload?.chatId) continue;
      applyChatEvent(session.chat, payload);
      if (payload.type === 'done') finishTurn(session);
    }
  });
}

const freshChat = (dashboard: Dashboard): DatabaseChat => {
  const saved = dashboard.chat;
  const messages = (saved?.messages ?? []).map(m => {
    if (m.role !== 'assistant') return m;
    // A question left open when it was kept has no answer any more
    const blocks = m.blocks.map(b => (b.type === 'disclose' && b.status === 'pending' ? { ...b, status: 'timeout' as const } : b));
    return { ...m, blocks, done: true };
  });
  return {
    // The dashboard's id: one conversation per dashboard, continued across restarts
    chatId: dashboard.id,
    databaseId: dashboard.databaseId,
    provider: saved?.provider ?? chatSettings.provider,
    sessionId: saved?.sessionId,
    messages,
    busy: false,
    newBlock: false,
    createdAt: dashboard.createdAt,
  };
};

export function useDashboards() {
  listen();

  const list = async (): Promise<DashboardSummary[]> => {
    try {
      return (await ipcRenderer.invoke('dashboards-list')) ?? [];
    } catch {
      return [];
    }
  };

  /** The dashboard opened (already open: the same session, its AI turn included) */
  const open = async (databaseId: string, id: string, databaseLabel: string): Promise<DashboardSession | null> => {
    const existing = sessions.get(id);
    if (existing) {
      existing.databaseLabel = databaseLabel;
      return existing;
    }
    const dashboard: Dashboard | null = await ipcRenderer.invoke('dashboards-get', databaseId, id);
    if (!dashboard) return null;
    dashboard.versions ??= [];
    sessions.set(id, { dashboard, chat: freshChat(dashboard), databaseLabel, justChanged: 0, repairs: 0 });
    return sessions.get(id)!;
  };

  /** A new dashboard (empty, or from a template: a file, another database's dashboard), saved at once */
  const create = async (databaseId: string, title: string, databaseLabel: string, template?: Partial<DashboardTemplate>): Promise<DashboardSession | null> => {
    const now = new Date().toISOString();
    const dashboard: Dashboard = {
      id: crypto.randomUUID(), databaseId, title, program: template?.program ?? '', refreshSeconds: template?.refreshSeconds ?? 0, createdAt: now, updatedAt: now, versions: [],
      ...(template?.layout ? { layout: plain(template.layout) } : {}),
      ...(template?.theme ? { theme: plain(template.theme) } : {}),
      ...(template?.filters ? { filters: plain(template.filters) } : {}),
    };
    const session: DashboardSession = { dashboard, chat: freshChat(dashboard), databaseLabel, justChanged: 0, repairs: 0 };
    sessions.set(dashboard.id, session);
    if (await persist(session)) return sessions.get(dashboard.id)!;
    sessions.delete(dashboard.id);
    return null;
  };

  /** Asks the AI to create or change the dashboard (or one block); returns an error code when the tool did not start */
  const ask = async (session: DashboardSession, request: string, focus?: string | null, repair = false): Promise<string | null> => {
    const text = request.trim();
    const chat = session.chat;
    if (!text || chat.busy) return null;
    // Another tool than the one this conversation began with: a new conversation for it
    if (chat.provider !== chatSettings.provider) {
      chat.provider = chatSettings.provider;
      chat.sessionId = undefined;
    }
    if (!repair) session.repairs = 0;
    chat.messages.push({ role: 'user', text });
    chat.messages.push({ role: 'assistant', blocks: [], done: false });
    chat.busy = true;
    chat.newBlock = true;
    const fail = (message: string) => {
      applyChatEvent(chat, { chatId: chat.chatId, type: 'error', message });
      applyChatEvent(chat, { chatId: chat.chatId, type: 'done' });
      void persist(session);
    };
    try {
      const result = await ipcRenderer.invoke('ai-chat-send', {
        chatId: chat.chatId,
        databaseId: session.dashboard.databaseId,
        provider: chat.provider,
        message: dashboardRequest(session.dashboard.program, text, focus),
        systemPrompt: dashboardSystemPrompt(session.databaseLabel, engineOf(store.databases.find(d => d.id === session.dashboard.databaseId))),
        sessionId: chat.sessionId,
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

  const stop = (session: DashboardSession) => {
    if (session.chat.busy) void ipcRenderer.invoke('ai-chat-stop', session.chat.chatId);
  };

  /** Back to the program before the AI's last change */
  const undo = async (session: DashboardSession): Promise<boolean> => {
    const previous = session.dashboard.versions[session.dashboard.versions.length - 1];
    if (!previous || session.chat.busy) return false;
    session.dashboard.versions = session.dashboard.versions.slice(0, -1);
    session.dashboard.program = previous.program;
    return persist(session);
  };

  type Settings = Pick<Dashboard, 'title' | 'refreshSeconds' | 'layout' | 'theme' | 'filters' | 'pinned' | 'cacheResults'>;
  const update = async (session: DashboardSession, changes: Partial<Settings>): Promise<boolean> => {
    Object.assign(session.dashboard, changes);
    return persist(session);
  };

  /** The filters chosen: saved on their own, without changing the dashboard's date */
  const saveFilters = async (session: DashboardSession, filters: DashboardFilters): Promise<boolean> => {
    session.dashboard.filters = filters;
    if (removed.has(session.dashboard.id)) return false;
    try {
      return !!(await ipcRenderer.invoke('dashboards-save-filters', session.dashboard.databaseId, session.dashboard.id, plain(filters)));
    } catch {
      return false;
    }
  };

  /** A change made by hand (move, type, SQL…): the previous program can be brought back */
  const setProgram = async (session: DashboardSession, program: string, layout?: Record<string, BlockLayout>): Promise<boolean> => {
    if (program === session.dashboard.program && !layout) return true;
    if (program !== session.dashboard.program) {
      session.dashboard.versions = withVersion(session.dashboard.versions, session.dashboard.program, new Date().toISOString());
      session.dashboard.program = program;
    }
    if (layout) session.dashboard.layout = layout;
    return persist(session);
  };

  /** The same dashboard on another database (same schema: a copy, prod and its local copy…) */
  const copyTo = (session: DashboardSession, databaseId: string, databaseLabel: string) => {
    const d = session.dashboard;
    return create(databaseId, d.title, databaseLabel, { program: d.program, refreshSeconds: d.refreshSeconds, layout: d.layout, theme: d.theme, filters: d.filters });
  };

  /** A fresh conversation with the AI (the dashboard stays as it is) */
  const resetChat = async (session: DashboardSession): Promise<void> => {
    stop(session);
    session.chat.messages = [];
    session.chat.sessionId = undefined;
    await persist(session);
  };

  const remove = async (databaseId: string, id: string): Promise<boolean> => {
    const session = sessions.get(id);
    if (session) stop(session);
    sessions.delete(id);
    removed.add(id);
    try {
      return !!(await ipcRenderer.invoke('dashboards-delete', databaseId, id));
    } catch {
      return false;
    }
  };

  return { list, open, create, ask, stop, undo, update, setProgram, saveFilters, copyTo, resetChat, remove };
}

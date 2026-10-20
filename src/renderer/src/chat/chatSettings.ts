/**
 * The chat's AI tool and the model chosen for each tool, kept in this window's storage (a
 * convenience: without it, the tool's default model is used).
 */
import { reactive } from 'vue';
import type { ChatProviderId } from './chatEvents';

export interface ChatSettings {
  provider: ChatProviderId;
  /** '' = the tool's own default */
  models: Record<ChatProviderId, string>;
  /** Conversations kept in the history (encrypted, 30 days unless pinned) */
  history: boolean;
}

const KEY = 'bbdump.chatSettings';
const OLD_PROVIDER_KEY = 'bbdump.chatProvider';
const PROVIDERS: ChatProviderId[] = ['claude', 'codex', 'opencode', 'ollama', 'lmstudio'];
const isProvider = (value: unknown): value is ChatProviderId => PROVIDERS.includes(value as ChatProviderId);

function load(): ChatSettings {
  const settings: ChatSettings = { provider: 'claude', models: { claude: '', codex: '', opencode: '', ollama: '', lmstudio: '' }, history: true };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<ChatSettings> | null;
    if (saved && isProvider(saved.provider)) settings.provider = saved.provider;
    if (saved && typeof saved.history === 'boolean') settings.history = saved.history;
    for (const id of PROVIDERS) {
      const model = saved?.models?.[id];
      if (typeof model === 'string') settings.models[id] = model;
    }
    // Before the settings dialog, only the tool was remembered
    const old = localStorage.getItem(OLD_PROVIDER_KEY);
    if (!saved && isProvider(old)) settings.provider = old;
  } catch {
    // defaults
  }
  return settings;
}

export const chatSettings = reactive<ChatSettings>(load());

export function saveChatSettings(next: ChatSettings): void {
  chatSettings.provider = next.provider;
  chatSettings.models = { ...next.models };
  chatSettings.history = next.history;
  try {
    localStorage.setItem(KEY, JSON.stringify(chatSettings));
  } catch {
    // only a convenience
  }
}

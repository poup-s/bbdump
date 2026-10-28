<script setup lang="ts">
/**
 * Chat with a database through the user's AI tool (Claude Code, Codex, OpenCode) and
 * bbdump's MCP server, read only. Answers show their data with OpenUI components.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer, shell } from '../../electron';
import { relative } from '../../timeText';
import { useConfirm } from '../../composables/useConfirm';
import type { SavedConversation } from '../../chat/useDatabaseChat';
import { useDatabaseChat } from '../../chat/useDatabaseChat';
import { CHAT_TOOLS, chatSettings } from '../../chat/chatSettings';
import AiChatSettingsModal from './AiChatSettingsModal.vue';
import ChatMessages from './ChatMessages.vue';
import type { ChatProviderId } from '../../chat/chatEvents';
import { btnGhost } from '../ui/classes';
import { engineOf } from '../../../../shared/engines/features';

const { t, currentLanguage } = useI18n();
const { chatFor, reset, send, stop, open } = useDatabaseChat();
const { showConfirm } = useConfirm();

const PROVIDERS = CHAT_TOOLS;

const db = computed(() => store.aiChatDb!);
const dbLabel = computed(() => db.value.displayName || db.value.name);
const installed = ref<Record<ChatProviderId, boolean> | null>(null);
const provider = ref<ChatProviderId>(chatSettings.provider);
const showSettings = ref(false);
const chat = computed(() => chatFor(db.value.id, provider.value));
const draft = ref('');
const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

const anyInstalled = computed(() => !!installed.value && Object.values(installed.value).some(Boolean));
const providerLabel = (id: ChatProviderId) => PROVIDERS.find(p => p.id === id)?.label ?? id;
/** Shown on the AI button: the tool, and its model when one is chosen */
const modelLabel = computed(() => chatSettings.models[chat.value.provider] || t('chat.settings.defaultShort'));

// "Anonymize for AI" on this database: the same rules for every tool, local models included
const masking = ref<{ enabled: boolean; columns: number } | null>(null);
async function loadMasking() {
  try {
    const settings: { enabled?: boolean; columns?: unknown[] } | null = await ipcRenderer.invoke('ai-masking-get', db.value.id);
    masking.value = { enabled: !!settings?.enabled, columns: Array.isArray(settings?.columns) ? settings!.columns.length : 0 };
  } catch {
    masking.value = null;
  }
}
// The anonymization dialog, opened from the badge, closes back onto the chat: read it again
watch(() => store.aiMaskingDb, (open, was) => { if (!open && was) void loadMasking(); });
const maskingOn = computed(() => !!masking.value?.enabled && masking.value.columns > 0);
const editMasking = () => { store.aiMaskingDb = db.value; };

/** Where what the AI reads goes: the model's provider, or nowhere for a local model */
const destination = computed(() => {
  const provider = chat.value.provider;
  if (provider === 'ollama' || provider === 'lmstudio') return { local: true, text: t('chat.dest.local') };
  if (provider === 'claude') return { local: false, text: t('chat.dest.cloud', { who: 'Anthropic' }) };
  if (provider === 'codex') return { local: false, text: t('chat.dest.cloud', { who: 'OpenAI' }) };
  // OpenCode: the model's provider, from "provider/model"
  const prefix = chatSettings.models.opencode.split('/')[0];
  if (prefix === 'lmstudio' || prefix === 'ollama') return { local: true, text: t('chat.dest.local') };
  return { local: false, text: prefix ? t('chat.dest.cloud', { who: prefix }) : t('chat.dest.opencode') };
});

const onKey = (event: KeyboardEvent) => {
  // The settings dialog closes itself first
  if (event.key !== 'Escape' || showSettings.value) return;
  // Escape leaves the history first, then the chat
  if (showHistory.value) showHistory.value = false;
  else close();
};
const close = () => { store.aiChatDb = null; };

// The panel's width: dragged from its left edge, or almost the whole window; remembered
const WIDTH_KEY = 'bbdump.chatWidth';
const MIN_WIDTH = 420;
const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 48);
const readWidth = () => {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : 600;
  } catch {
    return 600;
  }
};
const width = ref(readWidth());
const maximized = ref(false);
const resizing = ref(false);
const sheetWidth = computed(() => (maximized.value ? maxWidth() : Math.min(width.value, maxWidth())));
const saveWidth = () => {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(width.value))); } catch { /* a convenience */ }
};
const startResize = (event: PointerEvent) => {
  event.preventDefault();
  maximized.value = false;
  resizing.value = true;
  const startX = event.clientX;
  const startWidth = sheetWidth.value;
  const move = (e: PointerEvent) => { width.value = Math.min(maxWidth(), Math.max(MIN_WIDTH, startWidth + (startX - e.clientX))); };
  const up = () => {
    resizing.value = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    saveWidth();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
};
/** The resize handle with the keyboard: arrows widen or narrow by 40px */
const resizeByKey = (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  maximized.value = false;
  width.value = Math.min(maxWidth(), Math.max(MIN_WIDTH, sheetWidth.value + (event.key === 'ArrowLeft' ? 40 : -40)));
  saveWidth();
};
const toggleMaximized = () => { maximized.value = !maximized.value; };

// --- History: the conversations kept for this database (30 days, pinned ones for good) ---
type HistoryItem = Omit<SavedConversation, 'messages' | 'sessionId'> & { messageCount: number };
const showHistory = ref(false);
const historyItems = ref<HistoryItem[]>([]);
const historyLoading = ref(false);
async function loadHistory() {
  historyLoading.value = true;
  try {
    historyItems.value = await ipcRenderer.invoke('ai-chat-history-list', db.value.id) ?? [];
  } catch {
    historyItems.value = [];
  } finally {
    historyLoading.value = false;
  }
}
const toggleHistory = async () => {
  showHistory.value = !showHistory.value;
  if (showHistory.value) await loadHistory();
};
const openConversation = async (item: HistoryItem) => {
  if (chat.value.busy) return;
  const saved: SavedConversation | null = await ipcRenderer.invoke('ai-chat-history-get', db.value.id, item.id);
  if (!saved) return loadHistory();
  provider.value = saved.provider;
  open(saved);
  showHistory.value = false;
  scrollDown();
};
const togglePin = async (item: HistoryItem) => {
  const pinned = !item.pinned;
  if (await ipcRenderer.invoke('ai-chat-history-pin', db.value.id, item.id, pinned)) await loadHistory();
};
const deleteConversation = (item: HistoryItem) => {
  showConfirm({
    title: t('chat.history.deleteTitle'),
    message: t('chat.history.deleteMessage', { title: item.title || t('chat.history.untitled') }),
    confirmText: t('chat.history.delete'),
    type: 'danger',
    onConfirm: async () => {
      await ipcRenderer.invoke('ai-chat-history-delete', db.value.id, item.id);
      if (chat.value.chatId === item.id) reset(db.value.id, provider.value);
      await loadHistory();
    },
  });
};
const clearHistory = () => {
  showConfirm({
    title: t('chat.history.clearTitle'),
    message: t('chat.history.clearMessage'),
    confirmText: t('chat.history.clear'),
    type: 'danger',
    onConfirm: async () => {
      await ipcRenderer.invoke('ai-chat-history-clear', db.value.id);
      await loadHistory();
    },
  });
};
const ago = (iso: string) => relative(Date.parse(iso), Date.now(), currentLanguage.value, t);

onMounted(async () => {
  try {
    const list: Array<{ id: ChatProviderId; installed: boolean }> = await ipcRenderer.invoke('ai-chat-providers');
    installed.value = Object.fromEntries(list.map(p => [p.id, p.installed])) as Record<ChatProviderId, boolean>;
  } catch {
    installed.value = { claude: false, codex: false, opencode: false, ollama: false, lmstudio: false };
  }
  // The chat already open on this database keeps its tool; else the remembered one, if installed
  const existing = chatFor(db.value.id, provider.value);
  if (existing.messages.length) provider.value = existing.provider;
  else if (installed.value && !installed.value[provider.value]) {
    provider.value = PROVIDERS.find(p => installed.value![p.id])?.id ?? provider.value;
    existing.provider = provider.value;
  }
  window.addEventListener('keydown', onKey);
  void loadMasking();
  input.value?.focus();
  scrollDown();
});
onUnmounted(() => window.removeEventListener('keydown', onKey));

/** Settings saved: another tool starts a new conversation (each keeps its own); a model applies to the next message */
const onSettingsSaved = (providerChanged: boolean) => {
  showSettings.value = false;
  if (!providerChanged && chatSettings.provider === chat.value.provider) return;
  provider.value = chatSettings.provider;
  reset(db.value.id, chatSettings.provider);
};
const newChat = () => {
  reset(db.value.id, provider.value);
  showHistory.value = false;
};

const submit = async (text = draft.value) => {
  // A question asked from the history goes to the open conversation, shown again
  showHistory.value = false;
  if (!text.trim() || chat.value.busy) return;
  draft.value = '';
  await send(chat.value, text, dbLabel.value, engineOf(db.value));
};
/** The message box grows with its text, up to a few lines */
const autoGrow = () => {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
};
watch(draft, () => nextTick(autoGrow));

const onEnter = (event: KeyboardEvent) => {
  if (event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void submit();
};

const suggestions = computed(() => (engineOf(db.value) === 'mongodb'
  ? [t('chat.suggest.overview'), t('chat.suggestMongo.biggest'), t('chat.suggestMongo.trend')]
  : [t('chat.suggest.overview'), t('chat.suggest.biggest'), t('chat.suggest.trend')]));

function scrollDown() {
  void nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
watch(() => JSON.stringify(chat.value.messages).length, scrollDown);

</script>

<template>
  <!-- no-drag: the window's title bar lies under the panel and would swallow its clicks -->
  <div class="chat-panel fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" :aria-label="t('chat.title', { name: dbLabel })">
    <div class="chat-backdrop absolute inset-0 bg-black/25 dark:bg-black/50" @click="close" />
    <section
      class="chat-sheet relative max-w-full h-full flex flex-col bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-zinc-800 shadow-2xl"
      :class="resizing ? 'select-none' : 'chat-sheet-animated'"
      :style="{ width: `${sheetWidth}px` }"
    >
      <!-- Resize: drag the left edge (or arrows when focused) -->
      <div
        class="chat-resize group absolute left-0 top-0 bottom-0 -ml-1 w-2 z-10 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
        :aria-label="t('chat.resize')"
        :title="t('chat.resize')"
        @pointerdown="startResize"
        @keydown="resizeByKey"
        @dblclick="toggleMaximized"
      >
        <span class="absolute left-1 top-1/2 -translate-y-1/2 w-1 h-10 rounded-full bg-gray-300 dark:bg-zinc-600 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" :class="resizing ? 'opacity-100 bg-emerald-500' : ''" />
      </div>
      <!-- Header -->
      <header class="shrink-0 px-6 pt-5 pb-3.5 border-b border-gray-100 dark:border-zinc-800">
        <div class="flex items-center gap-3">
          <span class="chat-head-icon w-9 h-9 shrink-0 rounded-xl flex items-center justify-center bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
              <path stroke-linecap="round" stroke-width="2.6" d="M8.25 12h.01M12 12h.01M15.75 12h.01" />
            </svg>
          </span>
          <div class="flex-1 min-w-0">
            <div class="text-[14px] font-semibold text-gray-900 dark:text-zinc-100 truncate">{{ db.masked ? '••••••••' : dbLabel }}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <!-- AI settings: the tool and its model -->
            <button
              v-if="anyInstalled"
              type="button"
              class="chat-ai-button group h-8 pl-2 pr-2.5 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-zinc-700 text-[12px] text-gray-700 dark:text-zinc-200 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20 transition-colors disabled:opacity-50"
              :title="t('chat.settings.title')"
              :aria-label="t('chat.settings.title')"
              :disabled="chat.busy"
              @click="showSettings = true"
            >
              <svg class="chat-sparkle w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
              </svg>
              <span class="font-medium">{{ providerLabel(chat.provider) }}</span>
              <span class="max-w-[9rem] truncate text-gray-400 dark:text-zinc-500">· {{ modelLabel }}</span>
            </button>
            <button
              type="button"
              class="chat-history-button w-8 h-8 rounded-lg flex items-center justify-center hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              :class="showHistory ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200'"
              :title="t('chat.history.title')"
              :aria-label="t('chat.history.title')"
              :aria-pressed="showHistory"
              :disabled="chat.busy"
              @click="toggleHistory"
            >
              <svg class="chat-history-icon w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>
            <button
              type="button"
              class="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
              :title="maximized ? t('chat.restore') : t('chat.maximize')"
              :aria-label="maximized ? t('chat.restore') : t('chat.maximize')"
              @click="toggleMaximized"
            >
              <svg v-if="!maximized" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" /></svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" /></svg>
            </button>
            <button
              v-if="chat.messages.length"
              type="button"
              class="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              :title="t('chat.newChat')"
              :aria-label="t('chat.newChat')"
              :disabled="chat.busy"
              @click="newChat"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
            <button type="button" class="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800" :aria-label="t('common.close')" @click="close">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <!-- What the AI may do, what it sees, and where it goes -->
        <div class="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300" :title="t('chat.readOnlyHint')">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            {{ t('chat.readOnly') }}
          </span>
          <button
            v-if="masking"
            type="button"
            class="chat-mask-badge inline-flex items-center gap-1 h-5 px-1.5 rounded-md transition-colors"
            :class="maskingOn
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20'"
            :title="t('chat.masking.edit')"
            @click="editMasking"
          >
            <svg class="chat-mask-icon w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
            {{ maskingOn ? t('chat.masking.on', { count: masking.columns }) : t('chat.masking.off') }}
          </button>
          <span class="inline-flex items-center gap-1 h-5 px-1.5 rounded-md bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300" :title="destination.local ? t('chat.dest.localHint') : t('chat.dest.cloudHint')">
            <svg v-if="destination.local" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            {{ destination.text }}
          </span>
        </div>
      </header>

      <!-- Messages -->
      <div ref="scroller" class="flex-1 overflow-y-auto">
        <!-- No AI tool on this computer -->
        <!-- History of this database: open, pin (kept for good), delete -->
        <div v-if="showHistory" class="px-6 py-5">
          <!-- The way back, plainly -->
          <button
            type="button"
            class="chat-back group -ml-2 mb-3 inline-flex items-center gap-1.5 h-8 px-2 rounded-lg text-[12px] font-medium text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800"
            @click="showHistory = false"
          >
            <svg class="chat-back-arrow w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 12H5m6-6l-6 6 6 6" /></svg>
            {{ t('chat.history.back') }}
          </button>
          <div class="flex items-baseline gap-2">
            <h3 class="flex-1 text-[14px] font-semibold text-gray-900 dark:text-zinc-100">{{ t('chat.history.title') }}</h3>
            <button v-if="historyItems.length" type="button" class="text-[11px] text-gray-400 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400" @click="clearHistory">{{ t('chat.history.clear') }}</button>
          </div>
          <p class="mt-1 text-[11px] text-gray-500 dark:text-zinc-400">{{ chatSettings.history ? t('chat.history.retention') : t('chat.history.off') }}</p>

          <div v-if="historyLoading && !historyItems.length" class="mt-6 flex justify-center" role="status">
            <span class="w-5 h-5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
          </div>
          <p v-else-if="!historyItems.length" class="mt-8 text-center text-[12px] text-gray-400 dark:text-zinc-500">{{ t('chat.history.empty') }}</p>
          <ul v-else class="mt-4 space-y-1.5">
            <li
              v-for="(item, i) in historyItems"
              :key="item.id"
              class="chat-rise group flex items-center gap-2 rounded-xl border px-3.5 py-2.5 transition-colors cursor-pointer"
              :class="item.id === chat.chatId ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/15' : 'border-gray-200 dark:border-zinc-800 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-gray-50/60 dark:hover:bg-zinc-800/40'"
              :style="{ animationDelay: `${Math.min(i, 8) * 35}ms` }"
              role="button"
              tabindex="0"
              @click="openConversation(item)"
              @keydown.enter.prevent="openConversation(item)"
            >
              <div class="flex-1 min-w-0">
                <div class="text-[13px] text-gray-900 dark:text-zinc-100 truncate">{{ item.title || t('chat.history.untitled') }}</div>
                <div class="mt-0.5 text-[11px] text-gray-400 dark:text-zinc-500 truncate">
                  {{ ago(item.updatedAt) }} · {{ providerLabel(item.provider) }}<template v-if="item.model"> · {{ item.model }}</template> · {{ t('chat.history.questions', { count: Math.ceil(item.messageCount / 2) }) }}
                  <template v-if="item.id === chat.chatId"> · <span class="text-emerald-600 dark:text-emerald-400">{{ t('chat.history.current') }}</span></template>
                </div>
              </div>
              <button
                type="button"
                class="chat-pin w-7 h-7 shrink-0 rounded-lg flex items-center justify-center transition-colors"
                :class="item.pinned ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-gray-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800'"
                :title="item.pinned ? t('chat.history.unpin') : t('chat.history.pin')"
                :aria-label="item.pinned ? t('chat.history.unpin') : t('chat.history.pin')"
                :aria-pressed="!!item.pinned"
                @click.stop="togglePin(item)"
              >
                <svg class="w-3.5 h-3.5" :fill="item.pinned ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4 1-3z" /></svg>
              </button>
              <button
                type="button"
                class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-gray-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                :title="t('chat.history.delete')"
                :aria-label="t('chat.history.delete')"
                @click.stop="deleteConversation(item)"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </li>
          </ul>
        </div>

        <div v-else-if="installed && !anyInstalled" class="h-full flex flex-col items-center justify-center px-10 text-center">
          <div class="text-[14px] font-medium text-gray-900 dark:text-zinc-100">{{ t('chat.noToolTitle') }}</div>
          <p class="mt-2 max-w-sm text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('chat.noToolDesc') }}</p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <button v-for="p in PROVIDERS" :key="p.id" type="button" :class="btnGhost" class="!h-8 !text-[12px] border border-gray-200 dark:border-zinc-700" @click="shell.openExternal(p.url)">{{ p.label }} ↗</button>
          </div>
        </div>

        <!-- Empty chat: what to ask -->
        <div v-else-if="!chat.messages.length" class="min-h-full flex flex-col justify-center px-8 py-10">
          <!-- A database that breathes, a question bubble that floats: the chat's welcome -->
          <div class="chat-hero relative w-16 h-16 mb-5 rounded-2xl flex items-center justify-center bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 chat-rise">
            <svg class="chat-hero-db w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                  <ellipse class="chat-tier chat-tier-1" cx="12" cy="5.5" rx="7" ry="2.5" />
                  <path class="chat-tier chat-tier-2" d="M5 5.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6" />
                  <path class="chat-tier chat-tier-3" d="M5 11.5v6c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-6" />
                </svg>
            <span class="chat-bubble absolute -top-2 -right-2 w-7 h-6 rounded-lg rounded-bl-sm flex items-center justify-center gap-0.5 bg-white dark:bg-zinc-900 border border-emerald-500/30 shadow-sm">
              <span class="chat-dot" /><span class="chat-dot" /><span class="chat-dot" />
            </span>
          </div>
          <div class="chat-rise text-[18px] font-semibold text-gray-900 dark:text-zinc-100" style="animation-delay: 60ms">{{ t('chat.emptyTitle') }}</div>
          <p class="chat-rise mt-2 text-[13px] leading-relaxed text-gray-500 dark:text-zinc-400" style="animation-delay: 110ms">{{ t('chat.intro', { tool: providerLabel(chat.provider) }) }}</p>
          <div class="mt-6 space-y-2.5">
            <button
              v-for="(s, i) in suggestions"
              :key="s"
              type="button"
              :style="{ animationDelay: `${180 + i * 70}ms` }"
              class="chat-rise chat-suggestion group w-full flex items-center gap-3 text-left rounded-xl border border-gray-200 dark:border-zinc-800 px-4 py-3 text-[13px] text-gray-700 dark:text-zinc-300 hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 transition-colors disabled:opacity-50"
              :disabled="!installed?.[chat.provider]"
              @click="submit(s)"
            >
              <span class="flex-1">{{ s }}</span>
              <svg class="chat-arrow w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600 group-hover:text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
            </button>
          </div>
        </div>

        <ChatMessages v-else :chat="chat" :provider-label="providerLabel(chat.provider)" class="px-6 py-6" />
      </div>

      <!-- Composer -->
      <footer class="shrink-0 px-6 pt-3 pb-5">
        <div class="flex items-end gap-2 rounded-2xl border border-gray-200 dark:border-zinc-700 bg-gray-50/60 dark:bg-zinc-800/40 focus-within:border-emerald-500 focus-within:bg-white dark:focus-within:bg-zinc-900 transition-colors pl-4 pr-2 py-2">
          <textarea
            ref="input"
            v-model="draft"
            rows="1"
            class="flex-1 self-center resize-none bg-transparent outline-none py-1.5 text-[13px] leading-relaxed text-gray-900 dark:text-zinc-100 placeholder:text-gray-400 dark:placeholder:text-zinc-500"
            :placeholder="t('chat.placeholder')"
            :disabled="!installed?.[chat.provider]"
            :aria-label="t('chat.placeholder')"
            @keydown.enter="onEnter"
          />
          <button
            v-if="chat.busy"
            type="button"
            class="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
            :title="t('chat.stop')"
            :aria-label="t('chat.stop')"
            @click="stop(chat)"
          >
            <span class="w-3 h-3 rounded-sm bg-current" />
          </button>
          <button
            v-else
            type="button"
            class="chat-send group shrink-0 w-9 h-9 rounded-xl flex items-center justify-center bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:bg-emerald-600 dark:hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-zinc-900 dark:disabled:hover:bg-zinc-100 transition-colors"
            :title="t('chat.send')"
            :aria-label="t('chat.send')"
            :disabled="!draft.trim() || !installed?.[chat.provider]"
            @click="submit()"
          >
            <svg class="chat-arrow w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-6-6l6 6-6 6" /></svg>
          </button>
        </div>
        <p class="mt-2 text-center text-[10px] text-gray-400 dark:text-zinc-500">{{ t(engineOf(db) === 'mongodb' ? 'chat.footerMongo' : 'chat.footer', { tool: providerLabel(chat.provider) }) }}</p>
      </footer>
    </section>
    <AiChatSettingsModal v-if="showSettings && installed" :providers="PROVIDERS" :installed="installed" @close="showSettings = false" @saved="onSettingsSaved" />
  </div>
</template>

<style scoped>
.chat-panel,
.chat-panel * {
  -webkit-app-region: no-drag;
}

/* Entrances: everything rises in softly, the user's message comes from the right */
.chat-rise { animation: chat-rise 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.chat-from-right { animation: chat-from-right 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.chat-pop { animation: chat-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes chat-rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes chat-from-right { from { opacity: 0; transform: translateX(14px); } }
@keyframes chat-pop { from { opacity: 0; transform: scale(0.3); } }

/* The database icon: its tiers light up one after the other, as if read */
.chat-tier { transform-box: fill-box; transform-origin: center; }
.chat-reading .chat-tier { animation: chat-read 1.2s ease-in-out infinite; }
.chat-reading .chat-tier-2 { animation-delay: 0.15s; }
.chat-reading .chat-tier-3 { animation-delay: 0.3s; }
@keyframes chat-read {
  0%, 100% { opacity: 0.35; }
  40% { opacity: 1; transform: translateY(-0.6px); }
}
.chat-hero-db { animation: chat-breathe 3.2s ease-in-out infinite; }
@keyframes chat-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.04); }
}
.chat-bubble { animation: chat-float 3.2s ease-in-out infinite 0.4s; }
@keyframes chat-float {
  0%, 100% { transform: translateY(0) rotate(0); }
  50% { transform: translateY(-3px) rotate(-4deg); }
}
.chat-dot { width: 3px; height: 3px; border-radius: 9999px; background: rgb(16 185 129); animation: chat-dot 1.2s ease-in-out infinite; }
.chat-dot:nth-child(2) { animation-delay: 0.15s; }
.chat-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes chat-dot {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-1.5px); }
}

/* The working label shimmers, in the app's green */
.chat-shimmer {
  --chat-ink: rgb(107 114 128);
  background: linear-gradient(90deg, var(--chat-ink) 0%, var(--chat-ink) 40%, rgb(16 185 129) 50%, var(--chat-ink) 60%, var(--chat-ink) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: chat-shimmer 2s linear infinite;
}
:global(.dark) .chat-shimmer { --chat-ink: rgb(161 161 170); }
@keyframes chat-shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }

/* Maximize and restore glide; dragging follows the pointer directly */
.chat-sheet-animated { transition: width 0.28s cubic-bezier(0.2, 0.8, 0.2, 1); }

/* History: the way back nudges left; the clock hands turn back on hover; a pin tilts */
.chat-back-arrow { transition: transform 0.2s ease-out; }
.chat-back:hover .chat-back-arrow { transform: translateX(-2px); }
.chat-history-icon { transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.chat-history-button:hover .chat-history-icon { transform: rotate(-30deg); }
.chat-pin svg { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.chat-pin:hover svg { transform: rotate(-20deg) scale(1.1); }

/* Small nudges on hover */
.chat-mask-icon { transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.chat-mask-badge:hover .chat-mask-icon { transform: scale(1.2) rotate(-8deg); }
.chat-sparkle { transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.chat-ai-button:hover .chat-sparkle { transform: rotate(15deg) scale(1.12); }
.chat-head-icon { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.chat-head-icon:hover { transform: rotate(-8deg) scale(1.06); }
.chat-arrow { transition: transform 0.2s ease-out; }
.group:hover .chat-arrow { transform: translateX(2px); }
.chat-suggestion { transition: border-color 0.2s, background-color 0.2s, transform 0.2s ease-out; }
.chat-suggestion:hover:not(:disabled) { transform: translateX(2px); }

@media (prefers-reduced-motion: reduce) {
  .chat-rise, .chat-from-right, .chat-pop, .chat-reading .chat-tier, .chat-hero-db, .chat-bubble, .chat-dot, .chat-shimmer { animation: none !important; }
  .chat-shimmer { color: inherit; -webkit-text-fill-color: currentColor; background: none; }
}
</style>

<!-- Opening and closing (the Transition in App.vue), and the data appearing in answers.
     Not scoped: OpenUI renders the charts outside this component's scope. -->
<style>
.chat-panel .chat-sql[open] .chat-sql-chevron { transform: rotate(90deg); }
.chat-panel .chat-sql summary::-webkit-details-marker { display: none; }
.chat-enter-active .chat-backdrop, .chat-leave-active .chat-backdrop { transition: opacity 0.22s ease; }
.chat-enter-active .chat-sheet { transition: transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1); }
.chat-leave-active .chat-sheet { transition: transform 0.22s cubic-bezier(0.4, 0, 1, 1); }
.chat-enter-from .chat-backdrop, .chat-leave-to .chat-backdrop { opacity: 0; }
.chat-enter-from .chat-sheet, .chat-leave-to .chat-sheet { transform: translateX(100%); }

.chat-panel .chat-bar { transform-origin: left center; animation: chat-bar-grow 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@keyframes chat-bar-grow { from { transform: scaleX(0); } }
/* Drawn from left to right (a dash animation cannot measure a non-scaling stroke) */
.chat-panel .chat-line { clip-path: inset(0 100% 0 0); animation: chat-line-draw 0.9s ease-out 0.1s forwards; }
@keyframes chat-line-draw { to { clip-path: inset(0 0 0 0); } }
.chat-panel .chat-stat { animation: chat-rise 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.chat-panel .chat-stat:nth-child(2) { animation-delay: 70ms; }
.chat-panel .chat-stat:nth-child(3) { animation-delay: 140ms; }
.chat-panel .chat-stat:nth-child(4) { animation-delay: 210ms; }
@media (prefers-reduced-motion: reduce) {
  .chat-enter-active .chat-sheet, .chat-leave-active .chat-sheet, .chat-enter-active .chat-backdrop, .chat-leave-active .chat-backdrop { transition: none; }
  .chat-panel .chat-bar, .chat-panel .chat-stat { animation: none; }
  .chat-panel .chat-line { animation: none; clip-path: none; }
}
</style>

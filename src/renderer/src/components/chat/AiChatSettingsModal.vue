<script setup lang="ts">
/**
 * The chat's AI settings: which tool answers (among those on this computer) and its model.
 * Models: Claude Code's aliases, OpenCode's configured models (`opencode models`), or any
 * name the tool accepts.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer, shell } from '../../electron';
import { chatSettings, saveChatSettings, type ChatSettings } from '../../chat/chatSettings';
import type { ChatProviderId } from '../../chat/chatEvents';
import AppModal from '../ui/AppModal.vue';
import SwitchRow from '../ui/SwitchRow.vue';
import { useConfirm } from '../../composables/useConfirm';
import { btnGhost, btnPrimary, inputClass, selectClass } from '../ui/classes';

const props = defineProps<{
  providers: Array<{ id: ChatProviderId; label: string; url: string; local?: boolean }>;
  installed: Record<ChatProviderId, boolean>;
}>();
const emit = defineEmits<{ close: []; saved: [providerChanged: boolean] }>();

const { t } = useI18n();
const { showConfirm } = useConfirm();
/** Every database's conversations, pinned ones included */
const clearAllHistory = () => {
  showConfirm({
    title: t('chat.history.clearAllTitle'),
    message: t('chat.history.clearAllMessage'),
    confirmText: t('chat.history.clear'),
    type: 'danger',
    onConfirm: async () => { await ipcRenderer.invoke('ai-chat-history-clear', '*'); },
  });
};
const ICON_AI = 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z';
const CUSTOM = '__custom__';
const MODEL_RE = /^[\w.:@/-]{1,120}$/;

const draft = ref<ChatSettings>({ provider: chatSettings.provider, models: { ...chatSettings.models }, history: chatSettings.history });
const models = ref<Partial<Record<ChatProviderId, string[]>>>({});
const loading = ref(false);
const choice = ref('');
const custom = ref('');

const label = (id: ChatProviderId) => props.providers.find(p => p.id === id)?.label ?? id;
const isLocal = (id: ChatProviderId) => !!props.providers.find(p => p.id === id)?.local;
/** What a tool's card says under its name */
const status = (id: ChatProviderId) => {
  if (!props.installed[id]) return isLocal(id) ? t('chat.settings.notRunning') : t('chat.settings.notInstalled');
  if (draft.value.models[id]) return t('chat.settings.usesModel', { model: draft.value.models[id] });
  return isLocal(id) ? t('chat.settings.running') : t('chat.settings.installed');
};
const known = computed(() => models.value[draft.value.provider] ?? []);
const customInvalid = computed(() => choice.value === CUSTOM && !!custom.value.trim() && !MODEL_RE.test(custom.value.trim()));

/** The list for a tool, read once; the saved model shown as chosen (or as "other") */
async function loadModels(id: ChatProviderId) {
  if (!models.value[id]) {
    loading.value = true;
    try {
      const result: { models?: string[] } = await ipcRenderer.invoke('ai-chat-models', id);
      models.value = { ...models.value, [id]: Array.isArray(result?.models) ? result.models : [] };
    } catch {
      models.value = { ...models.value, [id]: [] };
    } finally {
      loading.value = false;
    }
  }
  const saved = draft.value.models[id];
  if (!saved) { choice.value = ''; custom.value = ''; }
  else if (known.value.includes(saved)) { choice.value = saved; custom.value = ''; }
  else { choice.value = CUSTOM; custom.value = saved; }
}
watch(() => draft.value.provider, id => { void loadModels(id); }, { immediate: true });

const pick = (id: ChatProviderId) => {
  if (props.installed[id]) draft.value.provider = id;
};

const modelHint = computed(() => ({
  claude: t('chat.settings.hintClaude'),
  codex: t('chat.settings.hintCodex'),
  opencode: t('chat.settings.hintOpencode'),
  ollama: t('chat.settings.hintOllama'),
  lmstudio: t('chat.settings.hintLmstudio'),
}[draft.value.provider]));

const save = () => {
  if (customInvalid.value) return;
  const model = choice.value === CUSTOM ? custom.value.trim() : choice.value;
  const next: ChatSettings = { provider: draft.value.provider, models: { ...draft.value.models, [draft.value.provider]: model }, history: draft.value.history };
  const providerChanged = next.provider !== chatSettings.provider;
  saveChatSettings(next);
  emit('saved', providerChanged);
};
</script>

<template>
  <AppModal :title="t('chat.settings.title')" :icon="ICON_AI" layer="top" width="md" :close-label="t('common.close')" @close="emit('close')">
    <div class="space-y-6">
      <!-- Which tool answers -->
      <section>
        <h3 class="mb-2.5 text-[12px] font-medium text-gray-500 dark:text-zinc-400">{{ t('chat.settings.tool') }}</h3>
        <div class="space-y-2" role="radiogroup" :aria-label="t('chat.settings.tool')">
          <div
            v-for="p in providers"
            :key="p.id"
            role="radio"
            :aria-checked="draft.provider === p.id"
            :aria-disabled="!installed[p.id]"
            :tabindex="installed[p.id] ? 0 : -1"
            class="flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors"
            :class="[
              draft.provider === p.id ? 'border-emerald-500/60 bg-emerald-500/[0.06]' : 'border-gray-200 dark:border-zinc-800',
              installed[p.id] ? 'cursor-pointer hover:border-emerald-300 dark:hover:border-emerald-800' : 'opacity-70',
            ]"
            @click="pick(p.id)"
            @keydown.enter.prevent="pick(p.id)"
            @keydown.space.prevent="pick(p.id)"
          >
            <span class="w-4 h-4 shrink-0 rounded-full border flex items-center justify-center" :class="draft.provider === p.id ? 'border-emerald-500' : 'border-gray-300 dark:border-zinc-600'">
              <span v-if="draft.provider === p.id" class="w-2 h-2 rounded-full bg-emerald-500" />
            </span>
            <span class="flex-1 min-w-0">
              <span class="block text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ p.label }}</span>
              <span class="block text-[11px] text-gray-500 dark:text-zinc-400 truncate">
                {{ status(p.id) }}
              </span>
            </span>
            <button v-if="!installed[p.id]" type="button" :class="btnGhost" class="!h-7 !px-2 !text-[11px] border border-gray-200 dark:border-zinc-700" @click.stop="shell.openExternal(p.url)">{{ isLocal(p.id) ? t('chat.settings.download') : t('chat.settings.install') }} ↗</button>
          </div>
        </div>
      </section>

      <!-- Its model -->
      <section>
        <h3 class="mb-2.5 text-[12px] font-medium text-gray-500 dark:text-zinc-400">{{ t('chat.settings.model', { tool: label(draft.provider) }) }}</h3>
        <select v-model="choice" :class="selectClass" :disabled="loading" :aria-label="t('chat.settings.model', { tool: label(draft.provider) })">
          <option value="">{{ isLocal(draft.provider) ? t('chat.settings.firstModel') : t('chat.settings.defaultModel') }}</option>
          <option v-for="m in known" :key="m" :value="m">{{ m }}</option>
          <option :value="CUSTOM">{{ t('chat.settings.otherModel') }}</option>
        </select>
        <input
          v-if="choice === CUSTOM"
          v-model="custom"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :class="inputClass"
          class="mt-2 font-mono !text-[12px]"
          :placeholder="t('chat.settings.customPlaceholder')"
          :aria-invalid="customInvalid"
        />
        <p v-if="customInvalid" class="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{{ t('chat.settings.invalidModel') }}</p>
        <p class="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-zinc-400">
          <span v-if="loading">{{ t('chat.settings.loadingModels') }}</span>
          <template v-else>{{ modelHint }}</template>
        </p>
      </section>

      <!-- History of the conversations -->
      <section>
        <h3 class="mb-2.5 text-[12px] font-medium text-gray-500 dark:text-zinc-400">{{ t('chat.history.title') }}</h3>
        <SwitchRow v-model="draft.history" :title="t('chat.history.keep')" :description="t('chat.history.keepHint')" />
        <button type="button" class="mt-2 text-[11px] text-gray-500 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400" @click="clearAllHistory">{{ t('chat.history.clearAll') }}</button>
      </section>

      <p class="text-[11px] leading-relaxed text-gray-400 dark:text-zinc-500">{{ t('chat.settings.account') }}</p>
    </div>

    <template #footer>
      <div class="ml-auto flex items-center gap-2">
        <button type="button" :class="btnGhost" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" :disabled="customInvalid || (choice === CUSTOM && !custom.trim())" @click="save">{{ t('common.save') }}</button>
      </div>
    </template>
  </AppModal>
</template>

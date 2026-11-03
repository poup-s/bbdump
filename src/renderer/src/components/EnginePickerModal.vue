<script setup lang="ts">
/**
 * First step of adding a database: which kind it is. A pasted connection URL picks the engine
 * by itself; otherwise one card per engine. Then the engine's own dialog opens (with the URL).
 * "On this computer" lists the engines bbdump can create a database for here; nothing is
 * installed at this step.
 */
import { computed, ref } from 'vue';
import { store, isRemoteOnly } from '../store';
import { useI18n } from '../composables/useI18n';
import { useFeatures } from '../composables/useFeatures';
import { MANIFESTS, engineFromConnectionText, isFileEngine, manifestFor } from '../../../shared/engines/manifests';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import EngineMark from './ui/EngineMark.vue';
import { btnGhost, btnPrimary, monoInputClass } from './ui/classes';

const ICON_DB = 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4';
const ICON_COMPUTER = 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z';

const { t } = useI18n();
const { engineLevel, feature, isEnabled } = useFeatures();

const local = computed(() => store.databaseModalIntent === 'local');

/** Can a database of this engine be created on this computer (a local server, or a file) */
const createsHere = (engine: string) => {
  if (isFileEngine(engine)) return true;
  if (engine === 'postgresql') return !isRemoteOnly();
  return isEnabled({ engine }, 'local.server');
};

/** SQL servers, then documents, then files */
const ORDER = ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'sqlite', 'duckdb'];
const rank = (engine: string) => (ORDER.includes(engine) ? ORDER.indexOf(engine) : ORDER.length);

const engines = computed(() => [...MANIFESTS]
  .sort((a, b) => rank(a.id) - rank(b.id))
  .filter(manifest => engineLevel(manifest.id) !== 'off')
  .filter(manifest => !local.value || createsHere(manifest.id))
  .map(manifest => ({
    id: manifest.id,
    label: manifest.label,
    hint: t(`enginePicker.${local.value ? 'localHints' : 'hints'}.${manifest.id}`),
    beta: feature({ engine: manifest.id }, 'connection.test').beta,
  })));

const pasted = ref('');
const detected = computed(() => {
  const engine = engineFromConnectionText(pasted.value);
  return engine && engines.value.some(e => e.id === engine) ? engine : null;
});

const pick = (engine: string, url?: string) => {
  // PostgreSQL on this computer: its own dialog (it creates the database on the local server)
  if (local.value && engine === 'postgresql') {
    store.showDatabaseModal = false;
    store.databaseModalIntent = 'connect';
    store.showCreateDatabaseModal = true;
    return;
  }
  store.databaseModalPrefill = url ?? null;
  store.databaseModalEngine = engine;
};

const submit = () => {
  if (detected.value) pick(detected.value, pasted.value.trim());
};

const close = () => {
  store.showDatabaseModal = false;
  store.databaseModalEngine = null;
  store.databaseModalIntent = 'connect';
  store.databaseModalPrefill = null;
  store.createDatabaseForProjectId = null;
};
</script>

<template>
  <AppModal
    :title="local ? t('enginePicker.localTitle') : t('enginePicker.addTitle')"
    :icon="local ? ICON_COMPUTER : ICON_DB"
    :close-label="t('common.cancel')"
    @close="close"
    @submit="submit"
  >
    <div class="space-y-5">
      <!-- A pasted URL says which engine it is for -->
      <div v-if="!local">
        <FormField :label="t('enginePicker.pasteLabel')" for="engine-paste" :hint="t('enginePicker.pasteHint')">
          <input
            id="engine-paste"
            v-model="pasted"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('enginePicker.pastePlaceholder')"
            :class="monoInputClass"
          />
        </FormField>
        <div v-if="pasted.trim()" class="mt-2 min-h-9 flex items-center gap-3" aria-live="polite">
          <template v-if="detected">
            <EngineMark :engine="detected" size="sm" />
            <span class="flex-1 text-[13px] text-gray-700 dark:text-zinc-200">{{ t('enginePicker.detected', { engine: manifestFor(detected)?.label ?? detected }) }}</span>
            <button type="button" :class="btnPrimary" @click="submit">{{ t('enginePicker.continue') }}</button>
          </template>
          <span v-else class="text-[12px] text-amber-700 dark:text-amber-400">{{ t('enginePicker.unknown') }}</span>
        </div>
      </div>

      <div>
        <ModalHeading
          :title="local ? t('enginePicker.localChooseTitle') : t('enginePicker.chooseTitle')"
          :subtitle="local ? t('enginePicker.localSubtitle') : undefined"
        />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            v-for="engine in engines"
            :key="engine.id"
            type="button"
            class="group flex items-center gap-3 p-3 rounded-xl border bg-white dark:bg-zinc-900 hover:bg-gray-50 dark:hover:bg-zinc-800/60 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
            :class="detected === engine.id ? 'border-emerald-500' : 'border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-600'"
            @click="pick(engine.id)"
          >
            <EngineMark :engine="engine.id" />
            <span class="flex-1 min-w-0">
              <span class="flex items-center gap-1.5">
                <span class="text-[14px] font-medium whitespace-nowrap text-gray-900 dark:text-zinc-50">{{ engine.label }}</span>
                <span v-if="engine.beta" class="px-1.5 py-px rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{{ t('common.beta') }}</span>
              </span>
              <span class="block text-[12px] leading-snug text-gray-500 dark:text-zinc-400">{{ engine.hint }}</span>
            </span>
            <svg class="w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600 group-hover:text-gray-500 dark:group-hover:text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <button type="button" :class="btnGhost" @click="close">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
    </template>
  </AppModal>
</template>

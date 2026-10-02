<script setup lang="ts">
/**
 * Restore, step 1 of 2: where the backup goes (an existing database, or a new local one).
 * Step 2 (RestoreConfirmModal) asks to type the name. Overwriting waits 5 s before going on.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { store, isRemoteOnly } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import type { RestoreTarget } from '../types';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { btnGhost, btnPrimary, monoInputClass, panelClass, selectClass } from './ui/classes';

const ICON_RESTORE = 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15';
const COUNTDOWN_SECONDS = 5;

const { t } = useI18n();
const { addToast } = useToast();

const databases = computed(() => store.databases || []);
const selectedDb = ref<string>('');
const restoreMode = ref<'existing' | 'new'>('existing');
const newDbName = ref('');
const newDbPort = ref(5432);
const attempted = ref(false);
const countdown = ref(COUNTDOWN_SECONDS);
let countdownInterval: ReturnType<typeof setInterval> | null = null;

/** The file name only: restoreBackupFile is an absolute path since 1.1.0 */
const backupName = computed(() => (store.restoreBackupFile || '').split(/[\\/]/).pop() || '');
const dbLabel = (db: { masked?: boolean; displayName?: string; name: string }) => (db.masked ? '••••••••' : (db.displayName || db.name));

const modeOptions = computed(() => [
  { value: 'existing' as const, label: t('modal.restoreModeExisting') },
  { value: 'new' as const, label: t('modal.restoreModeNew') },
]);
const steps = computed(() => [t('modal.restoreStepTarget'), t('modal.restoreStepConfirm')]);

const newNameError = computed(() => {
  if (restoreMode.value !== 'new') return undefined;
  const name = newDbName.value.trim();
  if (!name) return attempted.value ? t('createDatabase.errors.nameRequired') : undefined;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return t('createDatabase.errors.nameInvalid');
  if (store.databases.some(db => db.name === name)) return t('createDatabase.errors.nameExists');
  return undefined;
});
const newPortError = computed(() => (restoreMode.value === 'new' && (!newDbPort.value || newDbPort.value < 1024 || newDbPort.value > 65535)
  ? t('createDatabase.errors.portInvalid') : undefined));

/** Overwriting is destructive: a short pause before it can go on */
const waiting = computed(() => restoreMode.value === 'existing' && countdown.value > 0);

const stopCountdown = () => {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
};
const startCountdown = () => {
  stopCountdown();
  countdown.value = COUNTDOWN_SECONDS;
  countdownInterval = setInterval(() => {
    countdown.value = Math.max(0, countdown.value - 1);
    if (countdown.value === 0) stopCountdown();
  }, 1000);
};

onMounted(() => {
  // Back from the confirmation: same choice as before
  const previous = store.restoreTargetDb;
  if (previous?.isNew) {
    restoreMode.value = 'new';
    newDbName.value = previous.name;
    newDbPort.value = previous.port;
  } else {
    selectedDb.value = (previous && databases.value.find(db => db.name === previous.name && db.host === previous.host && db.port === previous.port)?.id)
      || databases.value[0]?.id || '';
  }
  startCountdown();
});
onUnmounted(stopCountdown);

// A different database to overwrite: the pause starts again
watch(selectedDb, (id, old) => { if (old && id !== old) startCountdown(); });
watch(restoreMode, (mode) => { if (mode === 'existing') startCountdown(); });

const proceedToConfirm = () => {
  attempted.value = true;
  if (waiting.value) return;
  if (restoreMode.value === 'existing') {
    const db = databases.value.find(item => item.id === selectedDb.value);
    if (!store.restoreBackupFile || !db) {
      addToast(t('toasts.selectTargetDatabase'), 'warning');
      return;
    }
    store.restoreTargetDb = db;
  } else {
    if (newNameError.value || newPortError.value) return;
    store.restoreTargetDb = {
      name: newDbName.value.trim(),
      displayName: newDbName.value.trim(),
      host: 'localhost',
      port: newDbPort.value,
      user: 'postgres', // Will be detected by databaseCreator
      password: '',
      output: '',
      isLocalBbdump: true,
      isNew: true
    } as RestoreTarget;
  }
  store.showRestoreModal = false;
  store.showRestoreConfirmModal = true;
};

const close = () => {
  store.showRestoreModal = false;
  store.restoreBackupFile = null;
  store.restoreTargetDb = null;
};

const selected = computed(() => databases.value.find(db => db.id === selectedDb.value) ?? null);
</script>

<template>
  <AppModal
    :title="t('modal.restoreTitle')"
    :icon="ICON_RESTORE"
    :steps="steps"
    :step="0"
    :close-label="t('common.cancel')"
    @close="close"
    @submit="proceedToConfirm"
  >
    <ModalHeading :eyebrow="t('modal.restoreEyebrow')" :title="t('modal.restoreWhere')" />

    <div class="space-y-4">
      <!-- The backup -->
      <div :class="panelClass" class="px-3.5 py-2.5">
        <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('modal.restoreSource') }}</div>
        <div class="font-mono text-[12px] text-gray-800 dark:text-zinc-200 overflow-hidden text-ellipsis whitespace-nowrap" :title="store.restoreBackupFile || undefined">{{ backupName }}</div>
      </div>

      <SegmentedControl v-if="!isRemoteOnly()" v-model="restoreMode" :options="modeOptions" :label="t('modal.restoreWhere')" />

      <FormField v-if="restoreMode === 'existing'" :label="t('modal.restoreTarget')" for="restore-target">
        <select id="restore-target" v-model="selectedDb" :class="selectClass">
          <option v-for="db in databases" :key="db.id" :value="db.id">{{ dbLabel(db) }} — {{ db.host }}:{{ db.port }}</option>
        </select>
      </FormField>

      <div v-else class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
        <FormField :label="t('modal.restoreNewDbName')" for="restore-new-name" required :error="newNameError" :hint="t('createDatabase.nameHint')">
          <input id="restore-new-name" v-model="newDbName" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" />
        </FormField>
        <FormField :label="t('modal.restoreNewDbPort')" for="restore-new-port" :error="newPortError">
          <input id="restore-new-port" v-model.number="newDbPort" type="number" min="1024" max="65535" :class="monoInputClass" />
        </FormField>
      </div>

      <!-- What happens -->
      <div
        class="rounded-xl border px-3.5 py-3"
        :class="restoreMode === 'existing'
          ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20'
          : 'border-gray-200 dark:border-zinc-800 bg-gray-50/70 dark:bg-zinc-800/30'"
      >
        <div class="text-[12px] font-medium mb-2" :class="restoreMode === 'existing' ? 'text-amber-800 dark:text-amber-300' : 'text-gray-700 dark:text-zinc-200'">
          {{ t('modal.restoreWhatHappens') }}
        </div>
        <ol class="space-y-1.5">
          <li v-for="(line, index) in (restoreMode === 'new'
            ? [t('modal.restoreNewDbStep1'), t('modal.restoreNewDbStep2'), t('modal.restoreNewDbStep3')]
            : [t('modal.restoreStep1'), t('modal.restoreStep2'), t('modal.restoreStep3')])"
            :key="index"
            class="flex items-start gap-2 text-[12px] leading-relaxed"
            :class="restoreMode === 'existing' && index === 0 ? 'text-amber-800 dark:text-amber-300 font-medium' : 'text-gray-600 dark:text-zinc-400'"
          >
            <span class="w-4 h-4 mt-0.5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-mono bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700">{{ index + 1 }}</span>
            <span>{{ line }}</span>
          </li>
        </ol>
        <p v-if="restoreMode === 'existing' && selected" class="mt-2 text-[11px] text-amber-700/80 dark:text-amber-400/80">
          {{ t('modal.restoreOverwrites', { name: dbLabel(selected) }) }}
        </p>
      </div>
    </div>

    <template #footer>
      <button type="button" :class="btnGhost" @click="close">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <button type="button" :class="btnPrimary" :disabled="waiting" @click="proceedToConfirm">
        <template v-if="waiting">{{ t('modal.restoreButtonWait', { seconds: countdown }) }}</template>
        <template v-else>{{ t('database.wizard.next') }}</template>
      </button>
    </template>
  </AppModal>
</template>

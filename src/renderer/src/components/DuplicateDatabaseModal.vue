<script setup lang="ts">
/** Copy a database into a new local one (backup → create → restore), in the shared dialog shell. */
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import { store } from '../store';
import AppModal from './ui/AppModal.vue';
import ModalHeading from './ui/ModalHeading.vue';
import FormField from './ui/FormField.vue';
import { btnGhost, btnPrimary, inputClass, monoInputClass, panelClass } from './ui/classes';

const ICON_COPY = 'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2';
const STEPS = ['backup', 'creating', 'restoring', 'complete'] as const;

const props = defineProps<{
  modelValue: boolean;
  sourceDb: Database | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'success', newDbName: string): void;
}>();

const { t } = useI18n();
const { addToast } = useToast();

const duplicateForm = ref({ name: '', password: '', port: 5432 });
const isDuplicating = ref(false);
const duplicateProgress = ref<{ step: string; message: string; progress: number } | null>(null);
const attempted = ref(false);
/** Names taken in bbdump or on the local server */
const existingNames = ref(new Set<string>());

const currentStepIndex = computed(() => {
  if (!duplicateProgress.value) return 0;
  return Math.max(0, STEPS.indexOf(duplicateProgress.value.step as typeof STEPS[number]));
});
const stepLabels = computed(() => STEPS.map(step => t(`databases.duplicateSteps.${step}`)));

const sourceLabel = computed(() => (props.sourceDb ? (props.sourceDb.masked ? '••••••••' : (props.sourceDb.displayName || props.sourceDb.name)) : ''));
const sourceWhere = computed(() => (props.sourceDb ? `${props.sourceDb.host}:${props.sourceDb.port} · ${props.sourceDb.name}` : ''));

onMounted(async () => {
  if (!props.sourceDb) return;
  const names = new Set(store.databases.map(d => d.name));
  try {
    const result = await ipcRenderer.invoke('get-postgres-config');
    (result?.databases || []).forEach((d: { name: string }) => names.add(d.name));
  } catch (e) {
    console.error('Failed to fetch physical databases for name check', e);
  }
  existingNames.value = names;

  // First free "<name>_copy", "<name>_copy_2"…
  const baseName = `${props.sourceDb.name}_copy`;
  let candidate = baseName;
  for (let counter = 2; names.has(candidate); counter++) candidate = `${baseName}_${counter}`;
  duplicateForm.value.name = candidate;
});

const nameError = computed(() => {
  const name = duplicateForm.value.name.trim();
  if (!name) return attempted.value ? t('databases.duplicateNameRequired') : undefined;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return t('databases.duplicateNameInvalid');
  if (existingNames.value.has(name)) return t('createDatabase.errors.nameExists');
  return undefined;
});
const portError = computed(() => {
  const port = duplicateForm.value.port;
  return !port || port < 1024 || port > 65535 ? t('createDatabase.errors.portInvalid') : undefined;
});

const closeModal = () => {
  if (isDuplicating.value) return;
  emit('update:modelValue', false);
};

const duplicateToLocal = async () => {
  if (!props.sourceDb || isDuplicating.value) return;
  attempted.value = true;
  if (nameError.value || portError.value) return;

  const formName = duplicateForm.value.name.trim();
  isDuplicating.value = true;
  duplicateProgress.value = { step: 'backup', message: t('databases.duplicateStepBackup'), progress: 0 };

  const progressHandler = (_event: unknown, progress: { step: string; message: string; progress: number }) => {
    duplicateProgress.value = progress;
  };
  ipcRenderer.on('duplicate-progress', progressHandler);

  try {
    const sourceDb = props.sourceDb;
    // The main process reads the source (and its password) from the saved config by id
    const sourceDbConfig: Partial<Database> = {
      id: sourceDb.id,
      name: sourceDb.name,
      displayName: sourceDb.displayName,
      host: sourceDb.host,
      port: sourceDb.port,
      user: sourceDb.user,
      password: '',
      encrypted: sourceDb.encrypted || false,
      encryptBackups: sourceDb.encryptBackups || false,
      cron: sourceDb.cron || '0 0 * * *',
      output: sourceDb.output || '',
      enabled: sourceDb.enabled || false,
      ssl: sourceDb.ssl || false,
      connectionString: sourceDb.connectionString,
      isLocalBbdump: sourceDb.isLocalBbdump || false
    };

    const result = await ipcRenderer.invoke('duplicate-external-to-local', {
      sourceDb: sourceDbConfig,
      targetName: formName,
      targetPassword: duplicateForm.value.password || undefined,
      targetPort: duplicateForm.value.port
    });

    if (result.success) {
      isDuplicating.value = false;
      addToast(t('databases.duplicateSuccess', { name: formName }), 'success');
      emit('success', formName);
      closeModal();
    } else {
      addToast(t('databases.duplicateError'), 'error', { detail: result.error });
    }
  } catch (error) {
    addToast(t('toasts.duplicateDbError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    ipcRenderer.removeListener('duplicate-progress', progressHandler);
    isDuplicating.value = false;
    duplicateProgress.value = null;
  }
};
</script>

<template>
  <AppModal
    v-if="modelValue"
    :title="t('databases.duplicateToLocalTitle')"
    :icon="ICON_COPY"
    :steps="isDuplicating ? stepLabels : []"
    :step="currentStepIndex"
    :busy="isDuplicating"
    :close-label="t('common.cancel')"
    @close="closeModal"
    @submit="duplicateToLocal"
  >
    <!-- Running: the steps are in the header bars -->
    <div v-if="isDuplicating" class="py-4" role="status" aria-live="polite">
      <ModalHeading :eyebrow="t('databases.duplicateEyebrow')" :title="duplicateForm.name" :subtitle="sourceWhere" />
      <div class="h-[3px] rounded-full overflow-hidden bg-gray-100 dark:bg-zinc-800">
        <div class="h-full rounded-full bg-emerald-500 transition-[width] duration-500" :style="{ width: `${Math.max(4, duplicateProgress?.progress ?? 0)}%` }" />
      </div>
      <div class="mt-2 flex items-center justify-between gap-3 text-[12px]">
        <span class="text-gray-600 dark:text-zinc-400 min-w-0 break-words">{{ duplicateProgress?.message || t('databases.duplicateStepBackup') }}</span>
        <span class="font-mono text-gray-400 dark:text-zinc-500 tabular-nums">{{ duplicateProgress?.progress ?? 0 }}%</span>
      </div>
    </div>

    <template v-else>
      <ModalHeading :eyebrow="t('databases.duplicateEyebrow')" :title="t('databases.duplicateTitle', { name: sourceLabel })" :subtitle="t('databases.duplicateInfo')" />
      <div class="space-y-4">
        <!-- Source → copy -->
        <div v-if="sourceDb" :class="panelClass" class="px-3.5 py-2.5 flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('databases.duplicateFrom') }}</div>
            <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100 overflow-hidden text-ellipsis whitespace-nowrap">{{ sourceLabel }}</div>
            <div class="font-mono text-[11px] text-gray-500 dark:text-zinc-500 overflow-hidden text-ellipsis whitespace-nowrap">{{ sourceWhere }}</div>
          </div>
          <svg class="w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
          <div class="min-w-0 flex-1 text-right">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('databases.duplicateTo') }}</div>
            <div class="font-mono text-[13px] text-emerald-700 dark:text-emerald-400 overflow-hidden text-ellipsis whitespace-nowrap">{{ duplicateForm.name || '—' }}</div>
            <div class="font-mono text-[11px] text-gray-500 dark:text-zinc-500">localhost:{{ duplicateForm.port }}</div>
          </div>
        </div>

        <FormField :label="t('database.name')" for="dup-name" required :error="nameError" :hint="t('createDatabase.nameHint')">
          <input id="dup-name" v-model="duplicateForm.name" type="text" spellcheck="false" autocomplete="off" :class="monoInputClass" :placeholder="t('database.namePlaceholder')" />
        </FormField>
        <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <FormField :label="t('database.password')" for="dup-password" :optional="t('common.optional')" :hint="t('createDatabase.passwordHint')">
            <input id="dup-password" v-model="duplicateForm.password" type="password" autocomplete="new-password" :class="inputClass" />
          </FormField>
          <FormField :label="t('database.port')" for="dup-port" :error="portError">
            <input id="dup-port" v-model.number="duplicateForm.port" type="number" min="1024" max="65535" :class="monoInputClass" />
          </FormField>
        </div>
      </div>
    </template>

    <template #footer>
      <button type="button" :class="btnGhost" :disabled="isDuplicating" @click="closeModal">{{ t('common.cancel') }}</button>
      <span class="flex-1" />
      <span v-if="!isDuplicating" class="hidden sm:inline text-[11px] text-gray-400 dark:text-zinc-500"><kbd class="font-mono">↵</kbd> Enter</span>
      <button type="button" :class="btnPrimary" :disabled="isDuplicating" @click="duplicateToLocal">
        <svg v-if="isDuplicating" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {{ t('databases.duplicateButton') }}
      </button>
    </template>
  </AppModal>
</template>

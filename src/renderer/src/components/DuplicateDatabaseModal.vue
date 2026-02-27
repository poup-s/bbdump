<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import { store } from '../store';

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

const duplicateForm = ref({
  name: '',
  password: '',
  port: 5432
});

const isDuplicating = ref(false);
const duplicateProgress = ref<{ step: string; message: string; progress: number } | null>(null);

const steps = ['backup', 'creating', 'restoring', 'complete'];

const currentStepIndex = computed(() => {
  if (!duplicateProgress.value) return -1;
  return steps.indexOf(duplicateProgress.value.step);
});

// Initialize form when modal opens
onMounted(async () => {
  if (!props.sourceDb) return;

  const baseName = `${props.sourceDb.name}_copy`;
  let potentialName = baseName;
  let counter = 2;

  const existingNames = new Set(store.databases.map(d => d.name));

  try {
    const result = await ipcRenderer.invoke('get-postgres-config');
    if (result && result.databases) {
      result.databases.forEach((d: any) => existingNames.add(d.name));
    }
  } catch (e) {
    console.error('Failed to fetch physical databases for name check', e);
  }

  while (existingNames.has(potentialName)) {
    potentialName = `${baseName}_${counter}`;
    counter++;
  }

  duplicateForm.value.name = potentialName;
});

const closeModal = () => {
  if (isDuplicating.value) return;
  emit('update:modelValue', false);
};

const duplicateToLocal = async () => {
  if (!props.sourceDb) return;

  const formName = duplicateForm.value.name;

  if (!formName || formName.trim() === '') {
    addToast(t('databases.duplicateNameRequired'), 'error');
    return;
  }

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(formName)) {
    addToast(t('databases.duplicateNameInvalid'), 'error');
    return;
  }

  isDuplicating.value = true;
  duplicateProgress.value = { step: 'backup', message: t('databases.duplicateStepBackup'), progress: 0 };

  try {
    const sourceDb = props.sourceDb;
    const sourceDbConfig: Partial<Database> = {
      id: sourceDb.id,
      name: sourceDb.name,
      displayName: sourceDb.displayName,
      host: sourceDb.host,
      port: sourceDb.port,
      user: sourceDb.user,
      password: sourceDb.password || '',
      encrypted: sourceDb.encrypted || false,
      encryptBackups: sourceDb.encryptBackups || false,
      cron: sourceDb.cron || '0 0 * * *',
      output: sourceDb.output || '',
      enabled: sourceDb.enabled || false,
      ssl: sourceDb.ssl || false,
      connectionString: sourceDb.connectionString,
      isLocalBbdump: sourceDb.isLocalBbdump || false
    };

    const progressHandler = (_event: any, progress: { step: string; message: string; progress: number }) => {
      duplicateProgress.value = progress;
    };

    ipcRenderer.on('duplicate-progress', progressHandler);

    const result = await ipcRenderer.invoke('duplicate-external-to-local', {
      sourceDb: sourceDbConfig,
      targetName: formName.trim(),
      targetPassword: duplicateForm.value.password || undefined,
      targetPort: duplicateForm.value.port
    });

    ipcRenderer.removeListener('duplicate-progress', progressHandler);

    if (result.success) {
      isDuplicating.value = false;
      addToast(t('databases.duplicateSuccess', { name: formName }), 'success');
      emit('success', formName);
      closeModal();
    } else {
      addToast(result.error || t('databases.duplicateError'), 'error');
    }
  } catch (error: any) {
    addToast(`Error duplicating database: ${error.message}`, 'error');
  } finally {
      isDuplicating.value = false;
      duplicateProgress.value = null;
  }
};
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click="closeModal">
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 scale-95 translate-y-2"
        enter-to-class="opacity-100 scale-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-95"
      >
        <div
          class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden flex flex-col"
          @click.stop
        >
          <!-- Header -->
          <div class="relative px-6 pt-6 pb-4">
            <!-- Gradient accent -->
            <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500"></div>

            <div class="flex items-start justify-between">
              <div class="flex items-start gap-3">
                <div class="mt-0.5 w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25 shrink-0">
                  <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                  </svg>
                </div>
                <div>
                  <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">{{ t('databases.duplicateToLocalTitle') }}</h3>
                  <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{{ t('databases.duplicateToLocalDesc', { name: sourceDb?.displayName || sourceDb?.name }) }}</p>
                </div>
              </div>
              <button
                @click="closeModal"
                :disabled="isDuplicating"
                class="p-1.5 -mr-1.5 -mt-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Content -->
          <div class="px-6 pb-6 flex-1">
            <!-- ===== DUPLICATING STATE ===== -->
            <div v-if="isDuplicating" class="space-y-6">
              <!-- Source → Target visual -->
              <div class="flex items-center justify-center gap-3 py-4">
                <div class="flex flex-col items-center gap-1.5">
                  <div class="w-12 h-12 rounded-xl bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 flex items-center justify-center">
                    <svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                    </svg>
                  </div>
                  <span class="text-[10px] font-medium text-gray-500 dark:text-gray-400 max-w-[80px] truncate text-center">{{ sourceDb?.displayName || sourceDb?.name }}</span>
                </div>

                <div class="flex items-center gap-1 text-blue-500">
                  <div class="w-8 h-px bg-blue-300 dark:bg-blue-700"></div>
                  <svg class="w-4 h-4 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                  <div class="w-8 h-px bg-blue-300 dark:bg-blue-700"></div>
                </div>

                <div class="flex flex-col items-center gap-1.5">
                  <div class="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 flex items-center justify-center">
                    <svg class="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
                    </svg>
                  </div>
                  <span class="text-[10px] font-medium text-blue-600 dark:text-blue-400 max-w-[80px] truncate text-center">{{ duplicateForm.name }}</span>
                </div>
              </div>

              <!-- Step indicators -->
              <div class="flex items-center justify-between gap-1 px-2">
                <template v-for="(step, index) in steps" :key="step">
                  <div class="flex flex-col items-center gap-1.5 flex-1">
                    <div
                      class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 shrink-0"
                      :class="{
                        'bg-blue-500 text-white shadow-md shadow-blue-500/30 scale-110': currentStepIndex === index,
                        'bg-emerald-500 text-white': currentStepIndex > index,
                        'bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-gray-500': currentStepIndex < index,
                      }"
                    >
                      <!-- Checkmark for completed steps -->
                      <svg v-if="currentStepIndex > index" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <!-- Spinner for active step -->
                      <svg v-else-if="currentStepIndex === index" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <!-- Number for future steps -->
                      <span v-else>{{ index + 1 }}</span>
                    </div>
                    <span
                      class="text-[10px] font-medium text-center leading-tight"
                      :class="{
                        'text-blue-600 dark:text-blue-400': currentStepIndex === index,
                        'text-emerald-600 dark:text-emerald-400': currentStepIndex > index,
                        'text-gray-400 dark:text-gray-500': currentStepIndex < index,
                      }"
                    >
                      {{ step === 'backup' ? 'Backup' : step === 'creating' ? 'Create' : step === 'restoring' ? 'Restore' : 'Done' }}
                    </span>
                  </div>
                  <!-- Connector line between steps -->
                  <div
                    v-if="index < steps.length - 1"
                    class="h-px flex-1 mt-[-18px] transition-all duration-300"
                    :class="currentStepIndex > index ? 'bg-emerald-400' : 'bg-gray-200 dark:bg-zinc-700'"
                  ></div>
                </template>
              </div>

              <!-- Progress bar -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium text-gray-600 dark:text-gray-400">{{ duplicateProgress?.message || t('databases.duplicating') }}</span>
                  <span class="text-xs font-bold text-blue-600 dark:text-blue-400 tabular-nums">{{ duplicateProgress?.progress || 0 }}%</span>
                </div>
                <div class="w-full bg-gray-100 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                  <div
                    class="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-500 ease-out"
                    :style="{ width: `${duplicateProgress?.progress || 0}%` }"
                  ></div>
                </div>
              </div>
            </div>

            <!-- ===== FORM STATE ===== -->
            <div v-else class="space-y-5">
              <!-- Source DB info card -->
              <div v-if="sourceDb" class="p-3.5 rounded-xl bg-gray-50 dark:bg-zinc-800/60 border border-gray-100 dark:border-zinc-700/50">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-lg bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 flex items-center justify-center shrink-0">
                    <svg class="w-4.5 h-4.5 text-gray-500 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                    </svg>
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{{ sourceDb.displayName || sourceDb.name }}</p>
                    <p class="text-xs text-gray-500 dark:text-gray-400 truncate">
                      <span v-if="sourceDb.connectionString">{{ sourceDb.connectionString.substring(0, 40) }}...</span>
                      <span v-else>{{ sourceDb.host }}:{{ sourceDb.port }} &middot; {{ sourceDb.user }}</span>
                    </p>
                  </div>
                  <span
                    class="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0"
                    :class="sourceDb.isLocalBbdump
                      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400'
                      : 'bg-gray-200 dark:bg-zinc-600 text-gray-600 dark:text-gray-300'"
                  >
                    {{ sourceDb.isLocalBbdump ? 'local' : 'external' }}
                  </span>
                </div>
              </div>

              <!-- Form fields -->
              <div class="space-y-4">
                <!-- Name -->
                <div>
                  <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    <svg class="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                    </svg>
                    {{ t('database.name') }}
                    <span class="text-red-400">*</span>
                  </label>
                  <input
                    v-model="duplicateForm.name"
                    type="text"
                    class="w-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 dark:focus:border-blue-500 transition-all placeholder:text-gray-400"
                    :placeholder="t('database.namePlaceholder')"
                  />
                  <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">{{ t('createDatabase.nameHint') }}</p>
                </div>

                <!-- Password & Port side by side -->
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      {{ t('database.password') }}
                    </label>
                    <input
                      v-model="duplicateForm.password"
                      type="password"
                      class="w-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 dark:focus:border-blue-500 transition-all placeholder:text-gray-400"
                      :placeholder="t('common.optional')"
                    />
                  </div>
                  <div>
                    <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      {{ t('database.port') }}
                    </label>
                    <input
                      v-model.number="duplicateForm.port"
                      type="number"
                      class="w-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 dark:focus:border-blue-500 transition-all placeholder:text-gray-400"
                      placeholder="5432"
                    />
                  </div>
                </div>
              </div>

              <!-- Info callout -->
              <div class="p-3 rounded-xl bg-blue-50/80 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/50">
                <div class="flex items-start gap-2.5">
                  <div class="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center shrink-0 mt-0.5">
                    <svg class="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p class="text-xs leading-relaxed text-blue-700 dark:text-blue-300/80">{{ t('databases.duplicateInfo') }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="px-6 py-4 flex justify-end gap-3 border-t border-gray-100 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-900/50">
            <button
              @click="closeModal"
              :disabled="isDuplicating"
              class="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              @click="duplicateToLocal"
              :disabled="isDuplicating"
              class="group relative overflow-hidden px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/25 hover:shadow-lg hover:shadow-blue-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
            >
              <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/15 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
              <svg v-if="isDuplicating" class="w-4 h-4 animate-spin relative z-10" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <svg v-else class="w-4 h-4 relative z-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
              </svg>
              <span class="relative z-10">{{ t('databases.duplicateButton') }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

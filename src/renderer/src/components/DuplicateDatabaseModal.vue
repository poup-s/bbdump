<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import { store } from '../store';
import PrerequisitesLoader from './PrerequisitesLoader.vue';

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

// Initialize form when modal opens
onMounted(async () => {
  if (!props.sourceDb) return;
  
  // Générer un nom unique
  let baseName = `${props.sourceDb.name}_local`;
  let potentialName = baseName;
  let counter = 1;
  
  // Combiner les bases de la config ET les bases physiques réelles
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
    // Créer un objet simple sérialisable pour éviter les erreurs de clonage IPC
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
    
    // Écouter les événements de progression
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
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" @click="closeModal">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
        @click.stop
      >
        <!-- Header -->
        <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
          <div>
            <h3 class="text-lg font-semibold">{{ t('databases.duplicateToLocalTitle') }}</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('databases.duplicateToLocalDesc', { name: sourceDb?.name }) }}</p>
          </div>
          <button 
            @click="closeModal" 
            :disabled="isDuplicating"
            class="text-gray-500 hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <!-- Content -->
        <div class="p-6 space-y-4">
          <!-- Loading State -->
          <div v-if="isDuplicating" class="flex flex-col items-center justify-center py-8">
            <div class="w-full h-48">
              <PrerequisitesLoader />
            </div>
            <div class="w-full space-y-2 mt-8">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ duplicateProgress?.message || t('databases.duplicating') }}</span>
                <span class="text-xs text-gray-500">{{ duplicateProgress?.progress || 0 }}%</span>
              </div>
              <div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2">
                <div 
                  class="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  :style="{ width: `${duplicateProgress?.progress || 0}%` }"
                ></div>
              </div>
            </div>
          </div>

          <!-- Form -->
          <div v-else>
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.name') }} *
              </label>
              <input
                v-model="duplicateForm.name"
                type="text"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                :placeholder="t('database.namePlaceholder')"
              />
              <p class="text-xs text-gray-500 mt-1">{{ t('createDatabase.nameHint') }}</p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.password') }} ({{ t('common.optional') }})
              </label>
              <input
                v-model="duplicateForm.password"
                type="password"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                :placeholder="t('database.password')"
              />
              <p class="text-xs text-gray-500 mt-1">{{ t('databases.duplicatePasswordHint') }}</p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.port') }}
              </label>
              <input
                v-model.number="duplicateForm.port"
                type="number"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                placeholder="5432"
              />
            </div>

            <div class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
              <div class="flex items-start gap-2">
                <svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p class="text-xs text-blue-700 dark:text-blue-300">{{ t('databases.duplicateInfo') }}</p>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Footer -->
        <div class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="closeModal"
            :disabled="isDuplicating"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="duplicateToLocal"
            :disabled="isDuplicating"
            class="px-6 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg v-if="isDuplicating" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span v-else>{{ t('databases.duplicateButton') }}</span>
          </button>
        </div>
      </div>
    </div>
</template>

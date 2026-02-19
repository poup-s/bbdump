<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const progress = ref<{ step: string; message: string; progress: number } | null>(null);
const isPortEditable = ref(false);
const form = ref({
  name: '',
  displayName: '',
  port: 5432,
  password: ''
});

const errors = ref({
  name: '',
  port: ''
});

watch(() => store.showCreateDatabaseModal, (show) => {
  if (show) {
    // Reset form
    form.value = {
      name: '',
      displayName: '',
      port: 5432,
      password: ''
    };
    errors.value = {
      name: '',
      port: ''
    };
    progress.value = null;
    isPortEditable.value = false;
  }
});

// Écouter les événements de progression depuis le main process
onMounted(() => {
  ipcRenderer.on('create-database-progress', (_, prog: { step: string; message: string; progress: number }) => {
    progress.value = prog;
  });
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('create-database-progress');
});

const validateForm = () => {
  errors.value = { name: '', port: '' };
  let isValid = true;

  if (!form.value.name || form.value.name.trim() === '') {
    errors.value.name = t('createDatabase.errors.nameRequired');
    isValid = false;
  } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(form.value.name)) {
    errors.value.name = t('createDatabase.errors.nameInvalid');
    isValid = false;
  }

  if (!form.value.port || form.value.port < 1024 || form.value.port > 65535) {
    errors.value.port = t('createDatabase.errors.portInvalid');
    isValid = false;
  }

  return isValid;
};

const createDatabase = async () => {
  if (!validateForm()) {
    return;
  }

  isLoading.value = true;
  progress.value = { step: 'starting', message: 'Starting...', progress: 0 };
  
  try {
    const result = await ipcRenderer.invoke('create-local-database', {
      name: form.value.name.trim(),
      displayName: form.value.displayName.trim() || undefined,
      port: form.value.port,
      password: form.value.password.trim() || undefined
    });

    if (result.success) {
      addToast(t('createDatabase.success', { name: form.value.name }), 'success');
      
      // Refresh databases
      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;
      
      // Highlight the newly created database
      const newDb = store.databases.find(d => d.name === form.value.name && d.isLocalBbdump);
      store.newlyAddedDbId = newDb?.id || null;
      setTimeout(() => {
        store.newlyAddedDbId = null;
      }, 2000);
      
      progress.value = null;
      close();
    } else {
      addToast(result.error || t('createDatabase.errors.createFailed'), 'error');
      progress.value = null;
    }
  } catch (error: any) {
    addToast(error.message || t('createDatabase.errors.createFailed'), 'error');
    progress.value = null;
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  store.showCreateDatabaseModal = false;
};
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-200 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div v-if="store.showCreateDatabaseModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-lg w-full border border-border overflow-hidden flex flex-col"
        @click.stop
      >
        <!-- Header -->
        <div class="px-6 py-4 border-b border-border flex justify-between items-center bg-surface">
          <div>
            <h3 class="text-xl font-bold">{{ t('modal.createDatabaseTitle') }}</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ t('modal.createDatabaseDesc') }}</p>
          </div>
          <button @click="close" class="text-gray-500 hover:text-foreground transition-colors">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <!-- Content -->
        <div class="p-6 space-y-6">
          <div class="space-y-4">
            <!-- Database Name -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.name') }} *
              </label>
              <input
                v-model="form.name"
                type="text"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                :class="{ 'border-red-500': errors.name }"
                :placeholder="t('database.namePlaceholder')"
              />
              <p v-if="errors.name" class="text-xs text-red-500 mt-1">{{ errors.name }}</p>
              <p v-else class="text-xs text-gray-500 mt-1">{{ t('createDatabase.nameHint') }}</p>
            </div>

            <!-- Display Name -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.displayName') }}
              </label>
              <input
                v-model="form.displayName"
                type="text"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                :placeholder="t('database.displayNamePlaceholder')"
              />
            </div>

            <!-- Password (Optional) -->
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('database.password') }} ({{ t('common.optional') }})
              </label>
              <input
                v-model="form.password"
                type="password"
                class="w-full bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
                :placeholder="t('database.password')"
              />
              <p class="text-xs text-gray-500 mt-1">{{ t('createDatabase.passwordHint') }}</p>
            </div>

            <!-- Port (Discret) -->
            <div class="pt-2">
              <div class="flex items-center justify-between mb-1.5">
                <label class="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {{ t('database.port') }}
                </label>
                <button
                  v-if="!isPortEditable"
                  @click="isPortEditable = true"
                  type="button"
                  class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors flex items-center gap-1"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  {{ t('common.edit') }}
                </button>
                <button
                  v-else
                  @click="isPortEditable = false; form.port = 5432"
                  type="button"
                  class="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                >
                  {{ t('common.cancel') }}
                </button>
              </div>
              <div class="flex items-center gap-2">
                <input
                  v-model.number="form.port"
                  type="number"
                  :disabled="!isPortEditable"
                  class="flex-1 bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all disabled:cursor-not-allowed disabled:opacity-60"
                  :class="{ 
                    'border-red-500': errors.port,
                    'bg-surface border-border': isPortEditable
                  }"
                  placeholder="5432"
                  min="1024"
                  max="65535"
                />
                <span v-if="!isPortEditable" class="text-xs text-gray-400 dark:text-gray-500 font-mono">
                  {{ form.port }}
                </span>
              </div>
              <p v-if="errors.port" class="text-xs text-red-500 mt-1">{{ errors.port }}</p>
              <p v-else-if="isPortEditable" class="text-xs text-gray-500 mt-1">{{ t('createDatabase.portHint') }}</p>
            </div>
          </div>

          <!-- Progress Logger -->
          <Transition
            enter-active-class="transition duration-300 ease-out"
            enter-from-class="opacity-0 max-h-0"
            enter-to-class="opacity-100 max-h-96"
            leave-active-class="transition duration-200 ease-in"
            leave-from-class="opacity-100 max-h-96"
            leave-to-class="opacity-0 max-h-0"
          >
            <div v-if="progress" class="p-4 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700 space-y-2 overflow-hidden">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('createDatabase.progress') }}</span>
                <span class="text-xs text-gray-500">{{ progress.progress }}%</span>
              </div>
              <div class="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2">
                <div 
                  class="bg-foreground h-2 rounded-full transition-all duration-300"
                  :style="{ width: `${progress.progress}%` }"
                ></div>
              </div>
              <div class="flex items-start gap-2 mt-2">
                <svg class="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p class="text-xs text-gray-600 dark:text-gray-400 flex-1">{{ progress.message }}</p>
              </div>
            </div>
          </Transition>

          <!-- Info Box -->
          <div v-if="!progress" class="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800">
            <div class="flex items-start gap-2.5">
              <svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p class="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
                {{ t('createDatabase.infoDesc') }}
              </p>
            </div>
          </div>
        </div>
        
        <!-- Footer -->
        <div class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="close"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="createDatabase"
            :disabled="isLoading"
            class="px-6 py-2 rounded-xl bg-foreground text-background hover:bg-zinc-800 transition-colors font-medium flex items-center gap-2 disabled:opacity-50"
          >
            <svg v-if="isLoading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('modal.createDatabase') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>


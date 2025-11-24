<script setup lang="ts">
import { ref, computed } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import RestoreAnimation from './RestoreAnimation.vue';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const selectedDb = ref<string>('');

// Auto-select first database if available
const databases = computed(() => store.databases || []);
if (databases.value.length > 0 && !selectedDb.value) {
  selectedDb.value = databases.value[0].name;
}

const restore = async () => {
  if (!store.restoreBackupFile || !selectedDb.value) return;

  const targetDb = databases.value.find(db => db.name === selectedDb.value);
  if (!targetDb) {
    addToast('Please select a target database', 'error');
    return;
  }

  isLoading.value = true;
  try {
    const payload = {
      backupFile: store.restoreBackupFile,
      target: {
        name: targetDb.name,
        host: targetDb.host,
        port: targetDb.port,
        user: targetDb.user,
        password: targetDb.password,
        connectionString: targetDb.connectionString
      }
    };
    
    await ipcRenderer.invoke('restore-backup', payload);
    addToast(t('toast.restoreStarted'), 'success');
    close();
  } catch (error: any) {
    addToast('Error starting restore: ' + error.message, 'error');
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  store.showRestoreModal = false;
  store.restoreBackupFile = null;
  selectedDb.value = '';
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
    <div v-if="store.showRestoreModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
        @click.stop
      >
        <div class="p-6">
          <div v-if="!isLoading">
            <div class="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-4">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            
            <h3 class="text-xl font-bold mb-2">{{ t('modal.restoreTitle') }}</h3>
            <p class="text-gray-500 mb-4">
              {{ t('modal.restoreConfirm', { file: store.restoreBackupFile }) }}
            </p>
            
            <!-- Database Selector -->
            <div class="mb-4">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('modal.restoreTarget') }}
              </label>
              <select
                v-model="selectedDb"
                class="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
              >
                <option v-for="db in databases" :key="db.name" :value="db.name">
                  {{ db.displayName || db.name }}
                </option>
              </select>
            </div>
            
            <div class="bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 p-3 rounded-lg text-sm border border-yellow-200 dark:border-yellow-800/50">
              {{ t('modal.restoreWarning') }}
            </div>
          </div>

          <div v-else class="flex flex-col items-center justify-center py-4">
            <RestoreAnimation />
            <p class="mt-4 text-gray-500 animate-pulse">{{ t('modal.titleProgress') }}</p>
          </div>
        </div>
        
        <div v-if="!isLoading" class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="close"
            class="px-4 py-2 rounded-xl text-gray-600 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="restore"
            :disabled="isLoading"
            class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white transition-colors font-medium flex items-center gap-2"
          >
            {{ t('modal.restoreButton') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

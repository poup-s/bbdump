<script setup lang="ts">
import { ref, computed } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import RestoreAnimation from './RestoreAnimation.vue';

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const confirmInput = ref('');
const error = ref('');

const targetDbName = computed(() => {
  return store.restoreTargetDb?.name || '';
});

const isConfirmValid = computed(() => {
  return confirmInput.value.trim() === targetDbName.value;
});


const restore = async () => {
  if (!isConfirmValid.value) {
    error.value = t('modal.restoreConfirmError');
    return;
  }

  if (!store.restoreBackupFile || !store.restoreTargetDb) {
    addToast('Missing backup file or target database', 'error');
    return;
  }

  isLoading.value = true;
  error.value = '';

  try {
    const target = {
      name: store.restoreTargetDb.name,
      host: store.restoreTargetDb.host,
      port: store.restoreTargetDb.port,
      user: store.restoreTargetDb.user,
      password: store.restoreTargetDb.password,
      connectionString: store.restoreTargetDb.connectionString
    };

    // If it's a new database, create it first
    if (store.restoreTargetDb.isNew) {
      const createResult = await ipcRenderer.invoke('create-local-database', {
        name: store.restoreTargetDb.name,
        port: store.restoreTargetDb.port,
        password: store.restoreTargetDb.password,
        enabled: false // Explicitly disable automatic backups for restored databases
      });

      if (!createResult.success || !createResult.database) {
        throw new Error(createResult.error || 'Failed to create database');
      }

      // Update target info with created database details (like the correct user)
      target.user = createResult.database.user;
      target.password = createResult.database.password;

      // Ensure the newly created database is added to the active databases list in the UI
      const config = await ipcRenderer.invoke('get-config');
      store.databases = config.databases;

      // Mark as no longer "new" so it's treated as an existing DB from now on
      store.restoreTargetDb.isNew = false;
    }

    const payload = {
      backupFile: store.restoreBackupFile,
      target
    };

    await ipcRenderer.invoke('restore-backup', payload);
    addToast(t('toasts.restoreStarted', { name: target.name }), 'success');
    close();
  } catch (error) {
    addToast('Error starting restore: ' + getErrorMessage(error), 'error');
  } finally {
    isLoading.value = false;
  }
};

const close = () => {
  store.showRestoreConfirmModal = false;
  store.restoreBackupFile = null;
  store.restoreTargetDb = null;
  confirmInput.value = '';
  error.value = '';
};

const handleInput = () => {
  error.value = '';
};
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden flex flex-col max-h-[92vh]"
        @click.stop
      >
        <div class="p-6 overflow-y-auto flex-1 custom-scrollbar">
          <div v-if="!isLoading">
            <div class="w-12 h-12 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mb-4">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>

            <h3 :class="['text-xl font-bold mb-2', store.restoreTargetDb?.isNew ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400']">
              {{ store.restoreTargetDb?.isNew ? t('modal.restoreConfirmCreateTitle') : t('modal.restoreConfirmTitle') }}
            </h3>

            <p class="text-gray-700 dark:text-gray-300 mb-4">
              {{ store.restoreTargetDb?.isNew
                 ? t('modal.restoreConfirmCreateMessage', { name: store.restoreTargetDb?.name })
                 : t('modal.restoreConfirmMessage') }}
            </p>

            <!-- Database Info -->
            <div class="mb-4 p-3 bg-gray-50 dark:bg-zinc-800/50 rounded-lg border border-gray-200 dark:border-zinc-700">
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('modal.restoreTarget') }}</div>
              <div class="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
                {{ store.restoreTargetDb?.displayName || store.restoreTargetDb?.name }}
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {{ store.restoreTargetDb?.host }}:{{ store.restoreTargetDb?.port }}
              </div>
            </div>

            <!-- Confirmation Input -->
            <div class="mb-4">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {{ t('modal.restoreConfirmPlaceholder') }}
              </label>
              <input
                v-model="confirmInput"
                @input="handleInput"
                type="text"
                :placeholder="t('modal.restoreConfirmPlaceholder')"
                class="w-full px-3 py-2 bg-white dark:bg-zinc-800 border rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none transition-all"
                :class="error ? 'border-red-500 dark:border-red-500' : 'border-gray-200 dark:border-zinc-700'"
                :disabled="isLoading"
              />
              <div v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">
                {{ error }}
              </div>
              <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <span v-if="currentLanguage === 'fr'">Tapez :</span><span v-else>Type :</span> <span class="font-mono font-semibold">{{ targetDbName }}</span>
              </div>
            </div>

            <!-- Warning -->
            <div :class="['p-3 rounded-lg text-sm border', store.restoreTargetDb?.isNew ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-800/50' : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-800/50']">
              <div class="flex items-start gap-2">
                <svg v-if="store.restoreTargetDb?.isNew" class="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <svg v-else class="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <div class="font-semibold mb-1">{{ store.restoreTargetDb?.isNew ? t('common.info') : t('modal.restoreWarning') }}</div>
                  <div class="text-xs opacity-90">
                    {{ store.restoreTargetDb?.isNew ? t('modal.restoreConfirmCreateWarning') : t('modal.restoreStep1') }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="flex flex-col items-center justify-center py-4">
            <RestoreAnimation />
            <p class="mt-4 text-gray-500 dark:text-gray-400 animate-pulse">{{ t('modal.titleProgress') }}</p>
          </div>
        </div>

        <div v-if="!isLoading" class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="close"
            class="px-4 py-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ t('common.cancel') }}
          </button>
            <button
              @click="restore"
              :disabled="!isConfirmValid"
              :class="['px-4 py-2 rounded-xl text-white transition-colors font-medium flex items-center gap-2', store.restoreTargetDb?.isNew ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700', !isConfirmValid ? 'disabled:bg-gray-400 disabled:cursor-not-allowed' : '']"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ store.restoreTargetDb?.isNew ? t('modal.restoreConfirmCreateButton') : t('modal.restoreConfirmButton') }}
            </button>
        </div>
      </div>
    </div>
</template>


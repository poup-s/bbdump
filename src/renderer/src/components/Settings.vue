<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer, shell } from '../electron';
import { store } from '../store';
import PostgresConfig from './PostgresConfig.vue';

const { t, setLanguage } = useI18n();
const { addToast } = useToast();

const currentLang = ref('en');
const defaultPath = ref('');
const isCheckingUpdates = ref(false);

const checkForUpdates = async () => {
  isCheckingUpdates.value = true;
  try {
    const result = await ipcRenderer.invoke('check-for-updates');
    if (result.updateAvailable) {
      addToast(t('settings.updateAvailable', { version: result.version }), 'info');
      // Open release page
      if (result.url) {
        shell.openExternal(result.url);
      }
    } else if (result.error) {
      addToast(t('settings.updateError') + ': ' + result.error, 'error');
    } else {
      addToast(t('settings.noUpdateAvailable'), 'success');
    }
  } catch (error: any) {
    addToast(t('settings.updateError') + ': ' + error.message, 'error');
  } finally {
    isCheckingUpdates.value = false;
  }
};

const loadSettings = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    currentLang.value = config.language || 'en';
    defaultPath.value = await ipcRenderer.invoke('get-default-path');
  } catch (error) {
    console.error('Error loading settings:', error);
  }
};

const saveLanguage = async () => {
  setLanguage(currentLang.value as 'en' | 'fr');
  try {
    await ipcRenderer.invoke('save-config', { language: currentLang.value });
    addToast(t('toasts.settingsSaved'), 'success');
  } catch (error: any) {
    addToast('Error saving settings: ' + error.message, 'error');
  }
};

const exportKey = async () => {
  try {
    const result = await ipcRenderer.invoke('export-key');
    if (result.success) {
      addToast(t('settings.keyExportSuccess'), 'success');
    } else if (result.error) {
      addToast(result.error, 'error');
    }
  } catch (error: any) {
    addToast('Error exporting key: ' + error.message, 'error');
  }
};

const importKey = async () => {
  try {
    const result = await ipcRenderer.invoke('import-key');
    if (result.success) {
      addToast(t('settings.keyImportSuccess'), 'success');
    } else if (result.error) {
      addToast(result.error, 'error');
    }
  } catch (error: any) {
    addToast('Error importing key: ' + error.message, 'error');
  }
};

const changeBackupLocation = async () => {
  try {
    const result = await ipcRenderer.invoke('select-directory');
    if (result) {
      defaultPath.value = result;
      addToast(t('settings.backupLocationChanged'), 'success');
    }
  } catch (error: any) {
    addToast('Error changing backup location: ' + error.message, 'error');
  }
};

const replayOnboarding = () => {
  store.onboardingCompleted = false;
  // No need to save to config immediately, as completing onboarding will save it.
  // But if we want to persist the "reset", we could. 
  // For now, just setting store state is enough to trigger the view.
};

onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="h-full flex flex-col max-w-2xl mx-auto">
    <div class="mb-8">
      <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.settings') }}</h2>
      <p class="text-gray-500 mt-1">{{ t('settings.description') }}</p>
    </div>

    <div class="space-y-6">
      <!-- Language -->
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border shadow-sm">
        <h3 class="text-lg font-semibold mb-4">{{ t('settings.general') }}</h3>
        <div class="flex items-center justify-between mb-4">
          <label class="text-gray-600">{{ t('settings.language') }}</label>
          <select
            v-model="currentLang"
            @change="saveLanguage"
            class="bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
          >
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </div>
        
        <div class="flex items-center justify-between pt-4 border-t border-border">
          <div class="text-gray-600">Onboarding</div>
          <button
            @click="replayOnboarding"
            class="px-4 py-2 bg-white dark:bg-zinc-800 border border-border rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors text-sm font-medium"
          >
            {{ t('settings.replayOnboarding') || 'Replay Onboarding' }}
          </button>
        </div>
      </div>
      
      <!-- Updates -->
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border shadow-sm">
        <h3 class="text-lg font-semibold mb-4">{{ t('settings.updates') }}</h3>
        <div class="flex items-center justify-between p-4 bg-surface rounded-xl">
          <div>
            <div class="font-medium">{{ t('settings.checkForUpdates') }}</div>
            <div class="text-sm text-gray-500 mt-1">{{ t('settings.checkForUpdatesDesc') }}</div>
          </div>
          <button
            @click="checkForUpdates"
            :disabled="isCheckingUpdates"
            class="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <svg v-if="isCheckingUpdates" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ isCheckingUpdates ? t('settings.checking') : t('settings.checkNow') }}
          </button>
        </div>
      </div>

      <!-- Security -->
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border shadow-sm">
        <h3 class="text-lg font-semibold mb-4">{{ t('settings.security') }}</h3>
        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-surface rounded-xl">
            <div>
              <div class="font-medium">{{ t('settings.encryptionKey') }}</div>
              <div class="text-sm text-gray-500 mt-1">{{ t('settings.encryptionKeyDesc') }}</div>
            </div>
            <div class="flex gap-2">
              <button
                @click="exportKey"
                class="px-4 py-2 bg-white dark:bg-zinc-800 border border-border rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors text-sm font-medium"
              >
                {{ t('settings.exportKey') }}
              </button>
              <button
                @click="importKey"
                class="px-4 py-2 bg-white dark:bg-zinc-800 border border-border rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors text-sm font-medium"
              >
                {{ t('settings.importKey') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Storage -->
      <div class="bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border shadow-sm">
        <h3 class="text-lg font-semibold mb-4">{{ t('settings.storage') }}</h3>
        <div class="p-4 bg-surface rounded-xl">
          <div class="font-medium mb-2">{{ t('settings.backupLocation') }}</div>
          <div class="flex items-center gap-3">
            <div class="flex-1 flex items-center gap-2 font-mono text-sm text-gray-500 bg-white dark:bg-zinc-800 p-3 rounded-lg border border-border overflow-x-auto">
              <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {{ defaultPath }}
            </div>
            <button
              @click="changeBackupLocation"
              class="px-4 py-2 bg-white dark:bg-zinc-800 border border-border rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors text-sm font-medium whitespace-nowrap"
            >
              {{ t('settings.change') }}
            </button>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {{ t('settings.backupLocationDesc') }}
          </p>
        </div>
      </div>

      <!-- PostgreSQL Configuration -->
      <PostgresConfig />
    </div>
  </div>
</template>

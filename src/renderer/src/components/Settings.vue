<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { store } from '../store';
import PostgresConfig from './PostgresConfig.vue';

const { t, setLanguage } = useI18n();
const { addToast } = useToast();

const currentLang = ref('en');
const defaultPath = ref('');

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
    await ipcRenderer.invoke('save-settings', { language: currentLang.value });
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
};

onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="h-full flex flex-col max-w-3xl mx-auto">
    <div class="mb-4 shrink-0">
      <h2 class="text-lg font-bold tracking-tight">{{ t('nav.settings') }}</h2>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('settings.description') }}</p>
    </div>

    <div class="space-y-4">
      <!-- General -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800">
        <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">{{ t('settings.general') }}</h3>
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.language') }}</span>
            <select
              v-model="currentLang"
              @change="saveLanguage"
              class="bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
            >
              <option value="en">English</option>
              <option value="fr">Français</option>
            </select>
          </div>
          <div class="border-t border-gray-100 dark:border-zinc-800"></div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-700 dark:text-gray-300">Onboarding</span>
            <button
              @click="replayOnboarding"
              class="px-3 py-1.5 text-xs font-medium bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
            >
              {{ t('settings.replayOnboarding') || 'Replay Onboarding' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Storage -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800">
        <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">{{ t('settings.storage') }}</h3>
        <div>
          <span class="text-sm text-gray-700 dark:text-gray-300 mb-2 block">{{ t('settings.backupLocation') }}</span>
          <div class="flex items-center gap-2">
            <div class="flex-1 flex items-center gap-2 font-mono text-xs text-gray-500 bg-gray-50 dark:bg-zinc-800 px-3 py-2 rounded-lg border border-gray-200 dark:border-zinc-700 overflow-x-auto">
              <svg class="w-3.5 h-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {{ defaultPath }}
            </div>
            <button
              @click="changeBackupLocation"
              class="px-3 py-2 text-xs font-medium bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors whitespace-nowrap"
            >
              {{ t('settings.change') }}
            </button>
          </div>
          <p class="text-[11px] text-gray-400 mt-1.5">{{ t('settings.backupLocationDesc') }}</p>
        </div>
      </div>

      <!-- Security -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800">
        <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">{{ t('settings.security') }}</h3>
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.encryptionKey') }}</span>
            <p class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.encryptionKeyDesc') }}</p>
          </div>
          <div class="flex gap-2 shrink-0 ml-4">
            <button
              @click="exportKey"
              class="px-3 py-1.5 text-xs font-medium bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
            >
              {{ t('settings.exportKey') }}
            </button>
            <button
              @click="importKey"
              class="px-3 py-1.5 text-xs font-medium bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors"
            >
              {{ t('settings.importKey') }}
            </button>
          </div>
        </div>
      </div>

      <!-- PostgreSQL Configuration -->
      <PostgresConfig />
    </div>
  </div>
</template>

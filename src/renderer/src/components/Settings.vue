<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { store } from '../store';
import PostgresConfig from './PostgresConfig.vue';

const { t, setLanguage } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const currentLang = ref('en');
const defaultPath = ref('');

// MCP Server
const mcpInstalled = ref(false);
const mcpConfigPath = ref('');
const mcpServerPath = ref('');
const mcpBbdumpConfigPath = ref('');
const mcpBbdumpKeyPath = ref('');
const mcpLoading = ref(false);
const mcpCustomExpanded = ref(false);
const mcpCopied = ref(false);
const claudeDesktopDetected = ref(false);

const mcpJsonConfig = computed(() => {
  const config = {
    "mcpServers": {
      "bbdump-postgres": {
        "command": "node",
        "args": [mcpServerPath.value || "/path/to/mcp-postgres/index.js"],
        "env": {
          "BBDUMP_CONFIG_PATH": mcpBbdumpConfigPath.value || "/path/to/config.json",
          "BBDUMP_KEY_PATH": mcpBbdumpKeyPath.value || "/path/to/.encryption.key"
        }
      }
    }
  };
  return JSON.stringify(config, null, 2);
});

const copyMcpConfig = async () => {
  try {
    await navigator.clipboard.writeText(mcpJsonConfig.value);
    mcpCopied.value = true;
    setTimeout(() => { mcpCopied.value = false; }, 2000);
  } catch {
    addToast('Failed to copy', 'error');
  }
};

const allowSqlMutations = ref(false);
const mcpSkipConfirmation = ref(false);

const loadSettings = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    currentLang.value = config.language || 'en';
    allowSqlMutations.value = config.allowSqlMutations || false;
    mcpSkipConfirmation.value = config.mcpSkipConfirmation || false;
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
    const result = await ipcRenderer.invoke('export-encryption-key');
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
    const result = await ipcRenderer.invoke('import-encryption-key');
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

const toggleSqlMutations = async () => {
  allowSqlMutations.value = !allowSqlMutations.value;
  store.allowSqlMutations = allowSqlMutations.value;
  try {
    await ipcRenderer.invoke('save-settings', { allowSqlMutations: allowSqlMutations.value });
    addToast(t('toasts.settingsSaved'), 'success');
  } catch (error: any) {
    addToast('Error saving settings: ' + error.message, 'error');
  }
};

const toggleMcpSkipConfirmation = async () => {
  if (!mcpSkipConfirmation.value) {
    // Enabling skip → show danger confirmation
    showConfirm({
      title: t('settings.mcpSkipConfirmation'),
      message: t('settings.mcpSkipConfirmationWarning'),
      confirmText: t('settings.mcpSkipConfirmation'),
      type: 'danger',
      onConfirm: async () => {
        mcpSkipConfirmation.value = true;
        try {
          await ipcRenderer.invoke('save-settings', { mcpSkipConfirmation: true });
          addToast(t('toasts.settingsSaved'), 'success');
        } catch (error: any) {
          addToast('Error saving settings: ' + error.message, 'error');
          mcpSkipConfirmation.value = false;
        }
      }
    });
  } else {
    // Disabling skip → no confirmation needed
    mcpSkipConfirmation.value = false;
    try {
      await ipcRenderer.invoke('save-settings', { mcpSkipConfirmation: false });
      addToast(t('toasts.settingsSaved'), 'success');
    } catch (error: any) {
      addToast('Error saving settings: ' + error.message, 'error');
      mcpSkipConfirmation.value = true;
    }
  }
};

const loadMcpStatus = async () => {
  try {
    const status = await ipcRenderer.invoke('get-mcp-status');
    mcpInstalled.value = status.installed;
    mcpConfigPath.value = status.configPath;
    mcpServerPath.value = status.serverPath;
    mcpBbdumpConfigPath.value = status.bbdumpConfigPath;
    mcpBbdumpKeyPath.value = status.bbdumpKeyPath;
    claudeDesktopDetected.value = status.claudeDesktopDetected;
  } catch (error) {
    console.error('Error loading MCP status:', error);
  }
};

const installMcp = async () => {
  mcpLoading.value = true;
  try {
    const result = await ipcRenderer.invoke('install-mcp-claude-desktop');
    if (result.success) {
      addToast(t('settings.mcpInstallSuccess'), 'success');
      mcpInstalled.value = true;
    } else {
      addToast(result.error || t('settings.mcpInstallError'), 'error');
    }
  } catch (error: any) {
    addToast(error.message || t('settings.mcpInstallError'), 'error');
  } finally {
    mcpLoading.value = false;
  }
};

const uninstallMcp = async () => {
  mcpLoading.value = true;
  try {
    const result = await ipcRenderer.invoke('uninstall-mcp-claude-desktop');
    if (result.success) {
      addToast(t('settings.mcpUninstallSuccess'), 'success');
      mcpInstalled.value = false;
    }
  } catch (error: any) {
    addToast(error.message, 'error');
  } finally {
    mcpLoading.value = false;
  }
};

onMounted(() => {
  loadSettings();
  loadMcpStatus();
});
</script>

<template>
  <div class="h-full flex flex-col">
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
          <div class="border-t border-gray-100 dark:border-zinc-800"></div>
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.allowSqlMutations') }}</span>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.allowSqlMutationsDesc') }}</p>
            </div>
            <button
              @click="toggleSqlMutations"
              class="relative w-10 h-5 rounded-full transition-colors duration-200 shrink-0 ml-4"
              :class="allowSqlMutations ? 'bg-orange-500' : 'bg-gray-300 dark:bg-zinc-600'"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200"
                :class="allowSqlMutations ? 'translate-x-5' : 'translate-x-0'"
              />
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

      <!-- MCP Server -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-800">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{{ t('settings.mcp') }}</h3>
          <span
            :class="[
              'text-[10px] font-bold px-2 py-0.5 rounded-full',
              mcpInstalled
                ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-gray-100 dark:bg-zinc-800 text-gray-500'
            ]"
          >
            {{ mcpInstalled ? t('settings.mcpInstalled') : t('settings.mcpNotInstalled') }}
          </span>
        </div>

        <div class="space-y-3">
          <!-- Description -->
          <div class="flex items-start gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-violet-100 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0 mt-0.5">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('settings.mcpTitle') }}</span>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.mcpDesc') }}</p>
            </div>
          </div>

          <div class="border-t border-gray-100 dark:border-zinc-800"></div>

          <!-- Database connections info -->
          <div class="bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg px-3 py-2.5">
            <div class="flex items-center gap-2 text-[11px]">
              <svg class="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <span class="text-gray-600 dark:text-gray-300">{{ t('settings.mcpConnectionAutoInfo') }}</span>
            </div>
            <p class="text-[10px] text-gray-400 mt-1 ml-5.5">{{ t('settings.mcpConnectionAutoDesc') }}</p>
          </div>

          <div class="border-t border-gray-100 dark:border-zinc-800"></div>

          <!-- Claude Desktop: single toggle button -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm text-gray-700 dark:text-gray-300">Claude Desktop</span>
                <p class="text-[10px] text-gray-400 mt-0.5">{{ t('settings.mcpClaudeDesktopDesc') }}</p>
              </div>
              <button
                v-if="!mcpInstalled"
                @click="installMcp"
                :disabled="mcpLoading || !claudeDesktopDetected"
                class="px-4 py-2 text-xs font-bold bg-violet-600 hover:bg-violet-700 disabled:bg-violet-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-1.5 shadow-sm shadow-violet-500/20 shrink-0 ml-4"
              >
                <svg v-if="mcpLoading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {{ t('settings.mcpInstall') }}
              </button>
              <button
                v-else
                @click="uninstallMcp"
                :disabled="mcpLoading"
                class="px-4 py-2 text-xs font-medium text-gray-500 hover:text-red-600 dark:hover:text-red-400 border border-gray-200 dark:border-zinc-700 rounded-lg hover:border-red-300 dark:hover:border-red-800 transition-colors shrink-0 ml-4 flex items-center gap-1.5"
              >
                <svg v-if="mcpLoading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {{ t('settings.mcpUninstall') }}
              </button>
            </div>
            <div v-if="!claudeDesktopDetected" class="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400/80">
              <svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              {{ t('settings.mcpClaudeNotDetected') }}
            </div>
          </div>

          <!-- Hint -->
          <div class="flex items-center gap-1.5 text-[10px] text-gray-400">
            <svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {{ t('settings.mcpRestartHint') }}
          </div>

          <!-- Skip MCP Confirmation -->
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm text-gray-700 dark:text-gray-300">{{ t('settings.mcpSkipConfirmation') }}</span>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ t('settings.mcpSkipConfirmationDesc') }}</p>
            </div>
            <button
              @click="toggleMcpSkipConfirmation"
              class="relative w-10 h-5 rounded-full transition-colors duration-200 shrink-0 ml-4"
              :class="mcpSkipConfirmation ? 'bg-red-500' : 'bg-gray-300 dark:bg-zinc-600'"
            >
              <span
                class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200"
                :class="mcpSkipConfirmation ? 'translate-x-5' : 'translate-x-0'"
              />
            </button>
          </div>

          <div class="border-t border-gray-100 dark:border-zinc-800"></div>

          <!-- Config path -->
          <div v-if="mcpConfigPath" class="flex items-center gap-1.5 font-mono text-[10px] text-gray-400 bg-gray-50 dark:bg-zinc-800/50 px-2 py-1 rounded">
            <span class="text-gray-500">{{ t('settings.mcpConfigPath') }}:</span>
            <span class="truncate">{{ mcpConfigPath }}</span>
          </div>

          <div class="border-t border-gray-100 dark:border-zinc-800"></div>

          <!-- Custom Installation -->
          <div>
            <button
              @click="mcpCustomExpanded = !mcpCustomExpanded"
              class="flex items-center gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors w-full"
            >
              <svg
                class="w-3 h-3 transition-transform"
                :class="{ 'rotate-90': mcpCustomExpanded }"
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              {{ t('settings.mcpCustomTitle') }}
            </button>

            <div v-if="mcpCustomExpanded" class="mt-2 space-y-2">
              <p class="text-[10px] text-gray-400">{{ t('settings.mcpCustomDesc') }}</p>

              <div class="relative">
                <pre class="bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg p-3 text-[11px] font-mono text-gray-700 dark:text-gray-300 overflow-x-auto leading-relaxed">{{ mcpJsonConfig }}</pre>
                <button
                  @click="copyMcpConfig"
                  class="absolute top-2 right-2 px-2 py-1 text-[10px] font-medium rounded-md transition-colors"
                  :class="mcpCopied
                    ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-white dark:bg-zinc-700 border border-gray-200 dark:border-zinc-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-600'"
                >
                  {{ mcpCopied ? t('settings.mcpCopied') : t('settings.mcpCopy') }}
                </button>
              </div>

              <div class="flex items-center gap-1.5 text-[10px] text-gray-400">
                <svg class="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {{ t('settings.mcpCustomHint') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- PostgreSQL Configuration -->
      <PostgresConfig />
    </div>
  </div>
</template>

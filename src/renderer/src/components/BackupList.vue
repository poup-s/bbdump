<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Backup } from '../types';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const selectedDb = ref<string>('all');
const isLoading = ref(false);

const filteredBackups = computed(() => {
  if (selectedDb.value === 'all') return store.backups;
  return store.backups.filter(b => b.database === selectedDb.value);
});

const loadBackups = async () => {
  isLoading.value = true;
  try {
    const response = await ipcRenderer.invoke('get-backups');
    store.backups = response.backups || [];
  } catch (error: any) {
    addToast('Error loading backups: ' + error.message, 'error');
  } finally {
    isLoading.value = false;
  }
};

const deleteBackup = (backup: Backup) => {
  showConfirm({
    title: t('modal.deleteTitle'),
    message: t('modal.deleteConfirm', { name: backup.filename }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('delete-backup', backup.filename);
        await loadBackups();
        addToast(t('toasts.backupDeleted'), 'success');
      } catch (error: any) {
        addToast('Error deleting backup: ' + error.message, 'error');
      }
    }
  });
};

const restoreBackup = (backup: Backup) => {
  store.restoreBackupFile = backup.filename;
  store.showRestoreModal = true;
};

const formatSize = (bytes: number) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (!bytes || bytes <= 0) return '0 Byte';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return Math.round(bytes / Math.pow(1024, i)) + ' ' + sizes[i];
};

onMounted(() => {
  loadBackups();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex justify-between items-center mb-8">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.backups') }}</h2>
        <p class="text-gray-500 mt-1">{{ filteredBackups.length }} backups found</p>
      </div>
      
      <div class="flex gap-4">
        <select
          v-model="selectedDb"
          class="bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
        >
          <option value="all">{{ t('common.allDatabases') }}</option>
          <option v-for="db in store.databases" :key="db.name" :value="db.name">
            {{ db.displayName || db.name }}
          </option>
        </select>
        
        <button
          @click="loadBackups"
          class="p-2 bg-surface rounded-xl hover:bg-border transition-colors"
          :title="t('common.refresh')"
        >
          <svg class="w-6 h-6" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="filteredBackups.length === 0" class="flex-1 flex flex-col items-center justify-center text-center opacity-60">
      <div class="w-24 h-24 bg-surface rounded-full flex items-center justify-center mb-4">
        <svg class="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
        </svg>
      </div>
      <h3 class="text-xl font-medium mb-2">{{ t('backup.noBackups') }}</h3>
      <p class="text-gray-500 max-w-sm">{{ t('backup.noBackupsDesc') }}</p>
    </div>

    <div v-else class="flex-1 min-h-0 bg-white dark:bg-zinc-900 rounded-2xl border border-border overflow-hidden shadow-sm flex flex-col">
      <div class="overflow-x-auto overflow-y-auto flex-1">
        <table class="w-full text-left border-separate border-spacing-0">
          <thead class="bg-surface sticky top-0 z-10 shadow-[0_1px_0_0_rgba(0,0,0,0.1)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
            <tr>
              <th class="px-6 py-4 font-medium text-sm text-gray-500 bg-surface whitespace-nowrap">{{ t('backup.tableDatabase') }}</th>
              <th class="px-6 py-4 font-medium text-sm text-gray-500 bg-surface whitespace-nowrap">{{ t('backup.tableDate') }}</th>
              <th class="px-6 py-4 font-medium text-sm text-gray-500 bg-surface whitespace-nowrap">{{ t('backup.tableSize') }}</th>
              <th class="px-6 py-4 font-medium text-sm text-gray-500 bg-surface text-right whitespace-nowrap">{{ t('backup.tableActions') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="backup in filteredBackups"
              :key="backup.filename"
              class="group hover:bg-surface/50 transition-colors"
            >
              <td class="px-6 py-4 border-b border-border/50">
                <div class="font-medium text-gray-900 dark:text-gray-100">{{ backup.database }}</div>
                <div class="text-xs text-gray-500 font-mono mt-0.5">{{ backup.filename }}</div>
              </td>
              <td class="px-6 py-4 text-sm text-gray-500 border-b border-border/50">
                {{ new Date(backup.created).toLocaleString() }}
              </td>
              <td class="px-6 py-4 text-sm font-mono text-gray-500 border-b border-border/50">
                {{ formatSize(backup.size) }}
              </td>
              <td class="px-6 py-4 text-right border-b border-border/50">
                <div class="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    @click="restoreBackup(backup)"
                    class="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-all active:scale-95 shadow-sm hover:shadow"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {{ t('backup.restore') }}
                  </button>
                  <button
                    @click="deleteBackup(backup)"
                    class="p-2 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-500 transition-colors"
                    :title="t('backup.delete')"
                  >
                    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

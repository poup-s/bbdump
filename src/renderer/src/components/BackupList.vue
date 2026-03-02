<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
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
const selected = ref<Set<string>>(new Set());
const isDeleting = ref(false);

const filteredBackups = computed(() => {
  if (selectedDb.value === 'all') return store.backups;
  return store.backups.filter(b => b.databaseId === selectedDb.value);
});

const allSelected = computed(() =>
  filteredBackups.value.length > 0 && filteredBackups.value.every(b => selected.value.has(b.filename))
);

const someSelected = computed(() =>
  filteredBackups.value.some(b => selected.value.has(b.filename)) && !allSelected.value
);

// Clear selection when filter changes
watch(selectedDb, () => {
  selected.value = new Set();
});

const toggleAll = () => {
  if (allSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(filteredBackups.value.map(b => b.filename));
  }
};

const toggleOne = (filename: string) => {
  const next = new Set(selected.value);
  if (next.has(filename)) {
    next.delete(filename);
  } else {
    next.add(filename);
  }
  selected.value = next;
};

const loadBackups = async () => {
  isLoading.value = true;
  try {
    const response = await ipcRenderer.invoke('get-backups');
    store.backups = response.backups || [];
  } catch (error) {
    addToast('Error loading backups: ' + getErrorMessage(error), 'error');
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
        selected.value.delete(backup.filename);
        await loadBackups();
        addToast(t('toasts.backupDeleted'), 'success');
      } catch (error) {
        addToast('Error deleting backup: ' + getErrorMessage(error), 'error');
      }
    }
  });
};

const deleteSelected = () => {
  const count = selected.value.size;
  if (count === 0) return;
  showConfirm({
    title: t('modal.deleteTitle'),
    message: t('backup.deleteSelectedConfirm', { count }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      isDeleting.value = true;
      try {
        const filenames = [...selected.value];
        for (const filename of filenames) {
          await ipcRenderer.invoke('delete-backup', filename);
        }
        selected.value = new Set();
        await loadBackups();
        addToast(t('backup.deleteSelectedSuccess', { count }), 'success');
      } catch (error) {
        addToast('Error deleting backups: ' + getErrorMessage(error), 'error');
      } finally {
        isDeleting.value = false;
      }
    }
  });
};

const restoreBackup = (backup: Backup) => {
  store.restoreBackupFile = backup.filename;
  store.showRestoreModal = true;
};

const downloadBackup = async (backup: Backup) => {
  try {
    const result = await ipcRenderer.invoke('download-backup', backup.filename);
    if (result?.success) {
      addToast(t('backup.downloaded'), 'success');
    }
  } catch (error) {
    addToast('Error downloading backup: ' + getErrorMessage(error), 'error');
  }
};

const formatSize = (bytes: number) => {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (!bytes || bytes <= 0) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  const val = bytes / Math.pow(1024, i);
  return (i === 0 ? val : val.toFixed(1)) + ' ' + sizes[i];
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `${t('backup.today')} ${time}`;
  if (isYesterday) return `${t('backup.yesterday')} ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ` ${time}`;
};

onMounted(() => {
  loadBackups();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="mb-4 shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold tracking-tight">{{ t('nav.backups') }}</h2>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {{ filteredBackups.length }} {{ t('backup.backupsCount') }}
          </p>
        </div>
        <div class="flex items-center gap-1.5">
          <!-- Database filter -->
          <select
            v-model="selectedDb"
            class="bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-gray-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
          >
            <option value="all">{{ t('common.allDatabases') }}</option>
            <option v-for="db in store.databases" :key="db.id" :value="db.id">
              {{ db.displayName || db.name }}
            </option>
          </select>

          <!-- Refresh -->
          <button
            @click="loadBackups"
            class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
            :title="t('common.refresh')"
          >
            <svg class="w-4 h-4" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="!isLoading && filteredBackups.length === 0" class="flex-1 flex flex-col items-center justify-center text-center">
      <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-3">
        <svg class="w-8 h-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
        </svg>
      </div>
      <p class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ t('backup.noBackups') }}</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('backup.noBackupsDesc') }}</p>
    </div>

    <!-- Table -->
    <div v-else class="flex-1 min-h-0 bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden flex flex-col">
      <!-- Bulk action bar -->
      <Transition
        enter-active-class="transition duration-150 ease-out"
        enter-from-class="opacity-0 -translate-y-2"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-100 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-2"
      >
        <div v-if="selected.size > 0" class="flex items-center gap-3 px-4 py-2 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/20 shrink-0">
          <span class="text-xs font-medium text-red-700 dark:text-red-400">
            {{ t('backup.selectedCount', { count: selected.size }) }}
          </span>
          <button
            @click="deleteSelected"
            :disabled="isDeleting"
            class="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors disabled:opacity-50"
          >
            <svg v-if="isDeleting" class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg v-else class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {{ t('backup.deleteSelected') }}
          </button>
          <button
            @click="selected = new Set()"
            class="text-[11px] text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium transition-colors"
          >
            {{ t('backup.clearSelection') }}
          </button>
        </div>
      </Transition>

      <div class="overflow-y-auto flex-1">
        <table class="w-full text-left border-separate border-spacing-0">
          <thead class="sticky top-0 z-10">
            <tr class="border-b border-gray-200 dark:border-zinc-800">
              <th class="px-4 py-2.5 w-10 bg-white dark:bg-zinc-900">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate="someSelected"
                  @change="toggleAll"
                  class="w-3.5 h-3.5 rounded border-gray-300 dark:border-zinc-600 text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0 cursor-pointer"
                />
              </th>
              <th class="px-4 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-white dark:bg-zinc-900">{{ t('backup.tableDatabase') }}</th>
              <th class="px-4 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-white dark:bg-zinc-900">{{ t('backup.tableDate') }}</th>
              <th class="px-4 py-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-white dark:bg-zinc-900 text-right">{{ t('backup.tableSize') }}</th>
              <th class="px-4 py-2.5 bg-white dark:bg-zinc-900"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-zinc-800/50">
            <tr
              v-for="backup in filteredBackups"
              :key="backup.filename"
              :class="[
                'group hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors',
                selected.has(backup.filename) ? 'bg-blue-50/50 dark:bg-blue-500/5' : ''
              ]"
            >
              <td class="px-4 py-2.5 w-10">
                <input
                  type="checkbox"
                  :checked="selected.has(backup.filename)"
                  @change="toggleOne(backup.filename)"
                  class="w-3.5 h-3.5 rounded border-gray-300 dark:border-zinc-600 text-blue-500 focus:ring-blue-500/30 focus:ring-offset-0 cursor-pointer"
                />
              </td>
              <td class="px-4 py-2.5">
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ store.databases.find(d => d.id === backup.databaseId)?.displayName || store.databases.find(d => d.id === backup.databaseId)?.name || backup.databaseId }}</span>
                <span class="text-[10px] text-gray-400 font-mono ml-2">{{ backup.filename }}</span>
              </td>
              <td class="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
                {{ formatDate(backup.created) }}
              </td>
              <td class="px-4 py-2.5 text-right">
                <code class="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{{ formatSize(backup.size) }}</code>
              </td>
              <td class="px-4 py-2.5">
                <div class="flex justify-end gap-1.5">
                  <button
                    @click="restoreBackup(backup)"
                    class="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 rounded-md hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {{ t('backup.restore') }}
                  </button>
                  <button
                    @click="downloadBackup(backup)"
                    class="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 rounded-md transition-colors"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {{ t('backup.download') }}
                  </button>
                  <button
                    @click="deleteBackup(backup)"
                    class="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    {{ t('backup.delete') }}
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

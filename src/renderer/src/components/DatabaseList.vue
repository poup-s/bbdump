<script setup lang="ts">
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { Database } from '../types';
import BackupAnimation from './BackupAnimation.vue';
import NewDbAnimation from './NewDbAnimation.vue';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const openAddModal = () => {
  store.editingDatabase = null;
  store.showDatabaseModal = true;
};

const editDatabase = (db: Database) => {
  store.editingDatabase = JSON.parse(JSON.stringify(db)); // Deep copy
  store.showDatabaseModal = true;
};

const deleteDatabase = (db: Database) => {
  showConfirm({
    title: t('modal.deleteTitle'),
    message: t('modal.deleteConfirm', { name: db.name }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('remove-database', db.name);
        const config = await ipcRenderer.invoke('get-config');
        store.databases = config.databases;
        addToast(t('toast.dbDeleted'), 'success');
      } catch (error: any) {
        addToast('Error deleting database: ' + error.message, 'error');
      }
    }
  });
};

const toggleSchedule = async (db: Database) => {
  try {
    await ipcRenderer.invoke('toggle-schedule', db.name, !db.enabled);
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    addToast(db.enabled ? 'Schedule paused' : 'Schedule enabled', 'info');
  } catch (error: any) {
    addToast('Error toggling schedule: ' + error.message, 'error');
  }
};

const backupNow = async (db: Database) => {
  try {
    store.isBackingUp = true;
    // store.showBackupModal = true; // Removed in favor of card animation
    await ipcRenderer.invoke('backup-now', db.name);
    // Success/Error handled by global listener in App.vue
  } catch (error: any) {
    store.isBackingUp = false;
    addToast('Error starting backup: ' + error.message, 'error');
  }
};

const openViewer = (db: Database) => {
  store.viewerDb = db;
  store.showDbViewer = true;
};

const copyConnectionUrl = async (db: Database) => {
  const url = `postgresql://${db.user}@${db.host}:${db.port}/${db.name}`;
  try {
    await navigator.clipboard.writeText(url);
    addToast(t('databases.urlCopied'), 'success');
  } catch (error) {
    addToast('Failed to copy URL', 'error');
  }
};
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex justify-between items-center mb-8">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.databases') }}</h2>
        <p class="text-gray-500 mt-1">{{ store.databases.length }} configured connections</p>
      </div>
      <div class="flex gap-3">
        <button
          @click="store.showCreateDatabaseModal = true"
          class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-medium hover:scale-105 transition-transform shadow-lg flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          {{ t('databases.createButton') }}
        </button>
        <button
          @click="openAddModal"
          class="bg-foreground text-background px-6 py-3 rounded-xl font-medium hover:scale-105 transition-transform shadow-lg flex items-center gap-2"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          {{ t('modal.addDatabase') }}
        </button>
      </div>
    </div>

    <div v-if="store.databases.length === 0" class="flex-1 flex flex-col items-center justify-center text-center opacity-60">
      <div class="w-24 h-24 bg-surface rounded-full flex items-center justify-center mb-4">
        <svg class="w-12 h-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
        </svg>
      </div>
      <h3 class="text-xl font-medium mb-2">{{ t('db.noDatabases') }}</h3>
      <p class="text-gray-500 max-w-sm">{{ t('db.noDatabasesDesc') }}</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-8">
      <div
        v-for="db in store.databases"
        :key="db.name"
        v-motion
        :initial="{ opacity: 0, y: 50 }"
        :enter="{ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 100, damping: 15 } }"
        class="group relative bg-white dark:bg-zinc-900 rounded-2xl p-6 border border-border hover:border-foreground/20 transition-all duration-500 hover:shadow-2xl hover:-translate-y-2"
        style="transform-style: preserve-3d;"
      >
        <!-- Status Indicator -->
        <div class="absolute top-6 right-6 flex gap-2">
          <div 
            :class="[
              'w-3 h-3 rounded-full shadow-sm',
              db.enabled ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-300 dark:bg-gray-600'
            ]"
            :title="db.enabled ? 'Backup Enabled' : 'Backup Paused'"
          ></div>
        </div>

        <!-- Content -->
        <div v-if="store.backupProgress?.dbName === db.name" class="h-32 mb-6 flex items-center justify-center">
          <BackupAnimation />
        </div>
        
        <div v-else-if="store.newlyAddedDbName === db.name" class="h-32 mb-6 flex items-center justify-center">
          <NewDbAnimation />
        </div>

        <div v-else class="mb-6">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="text-xl font-bold truncate pr-8">{{ db.displayName || db.name }}</h3>
            <span v-if="db.isLocalBbdump" class="px-2 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full">
              {{ t('databases.localBbdump') }}
            </span>
          </div>
          <div class="flex items-center text-sm text-gray-500 mt-1 font-mono">
            <span class="truncate max-w-[150px]">{{ db.user }}@{{ db.host }}:{{ db.port }}</span>
            <button
              v-if="db.isLocalBbdump"
              @click="copyConnectionUrl(db)"
              class="ml-2 p-1 hover:bg-surface rounded transition-colors"
              :title="t('databases.copyUrl')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
          <div class="mt-4 flex items-center gap-2 text-xs font-medium px-3 py-1 bg-surface rounded-full w-fit">
            <span class="text-gray-400">Last Backup:</span>
            <span>{{ db.lastBackup ? new Date(db.lastBackup).toLocaleDateString() : 'Never' }}</span>
          </div>
        </div>

        <!-- Actions (Reveal on Hover) -->
        <div class="grid grid-cols-4 gap-2 pt-4 border-t border-border opacity-80 group-hover:opacity-100 transition-opacity">
          <button
            @click="backupNow(db)"
            class="p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1"
            :title="t('db.backupNow')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
          </button>
          
          <button
            @click="openViewer(db)"
            class="p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1"
            :title="t('db.viewData')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>

          <button
            @click="editDatabase(db)"
            class="p-2 rounded-lg hover:bg-surface text-gray-500 hover:text-foreground transition-colors flex flex-col items-center gap-1"
            :title="t('db.edit')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>

          <button
            @click="deleteDatabase(db)"
            class="p-2 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors flex flex-col items-center gap-1"
            :title="t('db.delete')"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ipcRenderer } from '../electron';
import { useI18n } from '../composables/useI18n';

const { t, setLanguage } = useI18n();

interface TrayDatabase {
  name: string;
  displayName?: string;
  host: string;
  enabled?: boolean;
  lastBackup?: string;
  status?: 'success' | 'error' | 'running' | 'idle';
  cron?: string;
}

interface TrayBackupStats {
  total: number;
  totalSize: number;
}

const databases = ref<TrayDatabase[]>([]);
const backupStats = ref<TrayBackupStats>({ total: 0, totalSize: 0 });
const loading = ref(true);

const loadData = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    if (config?.language) setLanguage(config.language);
    databases.value = (config?.databases || []).map((db: any) => ({
      name: db.name,
      displayName: db.displayName,
      host: db.host,
      enabled: db.enabled,
      lastBackup: db.lastBackup,
      status: db.status || 'idle',
      cron: db.cron
    }));

    const backupsResult = await ipcRenderer.invoke('get-backups');
    if (backupsResult?.stats) {
      backupStats.value = backupsResult.stats;
    }
  } catch (err) {
    console.error('Tray: failed to load data', err);
  } finally {
    loading.value = false;
  }
};

const openDbViewer = (dbName: string) => {
  ipcRenderer.send('tray-open-dbviewer', dbName);
};

const editDb = (dbName: string) => {
  ipcRenderer.send('tray-edit-db', dbName);
};

const openApp = () => {
  ipcRenderer.send('tray-open-app');
};

const formatTimeAgo = (isoString?: string): string => {
  if (!isoString) return t('tray.never');
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('tray.justNow');
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(isoString).toLocaleDateString();
};

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const statusColor = (status?: string) => {
  switch (status) {
    case 'success': return 'bg-emerald-400';
    case 'error': return 'bg-red-400';
    case 'running': return 'bg-amber-400 animate-pulse';
    default: return 'bg-gray-400';
  }
};

onMounted(loadData);
</script>

<template>
  <div class="w-[320px] select-none p-1">
    <!-- Card -->
    <div class="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden">
      <!-- Header -->
      <div class="px-4 pt-3 pb-2 flex items-center justify-between border-b border-zinc-800">
        <div class="flex items-center gap-2">
          <div class="w-6 h-6 bg-violet-500/20 rounded-lg flex items-center justify-center">
            <svg class="w-3.5 h-3.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
          </div>
          <span class="text-sm font-bold text-white">bbdump</span>
        </div>
        <div class="flex items-center gap-1.5 text-[10px] text-zinc-500">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          {{ databases.length }} {{ t('tray.databases') }}
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="px-4 py-8 flex items-center justify-center">
        <svg class="w-5 h-5 text-violet-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>

      <!-- Database list -->
      <div v-else class="max-h-[260px] overflow-y-auto">
        <div v-if="databases.length === 0" class="px-4 py-6 text-center text-xs text-zinc-500">
          {{ t('tray.noDatabases') }}
        </div>
        <div
          v-for="db in databases"
          :key="db.name"
          class="px-4 py-2.5 flex items-center gap-3 hover:bg-zinc-800/50 transition-colors border-b border-zinc-800/50 last:border-b-0"
        >
          <!-- Status dot -->
          <div class="shrink-0">
            <div class="w-2 h-2 rounded-full" :class="statusColor(db.status)"></div>
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="text-[12px] font-semibold text-white truncate">{{ db.displayName || db.name }}</div>
          </div>

          <!-- DB Viewer button -->
          <button
            @click.stop="openDbViewer(db.name)"
            class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all bg-zinc-800 text-zinc-400 hover:bg-violet-500/20 hover:text-violet-400"
            :title="t('tray.viewDb')"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Stats footer -->
      <div v-if="!loading" class="px-4 py-2 border-t border-zinc-800 flex items-center justify-between text-[10px] text-zinc-500">
        <span>{{ backupStats.total }} {{ t('tray.totalBackups') }}</span>
        <span>{{ formatSize(backupStats.totalSize) }}</span>
      </div>

      <!-- Open app button -->
      <div class="px-3 pb-3 pt-1">
        <button
          @click="openApp"
          class="w-full py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          {{ t('tray.openApp') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import type { Log } from '../types';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const isLoading = ref(true);
const isFiltering = ref(false);
const filterLevel = ref('all');
const filterDatabase = ref('all');
const searchQuery = ref('');
const expandedLogs = ref<Set<number>>(new Set());

const configuredDatabases = computed(() => {
  return store.databases.map(db => db.name);
});

const databasesList = computed(() => {
  const dbs = new Set<string>();
  const configuredDbNames = new Set(configuredDatabases.value);

  store.logs.forEach(log => {
    if (log.database && log.database.trim()) {
      const dbName = log.database.trim();
      if (configuredDbNames.has(dbName)) {
        dbs.add(dbName);
      }
    }
  });
  return Array.from(dbs).sort();
});

const filteredLogs = computed(() => {
  let logs = store.logs;

  if (filterLevel.value !== 'all') {
    logs = logs.filter(log => log.level === filterLevel.value);
  }

  if (filterDatabase.value !== 'all') {
    logs = logs.filter(log => {
      return log.database && log.database.trim() === filterDatabase.value.trim();
    });
  }

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase();
    logs = logs.filter(log =>
      log.message.toLowerCase().includes(query) ||
      (log.database && log.database.toLowerCase().includes(query))
    );
  }

  return logs;
});

watch([filterLevel, filterDatabase, searchQuery], () => {
  if (store.logs.length > 500) {
    isFiltering.value = true;
    nextTick(() => {
      setTimeout(() => {
        isFiltering.value = false;
      }, 100);
    });
  }
}, { immediate: false });

const isLogExpanded = (index: number) => {
  return expandedLogs.value.has(index);
};

const toggleLogExpanded = (index: number) => {
  if (expandedLogs.value.has(index)) {
    expandedLogs.value.delete(index);
  } else {
    expandedLogs.value.add(index);
  }
};

const shouldTruncate = (message: string, maxLength: number = 200) => {
  return message.length > maxLength;
};

const truncateMessage = (message: string, maxLength: number = 200) => {
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength) + '...';
};

const formatTimestamp = (timestamp: string) => {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const copyLog = async (log: Log, _index: number) => {
  try {
    const logText = `[${new Date(log.timestamp).toLocaleString()}] [${log.level.toUpperCase()}]${log.database ? ` [${log.database}]` : ''} ${log.message}`;
    await navigator.clipboard.writeText(logText);
    addToast(t('logs.copied'), 'success');
  } catch {
    addToast(t('logs.copyError'), 'error');
  }
};

const copyAllLogs = async () => {
  try {
    const allLogsText = filteredLogs.value.map(log =>
      `[${new Date(log.timestamp).toLocaleString()}] [${log.level.toUpperCase()}]${log.database ? ` [${log.database}]` : ''} ${log.message}`
    ).join('\n');
    await navigator.clipboard.writeText(allLogsText);
    addToast(t('logs.allCopied', { count: filteredLogs.value.length }), 'success');
  } catch {
    addToast(t('logs.copyError'), 'error');
  }
};

const loadLogs = async () => {
  isLoading.value = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const logs = await ipcRenderer.invoke('get-logs');
    store.logs = logs;
    expandedLogs.value.clear();
  } catch (error) {
    addToast('Error loading logs: ' + getErrorMessage(error), 'error');
  } finally {
    isLoading.value = false;
  }
};

const clearLogs = () => {
  showConfirm({
    title: t('logs.clearConfirmTitle'),
    message: t('logs.clearConfirm'),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('clear-logs');
        store.logs = [];
        expandedLogs.value.clear();
        addToast(t('toasts.logsCleared'), 'success');
      } catch (error) {
        addToast('Error clearing logs: ' + getErrorMessage(error), 'error');
      }
    }
  });
};

const getLevelColor = (level: string) => {
  switch (level) {
    case 'error': return 'text-red-600 dark:text-red-400';
    case 'warn': return 'text-yellow-600 dark:text-yellow-400';
    case 'info': return 'text-blue-600 dark:text-blue-400';
    default: return 'text-gray-500';
  }
};

const getLevelBorderColor = (level: string) => {
  switch (level) {
    case 'error': return 'border-l-red-500';
    case 'warn': return 'border-l-yellow-500';
    case 'info': return 'border-l-blue-500';
    default: return 'border-l-gray-300 dark:border-l-zinc-700';
  }
};

const getLevelLabel = (level: string) => {
  switch (level) {
    case 'error': return 'ERR';
    case 'warn': return 'WRN';
    case 'info': return 'INF';
    default: return 'LOG';
  }
};

onMounted(() => {
  loadLogs();
});
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- Header -->
    <div class="flex items-center justify-between mb-3 shrink-0">
      <div class="flex items-center gap-3">
        <h2 class="text-lg font-bold tracking-tight">{{ t('nav.logs') }}</h2>
        <span class="text-xs text-gray-500 dark:text-gray-400 font-mono tabular-nums">
          {{ filteredLogs.length }} {{ t('logs.eventsRecorded') }}
          <span v-if="filteredLogs.length !== store.logs.length" class="text-gray-400 dark:text-gray-500">
            / {{ store.logs.length }}
          </span>
        </span>
      </div>

      <div class="flex items-center gap-1">
        <button
          @click="copyAllLogs"
          :disabled="filteredLogs.length === 0"
          class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          :title="t('logs.copyAll')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>

        <button
          @click="loadLogs"
          :disabled="isLoading"
          class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-30"
          :title="t('common.refresh')"
        >
          <svg class="w-4 h-4" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          @click="clearLogs"
          class="p-1.5 text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          :title="t('logs.clear')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Terminal container -->
    <div class="flex-1 min-h-0 bg-gray-50 dark:bg-[#0d1117] rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden flex flex-col shadow-lg">
      <!-- Terminal toolbar (filters) -->
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-zinc-800/80 bg-gray-100 dark:bg-[#161b22] shrink-0">
        <select
          v-model="filterLevel"
          class="bg-white dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50 text-gray-700 dark:text-gray-300 text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
        >
          <option value="all">{{ t('common.allLevels') }}</option>
          <option value="info">Info</option>
          <option value="error">Error</option>
          <option value="warn">Warning</option>
        </select>

        <select
          v-model="filterDatabase"
          class="bg-white dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50 text-gray-700 dark:text-gray-300 text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
        >
          <option value="all">{{ t('logs.allDatabases') }}</option>
          <option v-for="db in databasesList" :key="db" :value="db">{{ db }}</option>
        </select>

        <div class="relative flex-1 max-w-xs">
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('logs.searchPlaceholder')"
            class="w-full bg-white dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700/50 text-gray-700 dark:text-gray-300 text-xs rounded-md px-2 py-1 pl-7 focus:outline-none focus:ring-1 focus:ring-blue-500/30 placeholder-gray-400 dark:placeholder-gray-600"
          />
          <svg class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <button
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Log output -->
      <div class="flex-1 min-h-0 relative">
        <!-- Loader -->
        <div v-if="isLoading" class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-50/90 dark:bg-[#0d1117]/90">
          <svg class="w-8 h-8 animate-spin text-blue-500 mb-3" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-xs text-gray-500 font-mono">{{ t('logs.loading') }}</p>
        </div>

        <!-- Filtering loader -->
        <div v-else-if="isFiltering" class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-50/90 dark:bg-[#0d1117]/90">
          <svg class="w-8 h-8 animate-spin text-blue-500 mb-3" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p class="text-xs text-gray-500 font-mono">{{ t('logs.filtering') }}</p>
        </div>

        <!-- Empty state -->
        <div v-if="!isLoading && !isFiltering && filteredLogs.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 p-8">
          <p class="text-sm font-mono">{{ t('logs.noLogs') }}</p>
          <p class="text-xs text-gray-500 dark:text-gray-700 mt-1 font-mono">{{ t('logs.noLogsDescription') }}</p>
        </div>

        <!-- Log lines -->
        <div v-else-if="!isLoading && !isFiltering" class="h-full overflow-y-auto font-mono text-[13px] leading-[1.6] py-1">
          <div
            v-for="(log, index) in filteredLogs"
            :key="index"
            :class="[
              'group flex items-start px-3 py-[3px] border-l-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-default transition-colors',
              getLevelBorderColor(log.level)
            ]"
          >
            <!-- Timestamp -->
            <span class="text-gray-400 dark:text-gray-600 shrink-0 w-[70px] select-none tabular-nums">{{ formatTimestamp(log.timestamp) }}</span>

            <!-- Level -->
            <span :class="['shrink-0 w-[36px] font-bold select-none', getLevelColor(log.level)]">{{ getLevelLabel(log.level) }}</span>

            <!-- Database -->
            <span v-if="log.database" class="text-cyan-700 dark:text-cyan-600 shrink-0 mr-2 select-none">[{{ log.database }}]</span>

            <!-- Message -->
            <span class="text-gray-800 dark:text-gray-300 min-w-0 flex-1">
              <span
                v-if="!isLogExpanded(index) && shouldTruncate(log.message)"
                @click="toggleLogExpanded(index)"
                class="cursor-pointer"
              >
                {{ truncateMessage(log.message) }}
                <span class="text-gray-400 dark:text-gray-600 text-[11px] ml-1 hover:text-gray-600 dark:hover:text-gray-400">+more</span>
              </span>
              <span v-else class="whitespace-pre-wrap break-words">{{ log.message }}<span
                  v-if="shouldTruncate(log.message)"
                  @click="toggleLogExpanded(index)"
                  class="text-gray-400 dark:text-gray-600 text-[11px] ml-1 hover:text-gray-600 dark:hover:text-gray-400 cursor-pointer"
                > -less</span>
              </span>
            </span>

            <!-- Copy button -->
            <button
              @click.stop="copyLog(log, index)"
              class="shrink-0 ml-2 p-0.5 text-gray-300 dark:text-gray-700 hover:text-gray-500 dark:hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity"
              :title="t('logs.copy')"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

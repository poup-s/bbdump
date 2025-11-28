<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import type { Log } from '../types';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const isLoading = ref(true); // Initialiser à true pour afficher le loader dès l'arrivée sur la page
const isFiltering = ref(false);
const filterLevel = ref('all');
const filterDatabase = ref('all');
const searchQuery = ref('');
const expandedLogs = ref<Set<number>>(new Set());

// Liste des noms de bases de données réelles depuis la configuration
const configuredDatabases = computed(() => {
  return store.databases.map(db => db.name);
});

// Liste unique des bases de données dans les logs (uniquement celles qui existent dans la config)
const databasesList = computed(() => {
  const dbs = new Set<string>();
  const configuredDbNames = new Set(configuredDatabases.value);
  
  store.logs.forEach(log => {
    if (log.database && log.database.trim()) {
      const dbName = log.database.trim();
      // Ne garder que les bases de données qui existent réellement dans la configuration
      if (configuredDbNames.has(dbName)) {
        dbs.add(dbName);
      }
    }
  });
  return Array.from(dbs).sort();
});

const filteredLogs = computed(() => {
  let logs = store.logs;

  // Filtre par niveau
  if (filterLevel.value !== 'all') {
    logs = logs.filter(log => log.level === filterLevel.value);
  }

  // Filtre par base de données
  if (filterDatabase.value !== 'all') {
    logs = logs.filter(log => {
      // Comparaison stricte avec gestion des valeurs undefined/null
      return log.database && log.database.trim() === filterDatabase.value.trim();
    });
  }

  // Filtre par recherche textuelle
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase();
    logs = logs.filter(log => 
      log.message.toLowerCase().includes(query) ||
      (log.database && log.database.toLowerCase().includes(query))
    );
  }

  return logs;
});

// Watch pour détecter les changements de filtres et afficher le loader
watch([filterLevel, filterDatabase, searchQuery], () => {
  // Afficher le loader seulement si beaucoup de logs (plus de 500)
  if (store.logs.length > 500) {
    isFiltering.value = true;
    // Arrêter le loader après un court délai pour permettre le rendu
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

const shouldTruncate = (message: string, maxLength: number = 150) => {
  return message.length > maxLength;
};

const truncateMessage = (message: string, maxLength: number = 150) => {
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength) + '...';
};

const copyLog = async (log: Log, index: number) => {
  try {
    const logText = `[${new Date(log.timestamp).toLocaleString()}] [${log.level.toUpperCase()}]${log.database ? ` [${log.database}]` : ''} ${log.message}`;
    await navigator.clipboard.writeText(logText);
    addToast(t('logs.copied'), 'success');
  } catch (error: any) {
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
  } catch (error: any) {
    addToast(t('logs.copyError'), 'error');
  }
};

const loadLogs = async () => {
  isLoading.value = true;
  try {
    // Ajouter un petit délai pour s'assurer que le loader s'affiche
    await new Promise(resolve => setTimeout(resolve, 100));
    const logs = await ipcRenderer.invoke('get-logs');
    store.logs = logs;
    expandedLogs.value.clear(); // Réinitialiser les logs dépliés
  } catch (error: any) {
    addToast('Error loading logs: ' + error.message, 'error');
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
      } catch (error: any) {
        addToast('Error clearing logs: ' + error.message, 'error');
      }
    }
  });
};

const getLevelColor = (level: string) => {
  switch (level) {
    case 'error':
      return 'bg-red-500/10 text-red-400 border-red-500/20';
    case 'warn':
      return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20';
    case 'info':
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    default:
      return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
  }
};

const getLevelIcon = (level: string) => {
  switch (level) {
    case 'error':
      return 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
    case 'warn':
      return 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z';
    case 'info':
      return 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
    default:
      return 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z';
  }
};

onMounted(() => {
  // Le loader est déjà affiché car isLoading est initialisé à true
  loadLogs();
});
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- Header -->
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6 shrink-0">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.logs') }}</h2>
        <p class="text-gray-500 dark:text-gray-400 mt-1">
          {{ filteredLogs.length }} {{ t('logs.eventsRecorded') }}
          <span v-if="filteredLogs.length !== store.logs.length" class="text-gray-400">
            ({{ store.logs.length }} {{ t('logs.total') }})
          </span>
        </p>
      </div>
      
      <!-- Actions -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          @click="copyAllLogs"
          :disabled="filteredLogs.length === 0"
          class="px-4 py-2 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          :title="t('logs.copyAll')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {{ t('logs.copyAll') }}
        </button>
        
        <button
          @click="loadLogs"
          :disabled="isLoading"
          class="p-2 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-xl transition-colors disabled:opacity-50"
          :title="t('common.refresh')"
        >
          <svg class="w-5 h-5" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          @click="clearLogs"
          class="p-2 bg-red-100 dark:bg-red-900/20 hover:bg-red-200 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-xl transition-colors"
          :title="t('logs.clear')"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Filtres -->
    <div class="mb-4 p-4 bg-white dark:bg-zinc-900 rounded-2xl border border-gray-200 dark:border-zinc-800 shadow-sm shrink-0">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <!-- Filtre par niveau -->
        <div>
          <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
            {{ t('logs.filterLevel') }}
          </label>
          <select
            v-model="filterLevel"
            class="w-full bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
          >
            <option value="all">{{ t('common.allLevels') }}</option>
            <option value="info">Info</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
          </select>
        </div>

        <!-- Filtre par base de données -->
        <div>
          <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
            {{ t('logs.filterDatabase') }}
            <span v-if="databasesList.length > 0" class="text-gray-400 text-xs ml-1">
              ({{ databasesList.length }})
            </span>
          </label>
          <select
            v-model="filterDatabase"
            class="w-full bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
          >
            <option value="all">{{ t('logs.allDatabases') }}</option>
            <option v-for="db in databasesList" :key="db" :value="db">{{ db }}</option>
          </select>
        </div>

        <!-- Recherche textuelle -->
        <div>
          <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
            {{ t('logs.search') }}
          </label>
          <div class="relative">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('logs.searchPlaceholder')"
              class="w-full bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl px-4 py-2 pl-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
            />
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <button
              v-if="searchQuery"
              @click="searchQuery = ''"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Liste des logs -->
    <div class="flex-1 min-h-0 bg-gray-50 dark:bg-zinc-950 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden shadow-inner relative">
      <!-- Loader initial -->
      <div v-if="isLoading" class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-sm">
        <svg class="w-12 h-12 animate-spin text-blue-600 mb-4" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('logs.loading') }}</p>
      </div>

      <!-- Loader de filtrage -->
      <div v-else-if="isFiltering" class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-50/80 dark:bg-zinc-950/80 backdrop-blur-sm">
        <svg class="w-12 h-12 animate-spin text-blue-600 mb-4" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('logs.filtering') }}</p>
      </div>

      <div v-if="!isLoading && !isFiltering && filteredLogs.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 p-8">
        <svg class="w-16 h-16 mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="text-lg font-medium">{{ t('logs.noLogs') }}</p>
        <p class="text-sm mt-2">{{ t('logs.noLogsDescription') }}</p>
      </div>
      
      <div v-else-if="!isLoading && !isFiltering" class="h-full overflow-y-auto p-4 space-y-2">
        <div
          v-for="(log, index) in filteredLogs"
          :key="index"
          class="group bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 p-4 hover:shadow-md transition-all duration-200"
        >
          <div class="flex items-start gap-3">
            <!-- Badge niveau -->
            <div :class="['px-3 py-1 rounded-lg border text-xs font-semibold shrink-0', getLevelColor(log.level)]">
              <div class="flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="getLevelIcon(log.level)" />
                </svg>
                {{ log.level.toUpperCase() }}
              </div>
            </div>

            <!-- Contenu principal -->
            <div class="flex-1 min-w-0">
              <!-- En-tête avec timestamp et base de données -->
              <div class="flex items-center gap-3 mb-2 flex-wrap">
                <span class="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {{ new Date(log.timestamp).toLocaleString() }}
                </span>
                <span v-if="log.database" class="px-2 py-0.5 bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 rounded-md text-xs font-medium">
                  {{ log.database }}
                </span>
              </div>

              <!-- Message -->
              <div class="text-sm text-gray-800 dark:text-gray-200 font-mono">
                <span v-if="!isLogExpanded(index) && shouldTruncate(log.message)">
                  {{ truncateMessage(log.message) }}
                </span>
                <span v-else class="whitespace-pre-wrap break-words">
                  {{ log.message }}
                </span>
              </div>
            </div>

            <!-- Actions -->
            <div class="flex items-start gap-2 shrink-0">
              <!-- Bouton déplier/replier -->
              <button
                v-if="shouldTruncate(log.message)"
                @click="toggleLogExpanded(index)"
                class="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                :title="isLogExpanded(index) ? t('logs.collapse') : t('logs.expand')"
              >
                <svg class="w-4 h-4 transition-transform" :class="{ 'rotate-180': isLogExpanded(index) }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <!-- Bouton copier -->
              <button
                @click="copyLog(log, index)"
                class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                :title="t('logs.copy')"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

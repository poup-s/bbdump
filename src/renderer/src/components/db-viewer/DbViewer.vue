<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import { buildDbConfig } from '../../types';
import TableSidebar from './TableSidebar.vue';
import TableData from './TableData.vue';
import TableRelations from './TableRelations.vue';
import TableSchema from './TableSchema.vue';
import TableSchemaVisualizer from './TableSchemaVisualizer.vue';
import PerformanceTab from './PerformanceTab.vue';

const emit = defineEmits(['close']);
const { t } = useI18n();

const tables = ref<any[]>([]);
const selectedTable = ref<string | null>(null);
const activeTab = ref('data'); // data, relations, schema
const viewMode = ref('visualizer'); // explorer, visualizer
const loading = ref(false);
const error = ref<string | null>(null);

const loadTables = async () => {
  if (!store.viewerDb) return;

  loading.value = true;
  error.value = null;
  try {
    const result = await ipcRenderer.invoke('get-db-tables', { db: buildDbConfig(store.viewerDb) });
    tables.value = result.tables;
  } catch (err: any) {
    console.error('Error loading tables:', err);
    error.value = err.message || 'Failed to connect to database';
  } finally {
    loading.value = false;
  }
};

const handleTableSelect = (tableName: string) => {
  viewMode.value = 'explorer';
  selectedTable.value = tableName;
};

const handleNavigateToTable = (tableName: string) => {
  viewMode.value = 'explorer';
  activeTab.value = 'data';
  selectedTable.value = tableName;
};

const handleVisualizeClick = () => {
  viewMode.value = 'visualizer';
  selectedTable.value = null;
};

const handlePerformanceClick = () => {
  viewMode.value = 'performance';
  selectedTable.value = null;
};

onMounted(() => {
  loadTables();
});
</script>

<template>
  <div class="fixed inset-0 z-[200] flex animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 w-full h-full flex flex-col overflow-hidden">
      <!-- Header (drag region with traffic light clearance) -->
      <div class="px-4 pt-7 pb-1.5 border-b border-gray-200 dark:border-zinc-800 flex items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl drag-region">
        <!-- Left spacer (matches close button size for centering) -->
        <div class="w-8 shrink-0"></div>
        <!-- Centered db info -->
        <div class="flex-1 flex flex-col items-center justify-center no-drag min-w-0">
          <div class="flex items-center gap-2">
            <div class="w-5 h-5 rounded bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            </div>
            <h3 class="text-xs font-bold text-gray-900 dark:text-white leading-tight">
              {{ store.viewerDb?.displayName || store.viewerDb?.name }}
            </h3>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
            <span class="font-mono">{{ store.viewerDb?.host }}:{{ store.viewerDb?.port }}</span>
            <span>•</span>
            <span>{{ t('viewer.tablesCount', { count: tables.length }) }}</span>
          </div>
        </div>
        <!-- Close button -->
        <button
          @click="emit('close')"
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200 no-drag shrink-0"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar -->
        <TableSidebar
          :tables="tables"
          :selected-table="selectedTable"
          :loading="loading"
          :view-mode="viewMode"
          :is-local-bbdump="store.viewerDb?.isLocalBbdump"
          @select="handleTableSelect"
          @visualize="handleVisualizeClick"
          @performance="handlePerformanceClick"
        />

        <!-- Main Content -->
        <div class="flex-1 flex flex-col overflow-hidden bg-white dark:bg-surface/50 backdrop-blur-md relative">
          <!-- Visualizer View -->
          <TableSchemaVisualizer
            v-if="viewMode === 'visualizer'"
            :db="store.viewerDb"
          />

          <!-- Performance View -->
          <PerformanceTab
            v-else-if="viewMode === 'performance'"
            :db="store.viewerDb"
          />

          <!-- Explorer View -->
          <template v-else>
            <!-- Loading State -->
            <div v-if="loading" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-white/80 dark:bg-surface/80 backdrop-blur-sm">
              <div class="mb-6">
                <div class="relative w-16 h-16 mx-auto">
                  <div class="absolute inset-0 border-4 border-blue-500/30 rounded-full"></div>
                  <div class="absolute inset-0 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              </div>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-foreground mb-2">{{ t('viewer.loadingDb') }}</h3>
              <p class="text-sm text-gray-500">{{ t('viewer.fetchingInfo') }}</p>
            </div>
            
            <!-- Error State -->
            <div v-else-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-white/80 dark:bg-surface/80 backdrop-blur-sm">
              <div class="mb-6 p-6 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-2xl max-w-md">
                <div class="w-12 h-12 bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h3 class="text-lg font-bold text-red-700 dark:text-red-500 mb-2">{{ t('viewer.connectionFailed') }}</h3>
                <p class="text-sm text-red-600 dark:text-red-400 mb-4">{{ error }}</p>
                <button 
                  @click="loadTables" 
                  class="px-4 py-2 bg-red-600 dark:bg-red-500 hover:bg-red-700 dark:hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-red-500/20"
                >
                  {{ t('viewer.retry') }}
                </button>
              </div>
            </div>
            
            <!-- Success State -->
            <div v-else-if="!loading && selectedTable" class="flex flex-col h-full">
              <!-- Tabs -->
              <div class="border-b border-gray-200 dark:border-white/10 px-4 bg-gray-50/50 dark:bg-surface/30 backdrop-blur-sm">
                <nav class="-mb-px flex space-x-4">
                  <button
                    v-for="tab in ['data', 'relations', 'schema']"
                    :key="tab"
                    @click="activeTab = tab"
                    :class="[
                      activeTab === tab
                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600',
                      'whitespace-nowrap py-2 px-1 border-b-2 font-medium text-xs transition-colors duration-200 capitalize'
                    ]"
                  >
                    {{ t(`viewer.${tab}`) }}
                  </button>
                </nav>
              </div>

              <!-- Content -->
              <div class="flex-1 overflow-hidden p-2">
                <div class="h-full overflow-hidden flex flex-col">
                  <TableData
                    v-if="activeTab === 'data'"
                    :db="store.viewerDb"
                    :table="selectedTable"
                    class="flex-1 overflow-hidden"
                    @navigate-to-table="handleNavigateToTable"
                  />
                  <TableRelations
                    v-if="activeTab === 'relations'"
                    :db="store.viewerDb"
                    :table="selectedTable"
                  />
                  <TableSchema
                    v-if="activeTab === 'schema'"
                    :db="store.viewerDb"
                    :table="selectedTable"
                  />
                </div>
              </div>
            </div>
            
            <!-- Empty State -->
            <div v-else-if="!loading && !error" class="flex-1 flex flex-col items-center justify-center p-8 text-center bg-gray-50/30 dark:bg-transparent">
              <div class="w-20 h-20 bg-gray-100 dark:bg-surface rounded-full flex items-center justify-center mb-6 text-gray-400 shadow-inner border border-gray-200 dark:border-white/10">
                <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M3 14h18m-9-4v8m-7-6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
                </svg>
              </div>
              <h3 class="text-xl font-bold text-gray-900 dark:text-white mb-2">Prêt à explorer</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto mb-6">{{ t('viewer.selectPrompt') }}</p>
              <button 
                @click="handleVisualizeClick"
                class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-all shadow-lg shadow-blue-500/25 flex items-center gap-2"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
                Ouvrir le visualiseur de schéma
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

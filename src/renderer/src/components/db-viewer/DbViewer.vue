<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import TableSidebar from './TableSidebar.vue';
import TableData from './TableData.vue';
import TableRelations from './TableRelations.vue';
import TableSchema from './TableSchema.vue';

const emit = defineEmits(['close']);
const { t } = useI18n();

const tables = ref<any[]>([]);
const selectedTable = ref<string | null>(null);
const activeTab = ref('data'); // data, relations, schema
const loading = ref(false);
const error = ref<string | null>(null);

const loadTables = async () => {
  if (!store.viewerDb) return;
  
  loading.value = true;
  error.value = null;
  try {
    // Create a plain object to avoid cloning errors with Vue reactive objects
    const dbConfig = {
      name: store.viewerDb.name,
      host: store.viewerDb.host,
      port: store.viewerDb.port,
      user: store.viewerDb.user,
      password: store.viewerDb.password,
      connectionString: store.viewerDb.connectionString
    };
    
    const result = await ipcRenderer.invoke('get-db-tables', { db: dbConfig });
    tables.value = result.tables;
    if (tables.value.length > 0 && !selectedTable.value) {
      selectedTable.value = tables.value[0].name;
    }
  } catch (err: any) {
    console.error('Error loading tables:', err);
    error.value = err.message || 'Failed to connect to database';
  } finally {
    loading.value = false;
  }
};

const handleTableSelect = (tableName: string) => {
  selectedTable.value = tableName;
};

onMounted(() => {
  loadTables();
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6 animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full h-full max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden border border-white/10 ring-1 ring-black/5">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex justify-between items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-bold text-gray-900 dark:text-white">
              {{ store.viewerDb?.displayName || store.viewerDb?.name }}
            </h3>
            <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span class="font-mono">{{ store.viewerDb?.host }}:{{ store.viewerDb?.port }}</span>
              <span>•</span>
              <span>{{ tables.length }} tables</span>
            </div>
          </div>
        </div>
        <button 
          @click="emit('close')" 
          class="p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200"
        >
          <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
          @select="handleTableSelect"
        />

        <!-- Main Content -->
        <div class="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-900 relative">
          <!-- Error State -->
          <div v-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-white dark:bg-zinc-900">
            <div class="mb-6 p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl max-w-md">
              <div class="w-12 h-12 bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 class="text-lg font-bold text-red-900 dark:text-red-200 mb-2">Connection Failed</h3>
              <p class="text-sm text-red-700 dark:text-red-300 mb-4">{{ error }}</p>
              <button 
                @click="loadTables" 
                class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-red-500/20"
              >
                Retry Connection
              </button>
            </div>
          </div>
          
          <!-- Success State -->
          <div v-else-if="selectedTable" class="flex flex-col h-full">
            <!-- Tabs -->
            <div class="border-b border-gray-200 dark:border-zinc-800 px-6 bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-sm">
              <nav class="-mb-px flex space-x-6">
                <button
                  v-for="tab in ['data', 'relations', 'schema']"
                  :key="tab"
                  @click="activeTab = tab"
                  :class="[
                    activeTab === tab
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-zinc-700',
                    'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors duration-200 capitalize'
                  ]"
                >
                  {{ t(`viewer.${tab}`) }}
                </button>
              </nav>
            </div>

            <!-- Content -->
            <div class="flex-1 overflow-hidden p-6 bg-gray-50/30 dark:bg-black/20">
              <div class="h-full bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm overflow-hidden">
                <TableData
                  v-if="activeTab === 'data'"
                  :db="store.viewerDb"
                  :table="selectedTable"
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
          <div v-else class="flex-1 flex flex-col items-center justify-center text-gray-400 dark:text-gray-600">
            <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-4">
              <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M3 14h18m-9-4v8m-7-6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
              </svg>
            </div>
            <p class="text-lg font-medium">{{ t('viewer.selectPrompt') }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

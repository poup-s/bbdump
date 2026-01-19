<script setup lang="ts">
import { ref, onMounted, markRaw } from 'vue';
import { VueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { ipcRenderer } from '../../electron';
import { Database } from '../../types';
import { useI18n } from '../../composables/useI18n';
import TableNode from './TableNode.vue';

// Import Vue Flow styles
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';

const props = defineProps<{
  db: Database | null;
}>();

const { t } = useI18n();
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const nodeTypes = {
  table: markRaw(TableNode),
};

const loadFullSchema = async () => {
  if (!props.db) return;
  
  loading.value = true;
  error.value = null;
  
  try {
    const dbConfig = {
      name: props.db.name,
      host: props.db.host,
      port: props.db.port,
      user: props.db.user,
      password: props.db.password,
      connectionString: props.db.connectionString
    };
    
    const schema = await ipcRenderer.invoke('get-db-full-schema', { db: dbConfig });
    
    // Create nodes
    nodes.value = schema.tables.map((table: any, index: number) => {
      const tableColumns = schema.columns.filter((c: any) => c.table_name === table.name);
      const tablePks = schema.primaryKeys
        .filter((pk: any) => pk.table_name === table.name)
        .map((pk: any) => pk.column_name);

      return {
        id: table.name,
        type: 'table',
        position: { x: (index % 3) * 350, y: Math.floor(index / 3) * 500 },
        data: {
          label: table.name,
          columns: tableColumns,
          primaryKeys: tablePks
        }
      };
    });

    // Create edges
    edges.value = schema.foreignKeys.map((fk: any, index: number) => ({
      id: `e-${fk.constraint_name}-${index}`,
      source: fk.target_table,
      target: fk.source_table,
      sourceHandle: `source-${fk.target_column}`,
      targetHandle: `target-${fk.source_column}`,
      animated: true,
      style: { stroke: '#3b82f6', strokeWidth: 2 },
      label: fk.constraint_name,
      labelStyle: { fill: '#94a3b8', fontSize: 10, fontWeight: 500 }
    }));

  } catch (err: any) {
    console.error('Error loading full schema:', err);
    error.value = err.message || 'Failed to load schema';
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  loadFullSchema();
});
</script>

<template>
  <div class="h-full w-full relative bg-gray-50 dark:bg-zinc-950">
    <div v-if="loading" class="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
      <div class="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
      <p class="text-gray-500 font-medium">{{ t('viewer.schemaLoading') }}</p>
    </div>

    <div v-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center">
      <div class="p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl max-w-md">
        <h3 class="text-lg font-bold text-red-700 dark:text-red-400 mb-2">{{ t('viewer.loadError') }}</h3>
        <p class="text-sm text-red-600 dark:text-red-300 mb-4">{{ error }}</p>
        <button @click="loadFullSchema" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors">
          {{ t('viewer.retry') }}
        </button>
      </div>
    </div>

    <VueFlow
      v-if="!loading && !error"
      v-model:nodes="nodes"
      v-model:edges="edges"
      :node-types="(nodeTypes as any)"
      :default-viewport="{ x: 50, y: 50, zoom: 0.7 }"
      :min-zoom="0.1"
      :max-zoom="4"
      fit-view-on-init
      class="h-full w-full"
    >
      <Background pattern-color="#aaa" :gap="20" />
      <Controls />
      
      <template #panel-top-right>
        <div class="m-4 flex gap-2">
          <button 
            @click="loadFullSchema" 
            class="p-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 rounded-lg shadow-lg hover:bg-gray-50 dark:hover:bg-zinc-700 transition-all"
            :title="t('viewer.refresh')"
          >
            <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </template>
    </VueFlow>
  </div>
</template>

<style>
/* Reset some Vue Flow defaults to match our theme */
.vue-flow__node-table {
  padding: 0;
  border: none;
  background: transparent;
}

.vue-flow__edge-path {
  stroke-dasharray: 5;
  stroke-dashoffset: 0;
  animation: dash 1s linear infinite;
}

@keyframes dash {
  from {
    stroke-dashoffset: 10;
  }
  to {
    stroke-dashoffset: 0;
  }
}

.vue-flow__controls {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  padding: 8px !important;
  background: white !important;
  border: 1px solid #e5e7eb !important;
  border-radius: 12px !important;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1) !important;
}

.dark .vue-flow__controls {
  background: #18181b !important;
  border-color: rgba(255, 255, 255, 0.1) !important;
}

.vue-flow__controls-button {
  border: none !important;
  background: transparent !important;
  color: #6b7280 !important;
  border-radius: 6px !important;
}

.vue-flow__controls-button:hover {
  background: #f3f4f6 !important;
  color: #111827 !important;
}

.dark .vue-flow__controls-button:hover {
  background: rgba(255, 255, 255, 0.05) !important;
  color: white !important;
}
</style>

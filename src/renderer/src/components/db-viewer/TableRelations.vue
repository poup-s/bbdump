<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import { Database, TableRelation } from '../../types';

const props = defineProps<{
  db: Database | null;
  table: string | null;
}>();

const { t } = useI18n();

const relations = ref<TableRelation[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const loadRelations = async () => {
  if (!props.db || !props.table) return;
  
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
    
    const result = await ipcRenderer.invoke('get-table-relations', {
      db: dbConfig,
      table: props.table
    });
    relations.value = result.relations;
  } catch (err: any) {
    console.error('Error loading relations:', err);
    error.value = err.message;
  } finally {
    loading.value = false;
  }
};

watch(() => props.table, () => {
  loadRelations();
});

onMounted(() => {
  loadRelations();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="mb-4 flex justify-between items-center">
      <h3 class="text-lg font-medium text-gray-900">{{ t('viewer.relationsTitle') }}</h3>
      <button
        @click="loadRelations"
        class="p-2 text-gray-500 hover:text-black rounded hover:bg-gray-100"
        :title="t('viewer.refresh')"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-auto border border-gray-200 rounded-lg relative">
      <div v-if="loading" class="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-black"></div>
      </div>

      <div v-if="error" class="p-8 text-center text-red-600">
        {{ error }}
      </div>

      <table v-else class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{{ t('viewer.constraintName') }}</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{{ t('viewer.type') }}</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{{ t('viewer.column') }}</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{{ t('viewer.refTable') }}</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{{ t('viewer.refColumn') }}</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-for="rel in relations" :key="rel.constraint_name" class="hover:bg-gray-50">
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{{ rel.constraint_name }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{{ rel.constraint_type }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">{{ rel.column_name }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">{{ rel.foreign_table_name || '-' }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">{{ rel.foreign_column_name || '-' }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="!loading && !error && relations.length === 0" class="p-8 text-center text-gray-400">
        {{ t('viewer.noRelations') }}
      </div>
    </div>
  </div>
</template>

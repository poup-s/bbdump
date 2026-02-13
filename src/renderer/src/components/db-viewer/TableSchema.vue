<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { ipcRenderer } from '../../electron';
import { Database, buildDbConfig } from '../../types';

const props = defineProps<{
  db: Database | null;
  table: string | null;
}>();

const { t } = useI18n();

const schema = ref<any[]>([]);
const incomingRefs = ref<any[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const formatType = (col: any) => {
  let type = col.data_type;
  if (col.character_maximum_length) {
    type += `(${col.character_maximum_length})`;
  } else if (col.numeric_precision) {
    type += `(${col.numeric_precision}${col.numeric_scale ? `,${col.numeric_scale}` : ''})`;
  }
  return type;
};

const loadSchema = async () => {
  if (!props.db || !props.table) return;

  loading.value = true;
  error.value = null;

  try {
    const dbConfig = buildDbConfig(props.db);

    const [schemaResult, fullSchema] = await Promise.all([
      ipcRenderer.invoke('get-table-schema', { db: dbConfig, table: props.table }),
      ipcRenderer.invoke('get-db-full-schema', { db: dbConfig })
    ]);

    schema.value = schemaResult.columns;

    // Find incoming FKs (other tables referencing this table)
    incomingRefs.value = fullSchema.foreignKeys
      .filter((fk: any) => fk.target_table === props.table)
      .map((fk: any) => ({
        sourceTable: fk.source_table,
        sourceColumn: fk.source_column,
        targetColumn: fk.target_column,
        constraintName: fk.constraint_name
      }));

  } catch (err: any) {
    console.error('Error loading schema:', err);
    error.value = err.message;
  } finally {
    loading.value = false;
  }
};

watch(() => props.table, () => {
  loadSchema();
});

onMounted(() => {
  loadSchema();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-auto">
    <!-- Loading -->
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <div class="flex flex-col items-center">
        <div class="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('viewer.schemaLoading') }}</p>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center p-8">
      <div class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl max-w-md text-center">
        <p class="text-sm text-red-600 dark:text-red-400 mb-3">{{ error }}</p>
        <button @click="loadSchema" class="px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs transition-colors">
          {{ t('viewer.retry') }}
        </button>
      </div>
    </div>

    <div v-else class="p-3 space-y-4">
      <!-- Columns Table -->
      <div class="border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
        <table class="w-full">
          <thead>
            <tr class="bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/10">
              <th class="px-3 py-1.5 text-left text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t('viewer.columnName') }}</th>
              <th class="px-3 py-1.5 text-left text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t('viewer.dataType') }}</th>
              <th class="px-3 py-1.5 text-center text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t('viewer.nullable') }}</th>
              <th class="px-3 py-1.5 text-left text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t('viewer.default') }}</th>
              <th class="px-3 py-1.5 text-left text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t('viewer.relations') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100 dark:divide-white/5">
            <tr
              v-for="col in schema"
              :key="col.column_name"
              class="hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors"
            >
              <!-- Column Name with PK/FK icon -->
              <td class="px-3 py-1.5">
                <div class="flex items-center gap-1.5">
                  <span v-if="col.is_primary" class="text-amber-500 shrink-0" title="Primary Key">
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd" />
                    </svg>
                  </span>
                  <span v-else-if="col.is_foreign" class="text-blue-500 shrink-0" title="Foreign Key">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </span>
                  <span v-else class="w-3.5 shrink-0"></span>
                  <span class="text-xs font-medium text-gray-900 dark:text-white font-mono">{{ col.column_name }}</span>
                </div>
              </td>
              <!-- Data Type -->
              <td class="px-3 py-1.5">
                <span class="text-xs font-mono text-gray-500 dark:text-gray-400">{{ formatType(col) }}</span>
              </td>
              <!-- Nullable -->
              <td class="px-3 py-1.5 text-center">
                <span
                  :class="[
                    'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                    col.is_nullable === 'YES'
                      ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400'
                  ]"
                >
                  {{ col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL' }}
                </span>
              </td>
              <!-- Default -->
              <td class="px-3 py-1.5">
                <span class="text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-[200px] inline-block">{{ col.column_default || '—' }}</span>
              </td>
              <!-- Relations -->
              <td class="px-3 py-1.5">
                <span
                  v-if="col.foreign_key"
                  class="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                  {{ col.foreign_key.table }}.{{ col.foreign_key.column }}
                </span>
                <span v-else class="text-xs text-gray-300 dark:text-gray-600">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Incoming References -->
      <div v-if="incomingRefs.length > 0" class="border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
        <div class="px-3 py-2 bg-gray-50 dark:bg-white/5 border-b border-gray-200 dark:border-white/10">
          <h4 class="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            {{ t('viewer.referencedBy') }}
          </h4>
        </div>
        <div class="divide-y divide-gray-100 dark:divide-white/5">
          <div
            v-for="incoming in incomingRefs"
            :key="incoming.constraintName"
            class="px-3 py-2 flex items-center gap-2 hover:bg-gray-50/50 dark:hover:bg-white/[0.02] transition-colors"
          >
            <span class="inline-flex items-center gap-1 text-xs font-mono font-medium text-purple-600 dark:text-purple-400">
              {{ incoming.sourceTable }}.{{ incoming.sourceColumn }}
            </span>
            <svg class="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
            <span class="text-xs font-mono text-gray-600 dark:text-gray-300">{{ incoming.targetColumn }}</span>
            <span class="text-[10px] text-gray-400 dark:text-gray-500 ml-auto font-mono">{{ incoming.constraintName }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

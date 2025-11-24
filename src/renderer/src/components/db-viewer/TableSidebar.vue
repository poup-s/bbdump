<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  tables: any[];
  selectedTable: string | null;
}>();

const emit = defineEmits(['select']);
const { t } = useI18n();

const filter = ref('');

const filteredTables = computed(() => {
  if (!filter.value) return props.tables;
  const lower = filter.value.toLowerCase();
  return props.tables.filter(t => t.name.toLowerCase().includes(lower));
});
</script>

<template>
  <div class="w-72 border-r border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl flex flex-col">
    <div class="p-4 border-b border-gray-200 dark:border-zinc-800">
      <div class="relative">
        <input
          v-model="filter"
          type="text"
          class="w-full pl-9 pr-3 py-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 text-gray-900 dark:text-white"
          :placeholder="t('viewer.searchTables')"
        />
        <svg class="w-4 h-4 text-gray-400 absolute left-3 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-2">
      <ul class="space-y-1">
        <li
          v-for="table in filteredTables"
          :key="table.name"
        >
          <button
            @click="emit('select', table.name)"
            :class="[
              'w-full px-3 py-2.5 text-left text-sm flex justify-between items-center rounded-lg transition-all duration-200 group',
              selectedTable === table.name
                ? 'bg-blue-500 text-white shadow-md shadow-blue-500/20'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-800'
            ]"
          >
            <div class="flex items-center gap-2 truncate">
              <svg class="w-4 h-4 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7-6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
              </svg>
              <span class="truncate font-medium">{{ table.name }}</span>
            </div>
            <span 
              :class="[
                'text-xs px-1.5 py-0.5 rounded-md transition-colors',
                selectedTable === table.name
                  ? 'bg-blue-400/30 text-white'
                  : 'bg-gray-200 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 group-hover:bg-gray-300 dark:group-hover:bg-zinc-600'
              ]"
            >
              {{ table.row_count || 0 }}
            </span>
          </button>
        </li>
      </ul>
      <div v-if="filteredTables.length === 0" class="p-8 text-center">
        <div class="w-12 h-12 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-3">
          <svg class="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('viewer.noTablesFound') }}</p>
      </div>
    </div>
  </div>
</template>

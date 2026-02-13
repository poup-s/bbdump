<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  tables: any[];
  selectedTable: string | null;
  loading?: boolean;
  viewMode: string;
  isLocalBbdump?: boolean;
}>();

const emit = defineEmits(['select', 'visualize', 'performance', 'query']);
const { t } = useI18n();

const filter = ref('');

const filteredTables = computed(() => {
  if (!filter.value) return props.tables;
  const lower = filter.value.toLowerCase();
  return props.tables.filter(t => t.name.toLowerCase().includes(lower));
});
</script>

<template>
  <div class="w-52 border-r border-gray-200 dark:border-white/10 bg-white/50 dark:bg-surface/30 backdrop-blur-xl flex flex-col">
    <div class="p-2 border-b border-gray-200 dark:border-white/10 space-y-1">
      <!-- Visualizer Link -->
      <button
        @click="emit('visualize')"
        :class="[
          'w-full px-2 py-1 text-left text-xs flex items-center gap-1.5 rounded-md transition-all duration-200 group',
          viewMode === 'visualizer'
            ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/20'
            : 'text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200'
        ]"
      >
        <svg
          class="w-3.5 h-3.5 shrink-0"
          :class="viewMode === 'visualizer' ? 'text-white' : 'text-blue-500'"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
        </svg>
        <span class="font-medium">{{ t('viewer.visualizer') }}</span>
      </button>

      <!-- Performance Link -->
      <button
        v-if="isLocalBbdump"
        @click="emit('performance')"
        :class="[
          'w-full px-2 py-1 text-left text-xs flex items-center gap-1.5 rounded-md transition-all duration-200 group',
          viewMode === 'performance'
            ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/20'
            : 'text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200'
        ]"
      >
        <svg
          class="w-3.5 h-3.5 shrink-0"
          :class="viewMode === 'performance' ? 'text-white' : 'text-amber-500'"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span class="font-medium">{{ t('viewer.performance') }}</span>
      </button>

      <!-- SQL Query Builder Link -->
      <button
        @click="emit('query')"
        :class="[
          'w-full px-2 py-1 text-left text-xs flex items-center gap-1.5 rounded-md transition-all duration-200 group',
          viewMode === 'query'
            ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/20'
            : 'text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200'
        ]"
      >
        <svg
          class="w-3.5 h-3.5 shrink-0"
          :class="viewMode === 'query' ? 'text-white' : 'text-violet-500'"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span class="font-medium">{{ t('viewer.sqlBuilder') }}</span>
      </button>

      <div class="relative">
        <input
          v-model="filter"
          type="text"
          class="w-full pl-7 pr-2 py-1 bg-white dark:bg-surface/50 border border-gray-200 dark:border-white/10 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 text-gray-900 dark:text-white"
          :placeholder="t('viewer.searchTables')"
        />
        <svg class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 absolute left-2 top-[5px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto p-1">
      <!-- Loading State -->
      <div v-if="loading" class="flex flex-col items-center justify-center py-12">
        <div class="relative w-10 h-10 mb-3">
          <div class="absolute inset-0 border-3 border-blue-500/30 rounded-full"></div>
          <div class="absolute inset-0 border-3 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
        <p class="text-xs text-gray-500">{{ t('viewer.loadingTables') }}</p>
      </div>

      <!-- Tables List -->
      <ul v-else class="space-y-px">
        <li
          v-for="table in filteredTables"
          :key="table.name"
        >
          <button
            @click="emit('select', table.name)"
            :class="[
              'w-full px-2 py-1.5 text-left text-xs flex justify-between items-center rounded-md transition-all duration-200 group',
              selectedTable === table.name
                ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/20'
                : 'text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200'
            ]"
          >
            <span class="truncate font-medium">{{ table.name }}</span>
            <span
              :class="[
                'text-[10px] tabular-nums px-1 py-px rounded transition-colors shrink-0 ml-1',
                selectedTable === table.name
                  ? 'bg-blue-400/30 text-white'
                  : 'bg-black/5 dark:bg-white/5 text-gray-400'
              ]"
            >
              {{ Math.max(0, table.row_count || 0) }}
            </span>
          </button>
        </li>
      </ul>
      <div v-if="filteredTables.length === 0" class="p-4 text-center">
        <p class="text-xs text-gray-500">{{ t('viewer.noTablesFound') }}</p>
      </div>
    </div>
  </div>
</template>

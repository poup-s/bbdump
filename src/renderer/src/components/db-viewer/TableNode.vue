<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';

defineProps<{
  data: {
    label: string;
    columns: any[];
    primaryKeys: string[];
  };
}>();
</script>

<template>
  <div class="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl min-w-[200px] overflow-hidden">
    <!-- Header -->
    <div class="bg-gray-50 dark:bg-zinc-800/50 px-4 py-2.5 border-b border-gray-200 dark:border-white/10 flex items-center gap-2">
      <svg class="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7-6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
      </svg>
      <span class="font-bold text-gray-900 dark:text-white truncate">{{ data.label }}</span>
    </div>

    <!-- Columns -->
    <div class="py-2">
      <div 
        v-for="col in data.columns" 
        :key="col.column_name"
        class="px-4 py-1.5 flex items-center justify-between gap-4 group hover:bg-gray-50 dark:hover:bg-white/5 relative"
      >
        <!-- Handles for relations -->
        <Handle 
          type="target" 
          :position="Position.Left" 
          :id="`target-${col.column_name}`"
          class="!w-2 !h-2 !bg-blue-400 !border-none -left-1"
        />
        <Handle 
          type="source" 
          :position="Position.Right" 
          :id="`source-${col.column_name}`"
          class="!w-2 !h-2 !bg-blue-400 !border-none -right-1"
        />

        <div class="flex items-center gap-2 truncate">
          <span v-if="data.primaryKeys.includes(col.column_name)" class="text-yellow-500 text-[10px]">🔑</span>
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{{ col.column_name }}</span>
        </div>
        <span class="text-[10px] font-mono text-gray-400 dark:text-gray-500 uppercase">{{ col.data_type }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vue-flow__handle {
  opacity: 0;
  transition: opacity 0.2s;
}

.group:hover .vue-flow__handle {
  opacity: 1;
}
</style>

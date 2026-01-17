<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from '../composables/useI18n';
import { formatFileSize } from '../utils';
import { useDashboardData } from '../composables/useDashboardData';
import Dashboard3DScene from './Dashboard3DScene.vue';

const { t } = useI18n();

const { 
  stats, 
  isLoading, 
  loadDashboardData, 
  totalDatabases, 
  localDatabases, 
  externalDatabases 
} = useDashboardData();

onMounted(() => {
  loadDashboardData();
});
</script>

<template>
  <div class="h-full flex flex-col gap-6">
    <!-- Header -->
    <div class="flex justify-between items-center">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">{{ t('dashboard.title') }}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('dashboard.subtitle') }}</p>
      </div>
      <button 
        @click="loadDashboardData" 
        class="p-2.5 rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        :class="{ 'animate-spin': isLoading }"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Stats Grid -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- System Status -->
      <div class="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-5 border border-emerald-100 dark:border-emerald-900/50">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-emerald-500 flex items-center justify-center">
            <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p class="text-xs text-emerald-600 dark:text-emerald-400 font-medium">{{ t('dashboard.systemStatus') }}</p>
            <p class="text-lg font-semibold text-emerald-700 dark:text-emerald-300">{{ t('dashboard.healthy') }}</p>
          </div>
        </div>
      </div>

      <!-- Databases -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-5 border border-gray-200 dark:border-zinc-800">
        <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ t('dashboard.totalDatabases') }}</p>
        <p class="text-2xl font-semibold text-gray-900 dark:text-white mt-1">{{ totalDatabases }}</p>
        <p class="text-xs text-gray-400 mt-1">{{ localDatabases }} {{ t('dashboard.local') }} · {{ externalDatabases }} {{ t('dashboard.external') }}</p>
      </div>

      <!-- Backups -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-5 border border-gray-200 dark:border-zinc-800">
        <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ t('dashboard.totalBackups') }}</p>
        <p class="text-2xl font-semibold text-gray-900 dark:text-white mt-1">{{ stats.total }}</p>
        <p class="text-xs text-gray-400 mt-1">{{ t('dashboard.storedLocally') }}</p>
      </div>

      <!-- Storage -->
      <div class="bg-white dark:bg-zinc-900 rounded-xl p-5 border border-gray-200 dark:border-zinc-800">
        <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">{{ t('dashboard.storageUsed') }}</p>
        <p class="text-2xl font-semibold text-gray-900 dark:text-white mt-1">{{ formatFileSize(stats.totalSize) }}</p>
        <p class="text-xs text-gray-400 mt-1">{{ t('dashboard.totalBackupSize') }}</p>
      </div>
    </div>

    <!-- 3D Animation (Full height) -->
    <div class="flex-1 min-h-0">
      <Dashboard3DScene />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { formatDate } from '../utils';

const { t } = useI18n();

const loadScheduledTasks = async () => {
  try {
    const tasks = await ipcRenderer.invoke('get-scheduled-tasks');
    store.scheduledTasks = tasks;
  } catch (error: any) {
    console.error('Error loading scheduled tasks:', error);
  }
};

const getDbLastBackup = (dbName: string) => {
  const db = store.databases.find(d => d.name === dbName);
  return db ? db.lastBackup : null;
};

const getDbStatus = (dbName: string) => {
  const db = store.databases.find(d => d.name === dbName);
  return db && db.enabled !== false;
};

onMounted(() => {
  loadScheduledTasks();
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-xl font-semibold text-gray-900">{{ t('scheduled.title') }}</h2>
      <button
        @click="loadScheduledTasks"
        class="px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
      >
        {{ t('scheduled.refresh') }}
      </button>
    </div>

    <div v-if="store.scheduledTasks.length === 0" class="text-center py-20 border border-gray-200">
      <p class="text-gray-400 text-sm tracking-wide">{{ t('scheduled.noData') }}</p>
    </div>

    <div v-else class="border border-gray-200">
      <table class="min-w-full">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              {{ t('scheduled.database') }}
            </th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              {{ t('scheduled.schedule') }}
            </th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              {{ t('scheduled.lastBackup') }}
            </th>
            <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              {{ t('scheduled.status') }}
            </th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr
            v-for="task in store.scheduledTasks"
            :key="task.database"
            class="hover:bg-gray-50"
          >
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="text-sm font-medium text-gray-900">{{ task.database }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="text-sm text-gray-500 font-mono">{{ task.schedule }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
              {{ formatDate(getDbLastBackup(task.database) || '') || t('scheduled.never') }}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-center">
              <span
                :class="[
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                  getDbStatus(task.database) ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                ]"
              >
                {{ getDbStatus(task.database) ? t('scheduled.statusActive') : t('scheduled.statusPaused') }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

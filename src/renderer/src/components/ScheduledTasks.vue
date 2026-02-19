<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { formatDate } from '../utils';

const { t } = useI18n();

const showAddMenu = ref(false);

const loadScheduledTasks = async () => {
  try {
    const tasks = await ipcRenderer.invoke('get-scheduled-tasks');
    store.scheduledTasks = tasks;
  } catch (error: any) {
    console.error('Error loading scheduled tasks:', error);
  }
};

const getDbLastBackup = (databaseId: string) => {
  const db = store.databases.find(d => d.id === databaseId);
  return db ? db.lastBackup : null;
};

const getDbStatus = (databaseId: string) => {
  const db = store.databases.find(d => d.id === databaseId);
  return db && db.enabled !== false;
};

const getDbDisplayName = (databaseId: string) => {
  const db = store.databases.find(d => d.id === databaseId);
  return db ? (db.displayName || db.name) : databaseId;
};

const scheduledDbIds = computed(() => new Set(store.scheduledTasks.map(t => t.databaseId)));

const unscheduledDatabases = computed(() =>
  store.databases.filter(db => !scheduledDbIds.value.has(db.id))
);

const configureSchedule = (dbId: string) => {
  const db = store.databases.find(d => d.id === dbId);
  if (db) {
    store.editingDatabase = JSON.parse(JSON.stringify(db));
    store.modalTargetSection = 'schedule';
    store.showDatabaseModal = true;
  }
  showAddMenu.value = false;
};

const editSchedule = (databaseId: string) => {
  const db = store.databases.find(d => d.id === databaseId);
  if (db) {
    store.editingDatabase = JSON.parse(JSON.stringify(db));
    store.modalTargetSection = 'schedule';
    store.showDatabaseModal = true;
  }
};

const closeAddMenu = () => {
  showAddMenu.value = false;
};

// Reload when DatabaseModal closes (schedule may have been added/changed)
watch(() => store.showDatabaseModal, (newVal, oldVal) => {
  if (!newVal && oldVal) {
    loadScheduledTasks();
  }
});

onMounted(() => {
  loadScheduledTasks();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="mb-4 shrink-0">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold tracking-tight">{{ t('scheduled.title') }}</h2>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('scheduled.description') }}</p>
        </div>
        <div class="flex items-center gap-1.5">
          <!-- Refresh -->
          <button
            @click="loadScheduledTasks"
            class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
            :title="t('scheduled.refresh')"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          <!-- Add schedule -->
          <div class="relative">
            <button
              @click="showAddMenu = !showAddMenu"
              :disabled="unscheduledDatabases.length === 0"
              class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              :title="t('scheduled.addSchedule')"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>

            <!-- Dropdown menu -->
            <Transition
              enter-active-class="transition duration-100 ease-out"
              enter-from-class="opacity-0 scale-95"
              enter-to-class="opacity-100 scale-100"
              leave-active-class="transition duration-75 ease-in"
              leave-from-class="opacity-100 scale-100"
              leave-to-class="opacity-0 scale-95"
            >
              <div
                v-if="showAddMenu"
                class="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-zinc-800 rounded-lg border border-gray-200 dark:border-zinc-700 shadow-lg z-30 py-1 max-h-64 overflow-y-auto"
              >
                <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  {{ t('scheduled.selectDatabase') }}
                </div>
                <button
                  v-for="db in unscheduledDatabases"
                  :key="db.id"
                  @click="configureSchedule(db.id)"
                  class="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors flex items-center gap-2"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="db.isLocalBbdump ? 'bg-blue-500' : 'bg-gray-400'"></span>
                  <span class="truncate">{{ db.displayName || db.name }}</span>
                </button>
              </div>
            </Transition>

            <!-- Click outside overlay -->
            <div v-if="showAddMenu" class="fixed inset-0 z-20" @click="closeAddMenu"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="store.scheduledTasks.length === 0" class="flex-1 flex flex-col items-center justify-center text-center">
      <div class="w-16 h-16 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-3">
        <svg class="w-8 h-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <p class="text-sm font-medium text-gray-500 dark:text-gray-400">{{ t('scheduled.noData') }}</p>
      <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">{{ t('scheduled.noDataDesc') }}</p>
      <button
        v-if="unscheduledDatabases.length > 0"
        @click="showAddMenu = true"
        class="mt-4 px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors"
      >
        {{ t('scheduled.addSchedule') }}
      </button>
    </div>

    <!-- Tasks table -->
    <div v-else class="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden">
      <table class="min-w-full">
        <thead>
          <tr class="border-b border-gray-200 dark:border-zinc-800">
            <th class="px-4 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              {{ t('scheduled.database') }}
            </th>
            <th class="px-4 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              {{ t('scheduled.schedule') }}
            </th>
            <th class="px-4 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              {{ t('scheduled.lastBackup') }}
            </th>
            <th class="px-4 py-2.5 text-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              {{ t('scheduled.status') }}
            </th>
            <th class="px-4 py-2.5 w-10"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-zinc-800/50">
          <tr
            v-for="task in store.scheduledTasks"
            :key="task.databaseId"
            class="hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors group"
          >
            <td class="px-4 py-2.5">
              <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ getDbDisplayName(task.databaseId) }}</span>
            </td>
            <td class="px-4 py-2.5">
              <code class="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{{ task.schedule }}</code>
            </td>
            <td class="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
              {{ formatDate(getDbLastBackup(task.databaseId) || '') || t('scheduled.never') }}
            </td>
            <td class="px-4 py-2.5 text-center">
              <span
                :class="[
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium',
                  getDbStatus(task.databaseId)
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                ]"
              >
                <span class="w-1.5 h-1.5 rounded-full" :class="getDbStatus(task.databaseId) ? 'bg-emerald-500' : 'bg-amber-500'"></span>
                {{ getDbStatus(task.databaseId) ? t('scheduled.active') : t('scheduled.paused') }}
              </span>
            </td>
            <td class="px-4 py-2.5">
              <button
                @click="editSchedule(task.databaseId)"
                class="p-1 text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-all rounded"
                :title="t('scheduled.editSchedule')"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

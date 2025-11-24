<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const isLoading = ref(false);
const filterLevel = ref('all');

const filteredLogs = computed(() => {
  if (filterLevel.value === 'all') return store.logs;
  return store.logs.filter(log => log.level === filterLevel.value);
});

const loadLogs = async () => {
  isLoading.value = true;
  try {
    const logs = await ipcRenderer.invoke('get-logs');
    store.logs = logs;
  } catch (error: any) {
    addToast('Error loading logs: ' + error.message, 'error');
  } finally {
    isLoading.value = false;
  }
};

const clearLogs = () => {
  showConfirm({
    title: t('modal.deleteTitle'),
    message: t('modal.deleteConfirm', { name: 'all logs' }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('clear-logs');
        store.logs = [];
        addToast(t('toast.logsCleared'), 'success');
      } catch (error: any) {
        addToast('Error clearing logs: ' + error.message, 'error');
      }
    }
  });
};

onMounted(() => {
  loadLogs();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex justify-between items-center mb-8">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">{{ t('nav.logs') }}</h2>
        <p class="text-gray-500 mt-1">{{ filteredLogs.length }} events recorded</p>
      </div>
      
      <div class="flex gap-4">
        <select
          v-model="filterLevel"
          class="bg-surface border border-border rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-all"
        >
          <option value="all">{{ t('common.allLevels') }}</option>
          <option value="info">Info</option>
          <option value="error">Error</option>
          <option value="warn">Warning</option>
        </select>
        
        <button
          @click="loadLogs"
          class="p-2 bg-surface rounded-xl hover:bg-border transition-colors"
          :title="t('common.refresh')"
        >
          <svg class="w-6 h-6" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          @click="clearLogs"
          class="p-2 bg-surface rounded-xl hover:bg-red-500/10 text-red-500 transition-colors"
          :title="t('logs.clear')"
        >
          <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>

    <div class="flex-1 bg-[#1e1e1e] rounded-2xl border border-border overflow-hidden shadow-inner font-mono text-sm p-4 overflow-y-auto">
      <div v-if="filteredLogs.length === 0" class="h-full flex items-center justify-center text-gray-500">
        {{ t('logs.noLogs') }}
      </div>
      <div v-else class="space-y-1">
        <div
          v-for="(log, index) in filteredLogs"
          :key="index"
          class="flex gap-4 hover:bg-white/5 p-1 rounded transition-colors"
        >
          <span class="text-gray-500 shrink-0 select-none">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
          <span
            class="font-bold shrink-0 w-16 uppercase text-xs tracking-wider flex items-center"
            :class="{
              'text-blue-400': log.level === 'info',
              'text-red-400': log.level === 'error',
              'text-yellow-400': log.level === 'warn'
            }"
          >
            {{ log.level }}
          </span>
          <span class="text-gray-300 break-all">{{ log.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

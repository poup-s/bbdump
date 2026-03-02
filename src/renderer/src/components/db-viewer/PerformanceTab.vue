<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getErrorMessage } from '../../utils';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { ipcRenderer } from '../../electron';
import { useConfirm } from '../../composables/useConfirm';

const props = defineProps<{
  db: any;
}>();

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const stats = ref<any[]>([]);
const isLoading = ref(false);
const extensionActive = ref(true);
const isNotPreloaded = ref(false);
const isConfigPresent = ref(false);
const dataDirectory = ref('');
const selectedQuery = ref<any | null>(null);

const loadStats = async () => {
  if (!props.db) return;
  
  isLoading.value = true;
  try {
    const result = await ipcRenderer.invoke('get-postgres-performance-stats', props.db.name, props.db.port);
    if (result.success) {
      stats.value = result.stats || [];
      extensionActive.value = result.extensionActive !== false;
      isNotPreloaded.value = result.isNotPreloaded === true;
      dataDirectory.value = result.dataDirectory || '';
      
      if (isNotPreloaded.value) {
        // Vérifier si c'est déjà dans la config mais pas encore pris en compte (ou absent)
        const configCheck = await ipcRenderer.invoke('check-postgres-config', 'pg_stat_statements');
        if (configCheck.success) {
          isConfigPresent.value = configCheck.isPresent;
        }
      }
    } else {
      addToast(result.error || 'Failed to load stats', 'error');
    }
  } catch (error) {
    addToast(getErrorMessage(error) || 'Error loading stats', 'error');
  } finally {
    isLoading.value = false;
  }
};

const resetStats = () => {
  showConfirm({
    title: t('viewer.resetStats'),
    message: t('viewer.resetStatsConfirm'),
    confirmText: t('common.confirm'),
    type: 'danger',
    onConfirm: async () => {
      try {
        const result = await ipcRenderer.invoke('reset-postgres-performance-stats', props.db.name, props.db.port);
        if (result.success) {
          addToast(t('viewer.statsResetSuccess'), 'success');
          loadStats();
        } else {
          addToast(result.error || t('viewer.statsResetError'), 'error');
        }
      } catch (error) {
        addToast(getErrorMessage(error) || t('viewer.statsResetError'), 'error');
      }
    }
  });
};

const formatNumber = (num: number) => {
  return new Intl.NumberFormat().format(num);
};

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
  addToast(t('viewer.queryCopied'), 'success');
};

const isRestarting = ref(false);
const restartServer = async () => {
  showConfirm({
    title: t('viewer.restartPostgres'),
    message: t('viewer.restartPostgresConfirm'),
    confirmText: t('common.confirm'),
    type: 'danger',
    onConfirm: async () => {
      isRestarting.value = true;
      try {
        const result = await ipcRenderer.invoke('restart-postgres');
        if (result.success) {
          addToast(t('viewer.restartSuccess'), 'success');
          // Attendre un peu que le serveur redémarre avant de recharger
          setTimeout(() => {
            loadStats();
            isRestarting.value = false;
          }, 2000);
        } else {
          addToast(result.error || t('viewer.restartError'), 'error');
          isRestarting.value = false;
        }
      } catch (error) {
        addToast(getErrorMessage(error) || t('viewer.restartError'), 'error');
        isRestarting.value = false;
      }
    }
  });
};

const isFixing = ref(false);
const fixConfig = async () => {
  isFixing.value = true;
  try {
    const result = await ipcRenderer.invoke('fix-postgres-config', 'pg_stat_statements');
    if (result.success) {
      addToast(t('viewer.fixConfigSuccess'), 'success');
      isConfigPresent.value = true;
    } else {
      addToast(result.error || t('viewer.fixConfigError'), 'error');
    }
  } catch (error) {
    addToast(getErrorMessage(error) || t('viewer.fixConfigError'), 'error');
  } finally {
    isFixing.value = false;
  }
};

onMounted(() => {
  loadStats();
});
</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-zinc-900 overflow-hidden">
    <!-- Header Controls -->
    <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex justify-between items-center bg-gray-50/50 dark:bg-zinc-900/50">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-wider">{{ t('viewer.slowQueries') }}</h3>
        <div v-if="extensionActive" class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-black border border-emerald-500/10 uppercase">
          Active
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button 
          @click="resetStats"
          v-if="extensionActive && stats.length > 0"
          class="h-9 px-4 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border border-rose-500/10"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {{ t('viewer.resetStats') }}
        </button>
        <button 
          @click="loadStats"
          :disabled="isLoading"
          class="h-9 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-600/20"
        >
          <svg v-if="isLoading" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {{ t('common.refresh') || 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Main Content -->
    <div class="flex-1 overflow-hidden relative">
      <!-- Loading Overlay -->
      <div v-if="isLoading && stats.length === 0" class="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm z-10">
        <div class="text-center">
          <div class="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p class="text-sm font-medium text-gray-500">{{ t('viewer.loadingStats') }}</p>
        </div>
      </div>

      <!-- Extension Not Active -->
      <div v-if="!extensionActive" class="h-full flex flex-col items-center justify-center p-12 text-center">
        <div class="w-20 h-20 rounded-3xl bg-amber-500/10 text-amber-500 flex items-center justify-center mb-6 border border-amber-500/10">
          <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <h3 class="text-xl font-black text-gray-900 dark:text-white mb-2">{{ t('viewer.extensionNotActive') }}</h3>
        <p class="text-sm text-gray-500 dark:text-zinc-400 max-w-md leading-relaxed mb-8">
          {{ t('viewer.enableExtensionNote') }}
        </p>
      </div>

      <!-- Extension Installed but Not Preloaded -->
      <div v-else-if="isNotPreloaded" class="h-full flex flex-col items-center justify-center p-12 text-center overflow-y-auto">
        <div class="w-20 h-20 rounded-3xl bg-rose-500/10 text-rose-500 flex items-center justify-center mb-6 border border-rose-500/10">
          <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 class="text-xl font-black text-gray-900 dark:text-white mb-2">{{ t('viewer.notPreloadedTitle') }}</h3>
        <p class="text-sm text-gray-500 dark:text-zinc-400 max-w-md leading-relaxed mb-8">
          {{ t('viewer.notPreloadedNote') }}
        </p>

        <div class="bg-gray-50 dark:bg-zinc-950/50 p-6 rounded-2xl border border-gray-100 dark:border-zinc-800 text-left max-w-lg w-full">
          <h4 class="text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest mb-4">{{ t('viewer.fixStepsTitle') }}</h4>
          <ul class="space-y-4">
            <li class="flex gap-4">
              <span class="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white text-[10px] font-black flex items-center justify-center">1</span>
              <div>
                <p class="text-xs text-gray-600 dark:text-zinc-300 leading-relaxed">
                  {{ t('viewer.fixStep1', { file: 'postgresql.conf' }) }}
                </p>
                <code class="text-[10px] text-blue-500 font-mono mt-1 block break-all opacity-80">{{ dataDirectory }}/postgresql.conf</code>
              </div>
            </li>
            <li class="flex gap-4">
              <span class="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white text-[10px] font-black flex items-center justify-center">2</span>
              <div class="flex-1">
                <p class="text-xs text-gray-600 dark:text-zinc-300 leading-relaxed mb-3">
                  {{ t('viewer.fixStep2', { key: 'shared_preload_libraries' }) }} & {{ t('viewer.fixStep3', { val: "'pg_stat_statements'", eg: "shared_preload_libraries = 'pg_stat_statements'" }) }}
                </p>
                <div v-if="!isConfigPresent" class="p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl">
                  <button 
                    @click="fixConfig"
                    :disabled="isFixing"
                    class="w-full h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <svg v-if="isFixing" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {{ isFixing ? t('viewer.fixingConfig') : t('viewer.fixConfigAction') }}
                  </button>
                </div>
                <div v-else class="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                  <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span class="text-[10px] font-bold text-emerald-600 dark:text-emerald-500 uppercase tracking-tight">Configuration OK</span>
                </div>
              </div>
            </li>
            <li class="flex gap-4">
              <span class="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white text-[10px] font-black flex items-center justify-center">3</span>
              <div class="flex-1 space-y-3">
                <p class="text-xs text-gray-600 dark:text-zinc-300 leading-relaxed uppercase font-black">
                  {{ t('viewer.fixStep4') }}
                </p>
                <button 
                  @click="restartServer"
                  :disabled="isRestarting"
                  class="w-full h-10 px-4 bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-rose-500/20"
                >
                  <svg v-if="isRestarting" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {{ isRestarting ? t('viewer.restarting') : t('viewer.restartPostgres') }}
                </button>
                <p class="text-[10px] text-gray-400 dark:text-zinc-500 italic mt-2">
                  {{ t('viewer.performanceNote') }}
                </p>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <!-- No Data -->
      <div v-else-if="extensionActive && stats.length === 0" class="h-full flex flex-col items-center justify-center p-12 text-center">
        <div class="w-20 h-20 rounded-3xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center mb-6 border border-emerald-500/10">
          <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h3 class="text-xl font-black text-gray-900 dark:text-white mb-2">{{ t('viewer.noStatsTitle') }}</h3>
        <p class="text-sm text-gray-500 dark:text-zinc-400 max-w-md leading-relaxed">
          {{ t('viewer.noStatsDesc') }}
        </p>
      </div>

      <!-- Stats Table -->
      <div v-else class="h-full overflow-y-auto custom-scrollbar p-6">
        <!-- Dashboard removed as requested -->

        <div class="space-y-4">
          <div class="flex items-center justify-between px-2">
            <h4 class="text-xs font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('viewer.slowQueries') }}</h4>
          </div>

          <div class="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 shadow-sm overflow-hidden flex flex-col">
            <div class="overflow-x-auto custom-scrollbar">
              <table class="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr class="bg-gray-50/50 dark:bg-zinc-800/50">
                    <th class="px-6 py-4 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('viewer.query') }}</th>
                    <th class="px-6 py-4 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest text-right whitespace-nowrap">{{ t('viewer.calls') }}</th>
                    <th class="px-6 py-4 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest text-right whitespace-nowrap">{{ t('viewer.meanTime') }}</th>
                    <th class="px-6 py-4 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest text-right whitespace-nowrap">{{ t('viewer.percentage') }}</th>
                    <th class="px-6 py-4 text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest text-right whitespace-nowrap">{{ t('common.actions') }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-50 dark:divide-zinc-800/50">
                <tr 
                  v-for="stat in stats" 
                  :key="stat.query" 
                  class="group hover:bg-blue-50/30 dark:hover:bg-blue-500/5 transition-colors cursor-pointer"
                  @click="selectedQuery = stat"
                >
                  <td class="px-6 py-4">
                    <div class="max-w-2xl">
                      <code class="text-[11px] font-mono text-gray-600 dark:text-zinc-300 break-words line-clamp-2 leading-relaxed bg-gray-50 dark:bg-zinc-950/40 px-2 py-1 rounded-md border border-gray-100 dark:border-zinc-800 group-hover:border-blue-500/20 transition-all">
                        {{ stat.query }}
                      </code>
                    </div>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <span class="text-xs font-black text-gray-900 dark:text-white tabular-nums">{{ formatNumber(stat.calls) }}</span>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <span class="text-xs font-bold text-gray-700 dark:text-zinc-300 tabular-nums">{{ stat.mean_time.toFixed(2) }}ms</span>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-3">
                      <div class="w-16 h-1.5 bg-gray-100 dark:bg-zinc-800 rounded-full overflow-hidden shrink-0">
                        <div 
                          class="h-full bg-blue-500 rounded-full" 
                          :style="{ width: `${Math.min(100, stat.percentage)}%` }"
                        ></div>
                      </div>
                      <span class="text-[10px] font-black text-blue-600 dark:text-blue-400 w-8 tabular-nums">{{ stat.percentage.toFixed(1) }}%</span>
                    </div>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <button 
                      class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[10px] font-black transition-all flex items-center gap-1.5 ml-auto shadow-sm"
                      @click.stop="selectedQuery = stat"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      {{ t('viewer.viewMore') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

    <!-- Query Detail Modal -->
    <div 
      v-if="selectedQuery" 
      class="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/40 backdrop-blur-md"
      @click.self="selectedQuery = null"
    >
      <div class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden border border-gray-200 dark:border-zinc-800 animate-in zoom-in-95 duration-200">
        <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex justify-between items-center bg-gray-50 dark:bg-zinc-900">
          <h3 class="text-sm font-black text-gray-900 dark:text-white uppercase tracking-widest">{{ t('viewer.queryDetails') }}</h3>
          <button @click="selectedQuery = null" class="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-xl transition-colors">
            <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-8 space-y-8">
          <!-- Stats Grid -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div class="bg-gray-50 dark:bg-zinc-950/50 p-4 rounded-2xl border border-gray-100 dark:border-zinc-800">
              <span class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest block mb-2">{{ t('viewer.impactTitle') }}</span>
              <div class="flex items-baseline gap-2">
                <p class="text-2xl font-black text-blue-600 dark:text-blue-400">{{ selectedQuery.percentage.toFixed(1) }}%</p>
              </div>
              <p class="text-[9px] text-gray-500 mt-2 leading-tight">{{ t('viewer.impactDesc', { percent: selectedQuery.percentage.toFixed(1) }) }}</p>
            </div>
            <div class="bg-gray-50 dark:bg-zinc-950/50 p-4 rounded-2xl border border-gray-100 dark:border-zinc-800">
              <span class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest block mb-2">{{ t('viewer.calls') }}</span>
              <p class="text-2xl font-black text-gray-900 dark:text-white">{{ formatNumber(selectedQuery.calls) }}</p>
              <p class="text-[9px] text-gray-500 mt-2 leading-tight">{{ t('viewer.callsDesc') }}</p>
            </div>
            <div class="bg-gray-50 dark:bg-zinc-950/50 p-4 rounded-2xl border border-gray-100 dark:border-zinc-800">
              <span class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest block mb-2">{{ t('viewer.meanTime') }}</span>
              <p class="text-2xl font-black text-gray-900 dark:text-white">{{ selectedQuery.mean_time.toFixed(2) }}ms</p>
            </div>
            <div class="bg-gray-50 dark:bg-zinc-950/50 p-4 rounded-2xl border border-gray-100 dark:border-zinc-800">
              <span class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest block mb-2">{{ t('viewer.rows') }}</span>
              <p class="text-2xl font-black text-gray-900 dark:text-white">{{ formatNumber(selectedQuery.rows) }}</p>
              <p class="text-[9px] text-gray-500 mt-2 leading-tight">{{ t('viewer.rowsDesc') }}</p>
            </div>
          </div>

          <!-- Query Text -->
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-black text-gray-400 dark:text-zinc-500 uppercase tracking-widest">{{ t('viewer.sqlQuery') }}</span>
              <button 
                @click="copyToClipboard(selectedQuery.query)"
                class="text-[10px] font-black text-blue-600 hover:text-blue-500 uppercase tracking-widest flex items-center gap-1.5"
              >
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                {{ t('viewer.copySql') }}
              </button>
            </div>
            <div class="bg-gray-50 dark:bg-zinc-950 p-6 rounded-2xl border border-gray-100 dark:border-zinc-800">
              <code class="text-xs font-mono text-gray-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed break-words">
                {{ selectedQuery.query }}
              </code>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.2);
  border-radius: 10px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.3);
}
</style>

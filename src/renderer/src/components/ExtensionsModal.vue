<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';

const { t, te } = useI18n();
const { addToast } = useToast();

const extensions = ref<any[]>([]);
const isLoading = ref(false);
const searchQuery = ref('');

const POPULAR_EXTENSIONS = [
  'pg_stat_statements',
  'uuid-ossp',
  'pgcrypto',
  'postgis',
  'pg_trgm',
  'citext',
  'hstore',
  'pg_buffercache',
  'pgstattuple',
  'plpgsql'
];

const filteredExtensions = computed(() => {
  let list = [...extensions.value];
  
  // Sort by popularity first
  list.sort((a, b) => {
    const aIndex = POPULAR_EXTENSIONS.indexOf(a.name);
    const bIndex = POPULAR_EXTENSIONS.indexOf(b.name);
    
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  if (!searchQuery.value) return list;
  
  const query = searchQuery.value.toLowerCase();
  return list.filter(ext => 
    ext.name.toLowerCase().includes(query) || 
    (ext.comment && ext.comment.toLowerCase().includes(query)) ||
    (te(`postgresConfig.extensionDescriptions.${ext.name}`) && t(`postgresConfig.extensionDescriptions.${ext.name}`).toLowerCase().includes(query))
  );
});

const loadExtensions = async () => {
  if (!store.extensionsModalDb) return;
  isLoading.value = true;
  try {
    extensions.value = await ipcRenderer.invoke(
      'get-postgres-extensions', 
      store.extensionsModalDb.name, 
      store.extensionsModalDb.port
    );
  } catch (error) {
    addToast(`Error loading extensions: ${getErrorMessage(error)}`, 'error');
  } finally {
    isLoading.value = false;
  }
};

const toggleExtension = async (extension: any) => {
  if (!store.extensionsModalDb) return;
  
  const action = extension.is_installed ? 'uninstall-postgres-extension' : 'install-postgres-extension';
  const toastMsg = extension.is_installed ? 'postgresConfig.extensionUninstalled' : 'postgresConfig.extensionInstalled';
  
  try {
    const result = await ipcRenderer.invoke(
      action, 
      store.extensionsModalDb.name, 
      extension.name, 
      store.extensionsModalDb.port
    );
    if (result.success) {
      addToast(t(toastMsg, { name: extension.name }), 'success');
      await loadExtensions();
    } else {
      addToast(result.error || t('postgresConfig.extensionError'), 'error');
    }
  } catch (error) {
    addToast(`Error managing extension: ${getErrorMessage(error)}`, 'error');
  }
};

const isEssentialExtension = (extName: string) => {
  const essentials = ['plpgsql'];
  return essentials.includes(extName);
};

const close = () => {
  store.showExtensionsModal = false;
  store.extensionsModalDb = null;
  extensions.value = [];
  searchQuery.value = '';
};

onMounted(() => {
  loadExtensions();
});
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center p-4">
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-gray-900/40 dark:bg-black/60 backdrop-blur-sm" @click="close"></div>
    
    <!-- Modal -->
    <div class="relative bg-white dark:bg-zinc-900 w-full max-w-2xl max-h-[85vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col border border-gray-100 dark:border-zinc-800 animate-in fade-in zoom-in duration-200">
      <!-- Header -->
      <div class="px-6 py-5 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
            <svg class="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a1 1 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
            </svg>
          </div>
          <div>
            <h2 class="text-xl font-black text-gray-900 dark:text-white leading-tight">{{ t('postgresConfig.addons') }}</h2>
            <p v-if="store.extensionsModalDb" class="text-xs text-gray-500 dark:text-zinc-400 font-medium">{{ store.extensionsModalDb.name }}</p>
          </div>
        </div>

        <div class="flex items-center gap-4">
          <div class="relative hidden sm:block">
            <input 
              v-model="searchQuery"
              type="text" 
              :placeholder="t('common.search') + '...'"
              class="w-48 px-4 py-2 bg-gray-50 dark:bg-zinc-950 border border-gray-100 dark:border-zinc-800 rounded-xl text-xs font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500/50 transition-all"
            >
            <svg class="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <button @click="close" class="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-xl transition-colors text-gray-400">
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto p-6 custom-scrollbar min-h-[300px]">
        <div v-if="isLoading" class="py-20 flex flex-col items-center justify-center">
          <div class="w-10 h-10 rounded-full border-4 border-amber-500/10 border-t-amber-500 animate-spin mb-4"></div>
          <p class="text-sm font-bold text-gray-400 dark:text-zinc-500">{{ t('common.loading') }}...</p>
        </div>
        
        <div v-else-if="filteredExtensions.length === 0" class="py-20 flex flex-col items-center justify-center text-center opacity-40">
           <svg class="w-12 h-12 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <p class="text-sm font-black">{{ t('common.noResults') }}</p>
        </div>

        <div v-else class="grid grid-cols-1 gap-3">
          <div 
            v-for="ext in filteredExtensions" 
            :key="ext.name"
            class="group bg-gray-50 dark:bg-zinc-950/40 border border-gray-100 dark:border-zinc-800/60 p-4 rounded-2xl transition-all hover:border-amber-500/30 hover:bg-white dark:hover:bg-zinc-900 shadow-sm hover:shadow-md"
          >
            <div class="flex items-start justify-between gap-4">
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-black text-gray-900 dark:text-white">{{ ext.name }}</span>
                  <span class="text-[10px] font-bold text-gray-400 dark:text-zinc-500 font-mono">v{{ ext.default_version }}</span>
                </div>
                <p class="text-xs text-gray-500 dark:text-zinc-400 leading-relaxed line-clamp-2">
                  {{ te(`postgresConfig.extensionDescriptions.${ext.name}`) ? t(`postgresConfig.extensionDescriptions.${ext.name}`) : ext.comment }}
                </p>
                <div v-if="ext.name === 'pg_stat_statements' && ext.is_installed" class="mt-2 flex items-start gap-2 p-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  <svg class="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p class="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-tight leading-tight">
                    {{ t('viewer.performanceNote') }}
                  </p>
                </div>
              </div>
              
              <div class="flex flex-col items-end gap-2">
                <span v-if="ext.is_installed" class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-black border border-emerald-500/10 uppercase tracking-tight">
                  {{ t('postgresConfig.installed') }}
                </span>
                <button
                  v-if="!isEssentialExtension(ext.name) || !ext.is_installed"
                  @click="toggleExtension(ext)"
                  :class="[
                    'px-4 h-8 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 whitespace-nowrap',
                    ext.is_installed 
                      ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20' 
                      : 'text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20'
                  ]"
                >
                  {{ ext.is_installed ? t('postgresConfig.uninstall') : t('postgresConfig.install') }}
                </button>
                <div 
                  v-else
                  class="px-4 h-8 flex items-center justify-center rounded-lg text-[10px] font-black uppercase tracking-widest bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-zinc-500 cursor-not-allowed"
                >
                  {{ t('postgresConfig.installed') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

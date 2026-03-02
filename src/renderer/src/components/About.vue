<script setup lang="ts">
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { useToast } from '../composables/useToast';

const { t } = useI18n();
const { addToast } = useToast();

const checkForUpdates = async () => {
  if (store.checkingUpdate) return;
  
  try {
    store.checkingUpdate = true;
    const result = await ipcRenderer.invoke('check-for-updates');
    store.checkingUpdate = false;
    
    if (result.updateAvailable) {
      store.updateAvailable = true;
      store.updateDetails = {
        version: result.version,
        url: result.url,
        releaseNotes: result.releaseNotes
      };
      addToast(t('settings.updateAvailable', { version: result.version }), 'info', result.url);
    } else {
      store.updateAvailable = false;
      store.updateDetails = null;
      addToast(t('settings.upToDate'), 'success');
    }
  } catch {
    store.checkingUpdate = false;
    addToast(t('settings.updateError'), 'error');
  }
};

const downloadUpdate = async () => {
  if (store.downloadingUpdate) return;
  store.downloadingUpdate = true;
  store.downloadProgress = 0;
  try {
    await ipcRenderer.invoke('download-update');
  } catch {
    store.downloadingUpdate = false;
    addToast(t('settings.updateError'), 'error');
  }
};

const installUpdate = () => {
  ipcRenderer.invoke('install-update');
};

</script>

<template>
  <div class="h-full flex flex-col items-center justify-center p-8 max-w-4xl mx-auto">
    <!-- Header Section -->
    <div class="relative group mb-12">
      <div class="absolute -inset-4 bg-gradient-to-tr from-blue-500/20 to-purple-500/20 blur-2xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>
      
      <div class="relative w-32 h-32 bg-white dark:bg-zinc-900 rounded-[2.5rem] flex items-center justify-center shadow-2xl rotate-3 group-hover:rotate-0 transition-transform duration-500 border border-white/20">
        <img src="/logo.png" alt="logo" class="w-full h-full p-4 object-contain rounded-[2.5rem]"/>
      </div>
      
      <!-- Version Badge -->
      <div class="absolute -bottom-2 -right-2 px-3 py-1 bg-foreground text-background text-xs font-bold rounded-full shadow-lg border-2 border-background transform group-hover:scale-110 transition-transform duration-300">
        v{{ store.appVersion }}
      </div>
    </div>
    
    <div class="text-center mb-12">
      <h1 class="text-5xl font-black tracking-tighter mb-4 bg-gradient-to-b from-foreground to-foreground/70 bg-clip-text text-transparent">
        bbdump
      </h1>
      <p class="text-xl text-gray-500 dark:text-gray-400 font-medium">
        Modern PostgreSQL Manager
      </p>
    </div>
    
    <!-- Info Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl mb-12">
      <!-- Status Card -->
      <div class="bg-surface/50 backdrop-blur-md border border-white/10 rounded-3xl p-6 shadow-xl relative overflow-hidden group">
        <div class="absolute top-0 right-0 p-4 opacity-10 transform translate-x-2 -translate-y-2 group-hover:scale-125 transition-transform duration-500">
          <svg class="w-16 h-16" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 2.18l7 3.12v4.7c0 4.67-3.13 8.75-7 9.81-3.87-1.06-7-5.14-7-9.81V6.3l7-3.12z"/>
          </svg>
        </div>
        
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Status</h3>
        
        <div class="flex items-center gap-3">
          <template v-if="store.updateDownloaded">
            <div class="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_12px_rgba(34,197,94,0.5)]"></div>
            <span class="text-lg font-bold text-green-500 tracking-tight">{{ t('settings.updateReady') }}</span>
          </template>
          <template v-else-if="store.downloadingUpdate">
            <div class="w-3 h-3 bg-blue-500 rounded-full animate-pulse shadow-[0_0_12px_rgba(59,130,246,0.5)]"></div>
            <span class="text-lg font-bold text-blue-500 tracking-tight">{{ t('settings.downloading') }}</span>
          </template>
          <template v-else-if="store.updateAvailable">
            <div class="w-3 h-3 bg-blue-500 rounded-full animate-pulse shadow-[0_0_12px_rgba(59,130,246,0.5)]"></div>
            <span class="text-lg font-bold text-blue-500 tracking-tight">{{ t('settings.updateAvailableShort') }}</span>
          </template>
          <template v-else>
            <div class="w-3 h-3 bg-green-500 rounded-full shadow-[0_0_12px_rgba(34,197,94,0.5)]"></div>
            <span class="text-lg font-bold text-green-500 tracking-tight">{{ t('settings.upToDate') }}</span>
          </template>
        </div>

        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          <template v-if="store.updateDownloaded">
            v{{ store.updateDetails?.version }} {{ t('settings.readyToInstall') }}
          </template>
          <template v-else-if="store.downloadingUpdate">
            {{ t('settings.downloading') }} {{ store.downloadProgress }}%
          </template>
          <template v-else-if="store.updateAvailable">
            v{{ store.updateDetails?.version }} {{ t('settings.isAvailable') }}
          </template>
          <template v-else>
            {{ t('settings.latestVersion') }}
          </template>
        </p>

        <!-- Progress bar -->
        <div v-if="store.downloadingUpdate" class="mt-3 w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2 overflow-hidden">
          <div class="bg-blue-500 h-full rounded-full transition-all duration-300" :style="{ width: store.downloadProgress + '%' }"></div>
        </div>

        <div class="mt-4 flex gap-2">
          <button
            v-if="store.updateDownloaded"
            @click="installUpdate"
            class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-green-500/20 active:scale-95"
          >
            {{ t('settings.installAndRestart') }}
          </button>
          <button
            v-else-if="store.updateAvailable && !store.downloadingUpdate"
            @click="downloadUpdate"
            class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20 active:scale-95"
          >
            {{ t('settings.downloadUpdate') }} v{{ store.updateDetails?.version }}
          </button>
          <button
            v-if="!store.downloadingUpdate && !store.updateDownloaded"
            @click="checkForUpdates"
            class="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all group active:scale-95 disabled:opacity-50"
            :disabled="store.checkingUpdate"
            :title="t('settings.checkForUpdates')"
          >
            <svg
              class="w-5 h-5 text-gray-400 group-hover:text-foreground transition-colors"
              :class="{ 'animate-spin': store.checkingUpdate }"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <!-- App Details Card -->
      <div class="bg-surface/50 backdrop-blur-md border border-white/10 rounded-3xl p-6 shadow-xl relative overflow-hidden group">
        <h3 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">Details</h3>
        
        <div class="space-y-4">
          <div class="flex justify-between items-center text-sm">
            <span class="text-gray-500">{{ t('about.version') }}</span>
            <span class="font-mono font-bold">{{ store.appVersion }}</span>
          </div>
          <div class="flex justify-between items-center text-sm">
            <span class="text-gray-500">{{ t('about.author') }}</span>
            <span class="font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">{{ store.appAuthor }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="flex flex-col items-center gap-4 text-center">
      <div class="flex gap-6">
        <a href="https://github.com/poup-s/bbDump-app" target="_blank" class="text-gray-400 hover:text-foreground transition-colors">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        </a>
        <a href="https://ko-fi.com/poup_s" target="_blank" class="text-gray-400 hover:text-amber-500 transition-colors">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 14c.83.642 2.077 1.017 3.5 1c1.423.017 2.67-.358 3.5-1s2.077-1.017 3.5-1c1.423-.017 2.67.358 3.5 1"/>
            <path d="M8 3a2.4 2.4 0 0 0-1 2a2.4 2.4 0 0 0 1 2m4-4a2.4 2.4 0 0 0-1 2a2.4 2.4 0 0 0 1 2"/>
            <path d="M3 10h14v5a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z"/>
            <path d="M16.746 16.726a3 3 0 1 0 .252-5.555"/>
          </svg>
        </a>
      </div>
      <p class="text-xs text-gray-500">
        &copy; {{ new Date().getFullYear() }} bbdump. Built with ❤️ by <a href="https://github.com/poup-s" target="_blank" class="text-blue-500 hover:text-blue-600 transition-colors">Poups</a>.
      </p>
    </div>
  </div>
</template>

<style scoped>
.animate-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { store } from './store';
import { useI18n } from './composables/useI18n';
import { useToast } from './composables/useToast';
import { ipcRenderer } from './electron';
import { useDark, useToggle } from '@vueuse/core';

// Components
import Dashboard from './components/Dashboard.vue';
import DatabaseList from './components/DatabaseList.vue';
import BackupList from './components/BackupList.vue';
import LogViewer from './components/LogViewer.vue';
import ScheduledTasks from './components/ScheduledTasks.vue';
import Settings from './components/Settings.vue';
import About from './components/About.vue';
import ToastNotification from './components/ToastNotification.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import DatabaseModal from './components/DatabaseModal.vue';
import CreateDatabaseModal from './components/CreateDatabaseModal.vue';
import RestoreBackupModal from './components/RestoreBackupModal.vue';
import RestoreConfirmModal from './components/RestoreConfirmModal.vue';
import DbViewer from './components/db-viewer/DbViewer.vue';
import Onboarding from './components/Onboarding.vue';
import ThreeBackground from './components/ThreeBackground.vue';
import VideoLoader from './components/VideoLoader.vue';
import ExtensionsModal from './components/ExtensionsModal.vue';

const { t, setLanguage } = useI18n();
const { addToast } = useToast();
const isDark = useDark();
const toggleDark = useToggle(isDark);

const activeTab = computed({
  get: () => store.activeTab,
  set: (value) => { store.activeTab = value; }
});

const tabs = [
  { id: 'dashboard', label: 'nav.dashboard', short: 'navShort.dashboard', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
  { id: 'databases', label: 'nav.databases', short: 'navShort.databases', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
  { id: 'backups', label: 'nav.backups', short: 'navShort.backups', icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
  { id: 'logs', label: 'nav.logs', short: 'navShort.logs', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9h6m-6 4h6' },
  { id: 'tasks', label: 'nav.tasks', short: 'navShort.tasks', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'settings', label: 'nav.settings', short: 'navShort.settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'about', label: 'nav.about', short: 'navShort.about', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' }
];

const loadConfig = async () => {
  try {
    const config = await ipcRenderer.invoke('get-config');
    store.databases = config.databases;
    
    // Handle onboarding state
    store.onboardingCompleted = config.onboardingCompleted || false;
    
    // Handle language
    if (config.language) {
      store.language = config.language;
      setLanguage(config.language);
    }

    // Handle SQL mutations setting
    store.allowSqlMutations = config.allowSqlMutations || false;
  } catch (error) {
    console.error('Error loading config:', error);
    addToast('Error loading configuration', 'error');
  }
};

const loadAppInfo = async () => {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    store.appVersion = version;
  } catch (error) {
    console.error('Error loading app info:', error);
  }
};

const checkForUpdates = async () => {
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
    }
  } catch (error) {
    store.checkingUpdate = false;
    console.error('Error checking for updates:', error);
  }
};

// IPC Listeners
const setupListeners = () => {
  ipcRenderer.on('backup-complete', (_: any, result: any) => {
    store.isBackingUp = false;
    if (result.success) {
      addToast(t('backup.success', { db: result.database }), 'success');
      // Update last backup time in store
      const db = store.databases.find(d => d.name === result.database);
      if (db) db.lastBackup = result.timestamp;
    } else {
      addToast(t('backup.error', { db: result.database, error: result.error }), 'error');
    }
    store.backupProgress = null;
  });

  ipcRenderer.on('backup-progress', (_: any, data: any) => {
    store.backupProgress = data;
  });

  ipcRenderer.on('backup-started', (_: any, dbName: string) => {
    store.isBackingUp = true;
    store.backupProgress = { status: 'starting', dbName, logs: [], error: null };
    addToast(t('backup.started', { db: dbName }), 'info');
  });
};

onMounted(() => {
  loadConfig();
  loadAppInfo();
  checkForUpdates();
  setupListeners();
});

onUnmounted(() => {
  ipcRenderer.removeAllListeners('backup-complete');
  ipcRenderer.removeAllListeners('backup-progress');
  ipcRenderer.removeAllListeners('backup-started');
});

const handleLoaderComplete = () => {
  store.isLoading = false;
};
</script>

<template>
  <VideoLoader v-if="store.isLoading" @complete="handleLoaderComplete" />
  
  <Onboarding v-else-if="!store.onboardingCompleted" />
  
  <div v-else class="h-screen flex bg-background text-foreground font-sans overflow-hidden relative transition-colors duration-300">
    <ThreeBackground />
    
    <!-- Window Drag Region -->
    <div class="absolute top-0 left-0 right-0 h-10 z-[100] drag-region"></div>
    
    <!-- Floating Sidebar -->
    <nav class="w-20 mx-4 mb-4 mt-12 flex flex-col items-center bg-surface/80 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl z-50 perspective-1000">
      <div class="p-4 mb-4">
        <div class="w-12 h-12 bg-foreground text-background rounded-xl flex items-center justify-center shadow-lg rotate-3 hover:rotate-0 transition-transform duration-500 bg-white dark:bg-zinc-800">
          <img src="/logo.png" alt="logo" class="w-12 h-12 rounded-xl shadow-lg"/>
        </div>
      </div>
      
      <div class="flex-1 w-full flex flex-col items-center justify-center gap-4">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          :class="[
            'flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-500 ease-out group relative transform-style-3d no-drag w-16',
            activeTab === tab.id
              ? 'bg-foreground text-background shadow-xl shadow-foreground/20'
              : 'text-gray-400 hover:text-foreground hover:bg-white/10'
          ]"
        >
          <div class="relative transform transition-transform duration-300 group-active:scale-75">
            <svg class="w-6 h-6 drop-shadow-md" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="tab.icon" />
            </svg>
          </div>
          <span class="text-[9px] font-medium leading-tight truncate w-full text-center">{{ t(tab.short) }}</span>
        </button>
      </div>

      <div class="p-4 mb-2">
        <button 
          @click="toggleDark()" 
          class="p-3 rounded-xl text-gray-400 hover:text-foreground hover:bg-white/10 transition-all duration-300 hover:rotate-180 no-drag"
        >
          <svg v-if="isDark" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <svg v-else class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        </button>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="flex-1 mr-4 mb-4 mt-12 ml-0 bg-surface/50 backdrop-blur-md border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative z-10">
      <div class="h-full p-8" :class="{ 'overflow-y-auto scrollbar-hide': activeTab !== 'logs' }">
        <Transition
          enter-active-class="transition duration-300 ease-out"
          enter-from-class="transform opacity-0 translate-y-4"
          enter-to-class="transform opacity-100 translate-y-0"
          leave-active-class="transition duration-200 ease-in"
          leave-from-class="transform opacity-100 translate-y-0"
          leave-to-class="transform opacity-0 -translate-y-4"
          mode="out-in"
        >
          <component :is="{
            dashboard: Dashboard,
            databases: DatabaseList,
            backups: BackupList,
            logs: LogViewer,
            tasks: ScheduledTasks,
            settings: Settings,
            about: About
          }[activeTab]" />
        </Transition>
      </div>
    </main>

    <!-- Global Components -->
    <ToastNotification />
    <ConfirmModal />
    
    <!-- Modals -->
    <DatabaseModal />
    <CreateDatabaseModal />
    <RestoreBackupModal />
    <RestoreConfirmModal />
    <!-- BackupProgressModal removed in favor of card animation -->
    <DbViewer
      v-if="store.showDbViewer"
      @close="store.showDbViewer = false; store.viewerDb = null"
    />
    <ExtensionsModal v-if="store.showExtensionsModal" />
  </div>
</template>

<style>
.scrollbar-hide::-webkit-scrollbar {
    display: none;
}
.scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
}

.perspective-1000 {
  perspective: 1000px;
}

.transform-style-3d {
  transform-style: preserve-3d;
}

.rotate-y-12 {
  transform: rotateY(12deg);
}

.hover\:rotate-y-12:hover {
  transform: rotateY(12deg) scale(1.1);
}

.drag-region {
  -webkit-app-region: drag;
}

.no-drag {
  -webkit-app-region: no-drag;
}
</style>

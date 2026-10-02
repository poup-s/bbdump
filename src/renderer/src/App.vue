<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { store } from './store';
import { useI18n } from './composables/useI18n';
import { useAppEvents } from './composables/useAppEvents';
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
// Decorative WebGL background: separate chunk, mounted once the UI is idle
const ThreeBackground = defineAsyncComponent(() => import('./components/ThreeBackground.vue'));
// Shown once after an update: separate chunk
const WhatsNew = defineAsyncComponent(() => import('./components/whats-new/WhatsNew.vue'));
const showBackground = ref(false);
onMounted(() => {
  const whenIdle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
  whenIdle(() => { showBackground.value = true; });
});
import VideoLoader from './components/VideoLoader.vue';
import ExtensionsModal from './components/ExtensionsModal.vue';
import AiJournalModal from './components/AiJournalModal.vue';
import SyncFromSourceModal from './components/SyncFromSourceModal.vue';

const { t } = useI18n();
const isDark = useDark();
const toggleDark = useToggle(isDark);
useAppEvents();

const activeTab = computed({
  get: () => store.activeTab,
  set: (value) => { store.activeTab = value; }
});

const tabs = [
  { id: 'dashboard', label: 'nav.dashboard', short: 'navShort.dashboard', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
  { id: 'databases', label: 'nav.databases', short: 'navShort.databases', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
  { id: 'backups', label: 'nav.backups', short: 'navShort.backups', icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
  { id: 'logs', label: 'nav.logs', short: 'navShort.logs', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9h6m-6 4h6' },
  // Clock split in two paths (face, then hands) so the hands can spin on hover
  { id: 'tasks', label: 'nav.tasks', short: 'navShort.tasks', icon: ['M21 12a9 9 0 11-18 0 9 9 0 0118 0z', 'M12 8v4l3 3'] },
  { id: 'settings', label: 'nav.settings', short: 'navShort.settings', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'about', label: 'nav.about', short: 'navShort.about', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' }
];

const handleLoaderComplete = () => {
  store.isLoading = false;
};
</script>

<template>
  <VideoLoader v-if="store.isLoading" @complete="handleLoaderComplete" />
  
  <Onboarding v-else-if="!store.onboardingCompleted" />
  
  <div v-else class="h-screen flex bg-background text-foreground font-sans overflow-hidden relative transition-colors duration-300">
    <ThreeBackground v-if="showBackground" />
    
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
            'flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-500 ease-out group relative transform-style-3d no-drag w-16 cursor-pointer',
            activeTab === tab.id
              ? 'bg-foreground text-background shadow-xl shadow-foreground/20'
              : 'text-gray-400 hover:text-foreground hover:bg-white/10'
          ]"
        >
          <div class="relative transform transition-transform duration-300 group-active:scale-75">
            <svg :class="['w-6 h-6 drop-shadow-md nav-icon', `nav-icon-${tab.id}`]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                v-for="(d, i) in (Array.isArray(tab.icon) ? tab.icon : [tab.icon])"
                :key="i"
                :class="`part-${i}`"
                stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="d"
              />
            </svg>
          </div>
          <span class="text-[9px] font-medium leading-tight truncate w-full text-center">{{ t(tab.short) }}</span>
        </button>

        <!-- Ko-fi -->
        <a
          href="https://ko-fi.com/poup_s"
          target="_blank"
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-500 ease-out group relative transform-style-3d no-drag w-16 cursor-pointer text-amber-500/60 hover:text-amber-500 hover:bg-amber-500/10"
        >
          <div class="relative transform transition-transform duration-300 group-active:scale-75">
            <svg class="w-6 h-6 drop-shadow-md nav-icon nav-icon-kofi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 14c.83.642 2.077 1.017 3.5 1c1.423.017 2.67-.358 3.5-1s2.077-1.017 3.5-1c1.423-.017 2.67.358 3.5 1"/>
              <path class="steam" d="M8 3a2.4 2.4 0 0 0-1 2a2.4 2.4 0 0 0 1 2m4-4a2.4 2.4 0 0 0-1 2a2.4 2.4 0 0 0 1 2"/>
              <path d="M3 10h14v5a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z"/>
              <path d="M16.746 16.726a3 3 0 1 0 .252-5.555"/>
            </svg>
          </div>
          <span class="text-[9px] font-medium leading-tight truncate w-full text-center">Ko-fi</span>
        </a>
      </div>

      <div class="p-4 mb-2">
        <button 
          @click="toggleDark()" 
          :title="isDark ? t('dbModal.themeLight') : t('dbModal.themeDark')"
          :aria-label="isDark ? t('dbModal.themeLight') : t('dbModal.themeDark')"
          class="p-3 rounded-xl text-gray-400 hover:text-foreground hover:bg-white/10 transition-all duration-300 hover:rotate-180 no-drag cursor-pointer"
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
    
    <!-- Modals — mounted on demand via v-if for memory efficiency -->
    <Transition enter-active-class="transition duration-300 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-200 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <DatabaseModal v-if="store.showDatabaseModal" />
    </Transition>
    <Transition enter-active-class="transition duration-300 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-200 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <CreateDatabaseModal v-if="store.showCreateDatabaseModal" />
    </Transition>
    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <RestoreBackupModal v-if="store.showRestoreModal" />
    </Transition>
    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
      <RestoreConfirmModal v-if="store.showRestoreConfirmModal" />
    </Transition>
    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <ExtensionsModal v-if="store.showExtensionsModal" />
      <AiJournalModal v-if="store.aiJournalDb" />
      <SyncFromSourceModal v-if="store.syncTargetDb" />
    </Transition>
    <DbViewer
      v-if="store.showDbViewer"
      @close="store.showDbViewer = false; store.viewerDb = null"
    />

    <Transition enter-active-class="transition duration-500 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-300 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
      <WhatsNew v-if="store.showWhatsNew" />
    </Transition>

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

/* Sidebar icons: one short, meaningful animation per icon, played on hover */
.nav-icon,
.nav-icon path {
  transform-box: view-box;
  transform-origin: 12px 12px;
}
.group:hover .nav-icon-dashboard { animation: nav-pop 0.45s ease-out; }
.group:hover .nav-icon-databases { animation: nav-lift 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.group:hover .nav-icon-backups { animation: nav-drop 0.5s ease-out; }
.group:hover .nav-icon-logs { animation: nav-wiggle 0.5s ease-in-out; }
.group:hover .nav-icon-tasks .part-1 { animation: nav-spin 0.8s cubic-bezier(0.45, 0, 0.2, 1); }
.group:hover .nav-icon-settings { animation: nav-gear 0.6s cubic-bezier(0.45, 0, 0.2, 1); }
.group:hover .nav-icon-about { animation: nav-hop 0.45s ease-out; }
.nav-icon-kofi .steam { transform-origin: 10px 5px; }
.group:hover .nav-icon-kofi .steam { animation: nav-steam 0.9s ease-out; }

@keyframes nav-pop {
  0% { transform: scale(1) rotate(0); }
  45% { transform: scale(1.15) rotate(-6deg); }
  100% { transform: scale(1) rotate(0); }
}
@keyframes nav-lift {
  0% { transform: translateY(0); }
  40% { transform: translateY(-3px); }
  100% { transform: translateY(0); }
}
@keyframes nav-drop {
  0% { transform: translateY(0); }
  30% { transform: translateY(2px) scaleY(0.94); }
  60% { transform: translateY(-1px); }
  100% { transform: translateY(0); }
}
@keyframes nav-wiggle {
  0%, 100% { transform: rotate(0); }
  25% { transform: rotate(-8deg); }
  50% { transform: rotate(6deg); }
  75% { transform: rotate(-3deg); }
}
@keyframes nav-spin {
  from { transform: rotate(0); }
  to { transform: rotate(360deg); }
}
@keyframes nav-gear {
  from { transform: rotate(0); }
  to { transform: rotate(90deg); }
}
@keyframes nav-hop {
  0% { transform: translateY(0); }
  35% { transform: translateY(-3px) scale(1.06); }
  70% { transform: translateY(0.5px); }
  100% { transform: translateY(0); }
}
@keyframes nav-steam {
  0% { transform: translateY(0); opacity: 1; }
  50% { transform: translateY(-2.5px); opacity: 0.2; }
  51% { transform: translateY(2px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .group:hover .nav-icon,
  .group:hover .nav-icon path { animation: none !important; }
}

.no-drag {
  -webkit-app-region: no-drag;
}
</style>

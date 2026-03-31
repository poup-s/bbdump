<script setup lang="ts">
import { store } from '../store';
import { useI18n } from '../composables/useI18n';

const { t } = useI18n();
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div v-if="store.isBackingUp && store.backupProgress" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden p-6 text-center">
        <div class="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-6 relative">
          <svg class="w-8 h-8 text-foreground animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
        
        <h3 class="text-xl font-bold mb-2">{{ t('modal.backupInProgress') }}</h3>
        <p class="text-gray-500 mb-6">{{ store.databases.find(d => d.id === store.backupProgress?.dbId)?.displayName || store.databases.find(d => d.id === store.backupProgress?.dbId)?.name || store.backupProgress?.dbId }}</p>
        
        <div class="w-full bg-surface rounded-full h-2 mb-2 overflow-hidden">
          <div 
            class="bg-foreground h-2 rounded-full transition-all duration-300"
            :style="{ width: `${store.backupProgress.percentage}%` }"
          ></div>
        </div>
        <div class="flex justify-between text-xs text-gray-400 font-mono">
          <span>{{ store.backupProgress.percentage }}%</span>
          <span>{{ store.backupProgress.currentTable || 'Initializing...' }}</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

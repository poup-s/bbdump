<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import RestoreAnimation from './RestoreAnimation.vue';

const { t } = useI18n();
const { addToast } = useToast();

const isLoading = ref(false);
const selectedDb = ref<string>('');
const countdown = ref(5);
const isCountdownActive = ref(false);
let countdownInterval: NodeJS.Timeout | null = null;

// Auto-select first database if available
const databases = computed(() => store.databases || []);
if (databases.value.length > 0 && !selectedDb.value) {
  selectedDb.value = databases.value[0].name;
}

const targetDb = computed(() => {
  return databases.value.find(db => db.name === selectedDb.value);
});

const canProceed = computed(() => {
  return selectedDb.value && countdown.value === 0 && !isCountdownActive.value;
});

// Start countdown when modal opens
watch(() => store.showRestoreModal, (show) => {
  if (show) {
    startCountdown();
  } else {
    stopCountdown();
  }
});

const startCountdown = () => {
  countdown.value = 5;
  isCountdownActive.value = true;
  
  countdownInterval = setInterval(() => {
    countdown.value--;
    if (countdown.value <= 0) {
      countdown.value = 0;
      isCountdownActive.value = false;
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }
  }, 1000);
};

const stopCountdown = () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  countdown.value = 5;
  isCountdownActive.value = false;
};

onUnmounted(() => {
  stopCountdown();
});

const proceedToConfirm = () => {
  if (!store.restoreBackupFile || !selectedDb.value) {
    addToast('Please select a target database', 'error');
    return;
  }

  const db = databases.value.find(db => db.name === selectedDb.value);
  if (!db) {
    addToast('Please select a target database', 'error');
    return;
  }

  // Store target database and show confirmation modal
  store.restoreTargetDb = db;
  store.showRestoreModal = false;
  store.showRestoreConfirmModal = true;
};

const close = () => {
  store.showRestoreModal = false;
  store.restoreBackupFile = null;
  selectedDb.value = '';
};
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
    <div v-if="store.showRestoreModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div 
        class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl max-w-2xl w-full border border-border overflow-hidden"
        @click.stop
      >
        <div class="p-6">
            <div class="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-4">
              <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            
            <h3 class="text-xl font-bold mb-2">{{ t('modal.restoreTitle') }}</h3>
          <p class="text-gray-500 dark:text-gray-400 mb-6">
              {{ t('modal.restoreConfirm', { file: store.restoreBackupFile }) }}
            </p>
            
          <!-- Visual Flow -->
          <div class="mb-6 p-4 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-200 dark:border-zinc-700">
            <div class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {{ t('modal.restoreFlow') }}
            </div>
            
            <!-- Source Backup -->
            <div class="flex items-center gap-3 mb-4">
              <div class="shrink-0 w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('modal.restoreSource') }}</div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{{ store.restoreBackupFile }}</div>
              </div>
            </div>

            <!-- Arrow -->
            <div class="flex items-center justify-center mb-4">
              <svg class="w-6 h-6 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>

            <!-- Target Database -->
            <div class="flex items-center gap-3">
              <div class="shrink-0 w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                <svg class="w-5 h-5 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">{{ t('modal.restoreTarget') }}</div>
              <select
                v-model="selectedDb"
                class="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
              >
                <option v-for="db in databases" :key="db.name" :value="db.name">
                    {{ db.displayName || db.name }} ({{ db.host }}:{{ db.port }})
                </option>
              </select>
              </div>
            </div>
            </div>
            
          <!-- What will happen -->
          <div class="mb-6">
            <div class="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
              {{ t('modal.restoreWhatHappens') }}
            </div>
            <div class="space-y-2">
              <div class="flex items-start gap-3">
                <div class="shrink-0 w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mt-0.5">
                  <span class="text-xs font-bold text-red-600 dark:text-red-400">1</span>
                </div>
                <div class="text-sm text-gray-700 dark:text-gray-300">
                  {{ t('modal.restoreStep1') }}
                </div>
              </div>
              <div class="flex items-start gap-3">
                <div class="shrink-0 w-5 h-5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mt-0.5">
                  <span class="text-xs font-bold text-yellow-600 dark:text-yellow-400">2</span>
                </div>
                <div class="text-sm text-gray-700 dark:text-gray-300">
                  {{ t('modal.restoreStep2') }}
                </div>
              </div>
              <div class="flex items-start gap-3">
                <div class="shrink-0 w-5 h-5 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mt-0.5">
                  <span class="text-xs font-bold text-green-600 dark:text-green-400">3</span>
                </div>
                <div class="text-sm text-gray-700 dark:text-gray-300">
                  {{ t('modal.restoreStep3') }}
                </div>
              </div>
            </div>
          </div>

          <!-- Warning -->
          <div class="bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 p-4 rounded-lg text-sm border-2 border-red-200 dark:border-red-800/50">
            <div class="flex items-start gap-2">
              <svg class="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <div class="font-semibold mb-1">{{ t('modal.restoreWarning') }}</div>
                <div class="text-xs opacity-90">
                  {{ t('modal.restoreStep1') }}
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <div class="bg-surface px-6 py-4 flex justify-end gap-3 border-t border-border">
          <button
            @click="close"
            class="px-4 py-2 rounded-xl text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-zinc-800 transition-colors font-medium"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            @click="proceedToConfirm"
            :disabled="!canProceed"
            class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white transition-colors font-medium flex items-center gap-2 relative"
          >
            <span v-if="isCountdownActive" class="flex items-center gap-2">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {{ t('modal.restoreButtonWait', { seconds: countdown }) }}
            </span>
            <span v-else>
            {{ t('modal.restoreButton') }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useToast } from '../composables/useToast';
import { useI18n } from '../composables/useI18n';
import { store } from '../store';

const { t } = useI18n();
const { toasts, removeToast } = useToast();

const handleAction = (url: string, toastId: number) => {
  if (url.startsWith('__navigate:')) {
    const tab = url.replace('__navigate:', '');
    store.activeTab = tab;
    removeToast(toastId);
  } else {
    window.open(url, '_blank');
  }
};
</script>

<template>
  <div class="fixed top-8 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none">
    <transition-group name="toast-3d">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto group perspective-1000"
      >
        <div
          class="relative bg-white dark:bg-zinc-900/90 backdrop-blur-xl border border-gray-300 dark:border-white/20 shadow-lg rounded-xl px-3 py-2 min-w-[280px] max-w-sm transform-style-3d transition-all duration-500 hover:scale-105 hover:rotate-x-0"
          :class="[
            'rotate-x-12',
            toast.type === 'success' ? 'shadow-green-500/20' : '',
            toast.type === 'error' ? 'shadow-red-500/20' : '',
            toast.type === 'warning' ? 'shadow-yellow-500/20' : '',
            toast.type === 'info' ? 'shadow-blue-500/20' : ''
          ]"
        >
          <!-- 3D Depth Layer -->
          <div
            class="absolute inset-0 rounded-xl transform -translate-z-4 bg-gray-100/20 dark:bg-black/20 blur-sm"
          ></div>

          <div class="relative flex items-center gap-2.5 transform translate-z-2">
            <!-- Icon Container -->
            <div
              class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
              :class="[
                toast.type === 'success' ? 'bg-green-500/20 text-green-500' : '',
                toast.type === 'error' ? 'bg-red-500/20 text-red-500' : '',
                toast.type === 'warning' ? 'bg-yellow-500/20 text-yellow-500' : '',
                toast.type === 'info' ? 'bg-blue-500/20 text-blue-500' : ''
              ]"
            >
              <svg v-if="toast.type === 'success'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else-if="toast.type === 'error'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <svg v-else-if="toast.type === 'warning'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white leading-snug">{{ toast.message }}</p>

              <!-- Action Button for Updates -->
              <button
                v-if="toast.actionUrl"
                @click="handleAction(toast.actionUrl, toast.id)"
                class="mt-1.5 text-[11px] px-2.5 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-blue-400 font-semibold"
              >
                <span v-if="toast.actionUrl?.startsWith('__navigate:')">{{ t('settings.updateNow') || 'Update Now' }}</span>
                <span v-else>Open</span>
                <svg v-if="!toast.actionUrl?.startsWith('__navigate:')" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <svg v-else class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            <!-- Close Button -->
            <button
              @click="removeToast(toast.id)"
              class="p-0.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-gray-400 hover:text-foreground transition-colors shrink-0"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Shine Effect -->
          <div class="absolute inset-0 rounded-xl bg-gradient-to-tr from-white/20 dark:from-white/10 to-transparent pointer-events-none"></div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.perspective-1000 {
  perspective: 1000px;
}

.transform-style-3d {
  transform-style: preserve-3d;
}

.rotate-x-12 {
  transform: rotateX(12deg);
}

.hover\:rotate-x-0:hover {
  transform: rotateX(0deg) scale(1.05);
}

.-translate-z-4 {
  transform: translateZ(-4px);
}

.translate-z-2 {
  transform: translateZ(2px);
}

.toast-3d-enter-active,
.toast-3d-leave-active {
  transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toast-3d-enter-from {
  opacity: 0;
  transform: translateY(-100px) rotateX(-45deg) scale(0.8);
}

.toast-3d-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.8);
}
</style>

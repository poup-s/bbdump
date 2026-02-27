<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useToast } from '../composables/useToast';
import { store } from '../store';

const { toasts, removeToast } = useToast();

// Track progress for each toast (countdown)
const progressMap = ref<Record<number, number>>({});
let intervalId: ReturnType<typeof setInterval> | null = null;

const handleAction = (url: string, toastId: number) => {
  if (url.startsWith('__navigate:')) {
    const tab = url.replace('__navigate:', '');
    store.activeTab = tab;
    removeToast(toastId);
  } else {
    window.open(url, '_blank');
  }
};

onMounted(() => {
  intervalId = setInterval(() => {
    for (const toast of toasts.value) {
      if (progressMap.value[toast.id] === undefined) {
        progressMap.value[toast.id] = 100;
      }
      const duration = toast.actionUrl ? 10000 : 5000;
      const step = (100 / duration) * 50;
      progressMap.value[toast.id] = Math.max(0, progressMap.value[toast.id] - step);
    }
    // Cleanup removed toasts
    const activeIds = new Set(toasts.value.map(t => t.id));
    for (const key of Object.keys(progressMap.value)) {
      if (!activeIds.has(Number(key))) {
        delete progressMap.value[Number(key)];
      }
    }
  }, 50);
});

onUnmounted(() => {
  if (intervalId) clearInterval(intervalId);
});
</script>

<template>
  <div class="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2.5 pointer-events-none">
    <transition-group name="toast-glass">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto toast-perspective"
      >
        <div
          class="toast-card relative overflow-hidden rounded-2xl min-w-[300px] max-w-md"
          :class="{
            'toast-success': toast.type === 'success',
            'toast-error': toast.type === 'error',
            'toast-warning': toast.type === 'warning',
            'toast-info': toast.type === 'info',
          }"
        >
          <!-- Glass background -->
          <div class="absolute inset-0 glass-bg"></div>

          <!-- Top highlight (3D edge light) -->
          <div class="absolute inset-x-0 top-0 h-px glass-highlight"></div>

          <!-- Inner shadow (depth) -->
          <div class="absolute inset-0 rounded-2xl glass-inner-shadow pointer-events-none"></div>

          <!-- Content -->
          <div class="relative flex items-center gap-3 px-4 py-3">
            <!-- Icon -->
            <div
              class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 icon-container"
              :class="{
                'bg-emerald-500/20 text-emerald-500 dark:text-emerald-400': toast.type === 'success',
                'bg-red-500/20 text-red-500 dark:text-red-400': toast.type === 'error',
                'bg-amber-500/20 text-amber-500 dark:text-amber-400': toast.type === 'warning',
                'bg-blue-500/20 text-blue-500 dark:text-blue-400': toast.type === 'info',
              }"
            >
              <svg v-if="toast.type === 'success'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else-if="toast.type === 'error'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <svg v-else-if="toast.type === 'warning'" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
              </svg>
              <svg v-else class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>

            <!-- Message -->
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white/95 leading-snug">{{ toast.message }}</p>
              <button
                v-if="toast.actionUrl"
                @click="handleAction(toast.actionUrl!, toast.id)"
                class="mt-1 text-xs font-semibold transition-colors"
                :class="{
                  'text-emerald-600 dark:text-emerald-400 hover:text-emerald-500': toast.type === 'success',
                  'text-red-600 dark:text-red-400 hover:text-red-500': toast.type === 'error',
                  'text-amber-600 dark:text-amber-400 hover:text-amber-500': toast.type === 'warning',
                  'text-blue-600 dark:text-blue-400 hover:text-blue-500': toast.type === 'info',
                }"
              >
                View →
              </button>
            </div>

            <!-- Close -->
            <button
              @click="removeToast(toast.id)"
              class="p-1 rounded-lg text-gray-400/70 hover:text-gray-600 dark:text-white/30 dark:hover:text-white/70 hover:bg-black/5 dark:hover:bg-white/10 transition-colors shrink-0"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Progress bar -->
          <div class="relative h-[2px] bg-black/5 dark:bg-white/5">
            <div
              class="absolute inset-y-0 left-0 transition-all duration-75 ease-linear"
              :class="{
                'bg-emerald-500/50': toast.type === 'success',
                'bg-red-500/50': toast.type === 'error',
                'bg-amber-500/50': toast.type === 'warning',
                'bg-blue-500/50': toast.type === 'info',
              }"
              :style="{ width: `${progressMap[toast.id] ?? 100}%` }"
            ></div>
          </div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-perspective {
  perspective: 800px;
}

.toast-card {
  transform: rotateX(2deg);
  transform-style: preserve-3d;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-card:hover {
  transform: rotateX(0deg) scale(1.02);
}

/* ---- Glass backgrounds ---- */
.glass-bg {
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
  background: rgba(255, 255, 255, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.5);
}

:root.dark .glass-bg,
.dark .glass-bg {
  background: rgba(30, 30, 34, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

/* ---- Top highlight (simulates light reflection on glass edge) ---- */
.glass-highlight {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent);
}

.dark .glass-highlight {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent);
}

/* ---- Inner shadow for depth ---- */
.glass-inner-shadow {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 3px rgba(0,0,0,0.06);
}

.dark .glass-inner-shadow {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 3px rgba(0,0,0,0.3);
}

/* ---- Colored shadow per type (strong depth) ---- */
.toast-success .glass-bg {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 12px 40px rgba(16, 185, 129, 0.18), 0 1px 3px rgba(0,0,0,0.1);
}
.toast-error .glass-bg {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 12px 40px rgba(239, 68, 68, 0.18), 0 1px 3px rgba(0,0,0,0.1);
}
.toast-warning .glass-bg {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 12px 40px rgba(245, 158, 11, 0.18), 0 1px 3px rgba(0,0,0,0.1);
}
.toast-info .glass-bg {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 12px 40px rgba(59, 130, 246, 0.18), 0 1px 3px rgba(0,0,0,0.1);
}

.dark .toast-success .glass-bg {
  box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 12px 40px rgba(16, 185, 129, 0.2), 0 1px 3px rgba(0,0,0,0.5);
}
.dark .toast-error .glass-bg {
  box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 12px 40px rgba(239, 68, 68, 0.2), 0 1px 3px rgba(0,0,0,0.5);
}
.dark .toast-warning .glass-bg {
  box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 12px 40px rgba(245, 158, 11, 0.2), 0 1px 3px rgba(0,0,0,0.5);
}
.dark .toast-info .glass-bg {
  box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 12px 40px rgba(59, 130, 246, 0.2), 0 1px 3px rgba(0,0,0,0.5);
}

/* ---- Icon container inner glow ---- */
.icon-container {
  backdrop-filter: blur(4px);
  box-shadow: inset 0 1px 2px rgba(255,255,255,0.2);
}

.dark .icon-container {
  box-shadow: inset 0 1px 2px rgba(255,255,255,0.05);
}

/* ---- Transitions ---- */
.toast-glass-enter-active {
  transition: all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toast-glass-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 1, 1);
}

.toast-glass-enter-from {
  opacity: 0;
  transform: translateY(-30px) scale(0.9);
}

.toast-glass-leave-to {
  opacity: 0;
  transform: translateY(-15px) scale(0.95);
}

.toast-glass-move {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
</style>

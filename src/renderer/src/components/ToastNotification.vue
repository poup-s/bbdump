<script setup lang="ts">
/**
 * Toasts, newest on top. Hovering one keeps it on screen (its bar pauses too);
 * errors stay longer and their detail can be selected and copied.
 */
import { useToast } from '../composables/useToast';
import { useI18n } from '../composables/useI18n';
import type { Toast } from '../types';

const { toasts, removeToast, pauseToast, resumeToast } = useToast();
const { t } = useI18n();

const tone = {
  success: { dot: 'bg-emerald-500', bar: 'bg-emerald-500', action: 'text-emerald-700 dark:text-emerald-400' },
  info: { dot: 'bg-sky-500', bar: 'bg-sky-500', action: 'text-sky-700 dark:text-sky-400' },
  warning: { dot: 'bg-amber-500', bar: 'bg-amber-500', action: 'text-amber-700 dark:text-amber-400' },
  error: { dot: 'bg-red-500', bar: 'bg-red-500', action: 'text-red-700 dark:text-red-400' },
} as const;

const runAction = (toast: Toast) => {
  toast.action?.run();
  removeToast(toast.id);
};
</script>

<template>
  <div
    class="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] w-[min(380px,calc(100vw-32px))] flex flex-col gap-2 pointer-events-none"
    aria-live="polite"
  >
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :role="toast.type === 'error' ? 'alert' : 'status'"
        class="toast group pointer-events-auto relative overflow-hidden rounded-xl border border-gray-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-sm shadow-[0_10px_30px_-10px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6)]"
        @mouseenter="pauseToast(toast.id)"
        @mouseleave="resumeToast(toast.id)"
      >
        <div class="flex items-start gap-3 pl-3.5 pr-2 py-3">
          <!-- Type -->
          <span class="mt-px w-[18px] h-[18px] rounded-full grid place-items-center shrink-0 text-white" :class="tone[toast.type].dot" aria-hidden="true">
            <svg v-if="toast.type === 'success'" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <svg v-else-if="toast.type === 'error'" class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span v-else-if="toast.type === 'warning'" class="text-[11px] font-bold leading-none">!</span>
            <span v-else class="text-[11px] font-bold leading-none font-serif italic">i</span>
          </span>

          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-medium leading-snug text-gray-900 dark:text-zinc-100 whitespace-pre-line break-words">
              {{ toast.message }}
              <span v-if="toast.count > 1" class="ml-1 align-middle font-mono text-[10px] font-normal px-1.5 py-px rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400">×{{ toast.count }}</span>
            </p>
            <p
              v-if="toast.detail"
              class="mt-1 font-mono text-[11.5px] leading-relaxed text-gray-500 dark:text-zinc-400 whitespace-pre-line break-words line-clamp-4 select-text cursor-text"
              :title="toast.detail"
            >{{ toast.detail }}</p>
            <button
              v-if="toast.action"
              type="button"
              class="mt-1.5 text-[12px] font-medium hover:underline underline-offset-2"
              :class="tone[toast.type].action"
              @click="runAction(toast)"
            >{{ toast.action.label }} →</button>
          </div>

          <button
            type="button"
            class="p-1 -mt-0.5 rounded-md text-gray-400 hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
            :aria-label="t('common.close')"
            @click="removeToast(toast.id)"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Time left (paused while hovered) -->
        <div
          :key="toast.restartKey"
          class="toast-bar absolute left-0 bottom-0 h-[2px] w-full origin-left opacity-50"
          :class="tone[toast.type].bar"
          :style="{ animationDuration: `${toast.duration}ms` }"
          aria-hidden="true"
        />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-bar {
  animation-name: toast-time;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
.toast:hover .toast-bar {
  animation-play-state: paused;
}
@keyframes toast-time {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

.toast-enter-active {
  transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
.toast-leave-to {
  opacity: 0;
  transform: scale(0.98);
}
.toast-move {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active, .toast-leave-active, .toast-move { transition: opacity 0.1s linear; }
  .toast-enter-from, .toast-leave-to { transform: none; }
  .toast-bar { animation: none; }
}
</style>

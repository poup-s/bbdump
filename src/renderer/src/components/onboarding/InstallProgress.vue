<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';

/** Live progress of the running install (percent -1 = indeterminate). */
const { t } = useI18n();
const { state } = useOnboarding();

const percent = computed(() => state.progress?.percent ?? -1);
/** Translated stage as the headline; the raw line (apt, brew…) underneath when it adds something. */
const headline = computed(() => {
  const stage = state.progress?.stage;
  return stage ? t(`onboarding.machine.stages.${stage}`) : (state.progress?.message || t('onboarding.machine.installing'));
});
const detail = computed(() => {
  const progress = state.progress;
  if (!progress?.stage || !progress.message || progress.message === headline.value) return '';
  return progress.message;
});
</script>

<template>
  <div role="status" aria-live="polite" class="space-y-2">
    <div class="progress">
      <div
        class="progress-bar"
        :class="{ indeterminate: percent < 0 }"
        :style="percent >= 0 ? { width: `${Math.min(100, percent)}%` } : undefined"
      />
    </div>
    <p class="text-xs text-zinc-400 break-words">{{ headline }}</p>
    <p v-if="detail" class="text-[11px] font-mono text-zinc-600 truncate" :title="detail">{{ detail }}</p>
  </div>
</template>

<style scoped>
.progress {
  position: relative;
  height: 3px;
  border-radius: 9999px;
  background: #27272a;
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: #10b981;
  transition: width 0.4s ease;
}
.progress-bar.indeterminate {
  width: 35%;
  animation: slide 1.3s ease-in-out infinite;
}
@keyframes slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
@media (prefers-reduced-motion: reduce) {
  .progress-bar.indeterminate {
    width: 100%;
    animation: none;
    opacity: 0.6;
  }
}
</style>

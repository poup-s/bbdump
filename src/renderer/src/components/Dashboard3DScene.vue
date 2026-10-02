<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useDark, usePreferredReducedMotion } from '@vueuse/core';
import type { ServerStackHandle, StackFocus } from './3d/serverStack';

const props = withDefaults(defineProps<{
  /** What the camera frames (the onboarding walks through the stack) */
  focus?: StackFocus;
  /** Force a theme; follows the app theme when omitted */
  dark?: boolean;
}>(), { focus: 'overview', dark: undefined });

const appDark = useDark();
const isDark = computed(() => props.dark ?? appDark.value);
const reducedMotion = usePreferredReducedMotion();
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const failed = ref(false);

let handle: ServerStackHandle | null = null;
let unmounted = false;

onMounted(async () => {
  try {
    // three.js lives in its own chunk, fetched only when the dashboard is shown
    const { createServerStackScene } = await import('./3d/serverStack');
    if (unmounted || !canvas.value) return;
    handle = createServerStackScene(canvas.value, {
      dark: isDark.value,
      reducedMotion: reducedMotion.value === 'reduce',
      onReady: () => { ready.value = true; },
    });
    handle.setFocus(props.focus);
  } catch (error) {
    // No WebGL (or it failed): keep the static silhouette
    console.warn('3D scene unavailable:', error);
    failed.value = true;
  }
});

watch(isDark, dark => handle?.setDark(dark));
watch(() => props.focus, focus => handle?.setFocus(focus));

onBeforeUnmount(() => {
  unmounted = true;
  handle?.dispose();
  handle = null;
});
</script>

<template>
  <div class="scene">
    <!-- Lightweight silhouette shown instantly, crossfades out when the 3D is ready -->
    <svg
      class="placeholder"
      :class="{ hidden: ready, dark: isDark }"
      viewBox="0 0 400 300"
      aria-hidden="true"
    >
      <ellipse cx="200" cy="150" rx="185" ry="48" transform="rotate(-8 200 150)" class="orbit" />
      <g v-for="(y, i) in [92, 142, 192]" :key="y" :style="{ animationDelay: `${i * 0.15}s` }" class="disc">
        <path :d="`M130 ${y} v14 a70 17 0 0 0 140 0 v-14`" class="side" />
        <ellipse cx="200" :cy="y" rx="70" ry="17" class="top" />
        <path :d="`M130 ${y + 9} a70 17 0 0 0 140 0`" class="band" />
      </g>
      <line x1="200" y1="62" x2="200" y2="230" class="rod" />
    </svg>

    <canvas ref="canvas" class="canvas" :class="{ visible: ready && !failed }" />
  </div>
</template>

<style scoped>
.scene {
  position: relative;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.canvas,
.placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.canvas {
  display: block;
  opacity: 0;
  transition: opacity 0.6s ease;
}
.canvas.visible {
  opacity: 1;
}

.placeholder {
  transition: opacity 0.6s ease;
  --stack: #2a2e35;
  --stack-top: #353a42;
  --orbit: #d4d4d8;
}
.placeholder.hidden {
  opacity: 0;
}
:global(.dark) .placeholder,
.placeholder.dark {
  --stack: #3b424d;
  --stack-top: #454c58;
  --orbit: #3f3f46;
}

.side { fill: var(--stack); }
.top { fill: var(--stack-top); }
.band { fill: none; stroke: #10b981; stroke-width: 1.5; opacity: 0.7; }
.rod { stroke: var(--orbit); stroke-width: 3; }
.orbit { fill: none; stroke: var(--orbit); stroke-width: 1; }

.disc {
  animation: breathe 1.6s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 0.8; }
}
@media (prefers-reduced-motion: reduce) {
  .disc { animation: none; }
}
</style>

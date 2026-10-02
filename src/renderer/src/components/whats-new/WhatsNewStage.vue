<script setup lang="ts">
/**
 * Plays a slide's screenshots: zooms on each measured area, rings it and labels it,
 * then moves to the next one. Below the capture, one bar per animation fills while it
 * plays, so it is clear there are several; hovering the capture or the pause button stops it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { cameraFor, DEFAULT_HOLD, markOf, ringFor, shotUrl, type Beat } from '../../whatsNew';

const props = defineProps<{ beats: Beat[]; lang: 'en' | 'fr' }>();
const { t } = useI18n();

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const index = ref(0);
/** 0 → 1 through the current animation */
const progress = ref(0);
const hovered = ref(false);
const paused = ref(false);

const beat = computed(() => props.beats[index.value] ?? props.beats[0]);
const shots = computed(() => [...new Set(props.beats.map(b => b.shot))]);
const overlays = computed(() => [...new Set(props.beats.map(b => b.overlay).filter((o): o is string => !!o))]);
const mark = computed(() => markOf(props.lang, beat.value));
const camera = computed(() => (reduceMotion ? { ...cameraFor(mark.value), scale: 1 } : cameraFor(mark.value)));
const ring = computed(() => (mark.value ? ringFor(mark.value, camera.value.scale) : null));

const label = computed(() => {
  const key = beat.value.mark ?? (beat.value.overlay ? 'confirm' : '');
  return key ? t(`whatsNew.marks.${beat.value.shot}.${key}`) : '';
});

/** Below the ring, or above it when it reaches the bottom of the stage */
const labelStyle = computed(() => {
  if (!ring.value) return { left: '50%', bottom: '6%', transform: 'translateX(-50%)' };
  const [x, y, w, h] = ring.value;
  const center = Math.min(82, Math.max(18, x + w / 2));
  const below = y + h < 80;
  return below
    ? { left: `${center}%`, top: `${Math.min(92, y + h + 2.5)}%`, transform: 'translateX(-50%)' }
    : { left: `${center}%`, top: `${Math.max(4, y - 2.5)}%`, transform: 'translate(-50%, -100%)' };
});

const layerStyle = computed(() => ({
  transform: `scale(${camera.value.scale})`,
  transformOrigin: `${camera.value.originX}% ${camera.value.originY}%`,
}));

// Clock: time only runs while playing, so a pause resumes where it stopped
const running = computed(() => !paused.value && !hovered.value);
let frame = 0;
let last = 0;
const tick = (now: number) => {
  const delta = last ? now - last : 0;
  last = now;
  if (running.value) {
    progress.value += delta / (beat.value.hold ?? DEFAULT_HOLD);
    if (progress.value >= 1) {
      progress.value = 0;
      index.value = (index.value + 1) % props.beats.length;
    }
  }
  frame = requestAnimationFrame(tick);
};
onMounted(() => { frame = requestAnimationFrame(tick); });
onBeforeUnmount(() => cancelAnimationFrame(frame));

watch(() => props.beats, () => { index.value = 0; progress.value = 0; });

const go = (i: number) => {
  index.value = (i + props.beats.length) % props.beats.length;
  progress.value = 0;
};
const fill = (i: number) => (i < index.value ? 1 : i === index.value ? Math.min(1, progress.value) : 0);
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      class="stage-frame relative w-full overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0d0d0f] shadow-2xl shadow-black/60"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
    >
      <div class="absolute inset-0 layer" :style="layerStyle">
        <img
          v-for="shot in shots"
          :key="shot"
          :src="shotUrl(lang, shot)"
          alt=""
          draggable="false"
          class="absolute inset-0 w-full h-full object-cover transition-opacity duration-500"
          :class="shot === beat.shot ? 'opacity-100' : 'opacity-0'"
        />
      </div>

      <div
        v-if="ring"
        :key="`ring-${index}`"
        class="ring absolute rounded-xl border-2 border-emerald-400 pointer-events-none"
        :style="{ left: `${ring[0]}%`, top: `${ring[1]}%`, width: `${ring[2]}%`, height: `${ring[3]}%` }"
      />

      <img
        v-for="overlay in overlays"
        :key="overlay"
        :src="shotUrl(lang, overlay)"
        alt=""
        draggable="false"
        class="absolute right-[5%] top-[7%] w-[30%] rounded-2xl shadow-2xl shadow-black/70 transition-all duration-500"
        :class="beat.overlay === overlay ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'"
      />

      <div
        v-if="label"
        :key="`label-${index}`"
        class="label absolute z-10 flex items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/50 bg-zinc-950/90 px-3.5 py-1.5 text-[12.5px] font-medium text-emerald-50 shadow-lg shadow-black/50"
        :style="labelStyle"
      >
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" aria-hidden="true" />
        {{ label }}
      </div>
    </div>

    <!-- One bar per animation, filling while it plays -->
    <div class="controls flex items-center gap-3 px-1">
      <button
        type="button"
        class="ctrl"
        :aria-label="paused ? t('whatsNew.play') : t('whatsNew.pause')"
        :title="paused ? t('whatsNew.play') : t('whatsNew.pause')"
        @click="paused = !paused"
      >
        <svg v-if="paused" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
      </button>
      <button type="button" class="ctrl" :aria-label="t('whatsNew.prevStep')" :title="t('whatsNew.prevStep')" @click="go(index - 1)">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>

      <div class="flex-1 flex items-center gap-1.5" role="tablist">
        <button
          v-for="(b, i) in beats"
          :key="i"
          type="button"
          role="tab"
          :aria-selected="i === index"
          :aria-label="`${i + 1} / ${beats.length}`"
          :title="t(`whatsNew.marks.${b.shot}.${b.mark ?? 'confirm'}`)"
          class="group flex-1 py-2"
          @click="go(i)"
        >
          <span class="block h-1 rounded-full bg-zinc-800 overflow-hidden group-hover:bg-zinc-700 transition-colors">
            <span class="block h-full rounded-full bg-emerald-400" :style="{ width: `${fill(i) * 100}%` }" />
          </span>
        </button>
      </div>

      <button type="button" class="ctrl" :aria-label="t('whatsNew.nextStep')" :title="t('whatsNew.nextStep')" @click="go(index + 1)">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <span class="font-mono text-[11px] tabular-nums text-zinc-400 min-w-[2.6rem] text-right">{{ index + 1 }} / {{ beats.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.stage-frame {
  aspect-ratio: 16 / 10;
}
.layer {
  transition: transform 0.9s cubic-bezier(0.25, 0.8, 0.25, 1), transform-origin 0.9s cubic-bezier(0.25, 0.8, 0.25, 1);
  will-change: transform;
}
.ring {
  box-shadow: 0 0 0 5px rgba(52, 211, 153, 0.12), 0 0 32px rgba(52, 211, 153, 0.35);
  animation: ring-in 0.45s 0.35s ease-out both;
}
.label {
  animation: label-in 0.4s 0.5s ease-out both;
}
.ctrl {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid #27272a;
  background: rgba(24, 24, 27, 0.7);
  color: #d4d4d8;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.ctrl:hover {
  border-color: #52525b;
  color: #fafafa;
}
@keyframes ring-in {
  from { opacity: 0; scale: 1.04; }
  to { opacity: 1; scale: 1; }
}
@keyframes label-in {
  from { opacity: 0; margin-top: 6px; }
  to { opacity: 1; margin-top: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .layer { transition: none; }
  .ring, .label { animation: none; }
}
</style>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding, type SelectableMode } from './useOnboarding';
import StepHeader from './StepHeader.vue';

const { t } = useI18n();
const { state, recommendedMode } = useOnboarding();

const windows = computed(() => state.env?.supported === false);

interface ModeCard {
  id: SelectableMode;
  icon: string;
  disabled: boolean;
  badges: string[];
}

const cards = computed<ModeCard[]>(() => {
  const ready = state.envStatus === 'ready';
  const badge = (id: SelectableMode) => (ready && recommendedMode.value === id ? [t('onboarding.mode.recommended')] : []);
  return [
    {
      id: 'local',
      icon: 'M4 5h16v10H4zM8 19h8M12 15v4',
      disabled: windows.value,
      badges: windows.value ? [t('onboarding.mode.windowsSoon')] : badge('local'),
    },
    {
      id: 'remote',
      icon: 'M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18M12 3a9 9 0 110 18 9 9 0 010-18z',
      disabled: false,
      badges: badge('remote'),
    },
    // No Docker card: see docs/ROADMAP.md (not promised until decided)
  ];
});

const select = (card: ModeCard) => {
  if (card.disabled) return;
  state.mode = card.id;
};

// Pre-select the recommendation once the machine analysis is known
watch(
  () => state.envStatus,
  status => {
    if (status === 'ready' && !state.mode) state.mode = recommendedMode.value;
    if (windows.value && state.mode === 'local') state.mode = 'remote';
  },
  { immediate: true },
);
</script>

<template>
  <div>
    <StepHeader
      :eyebrow="t('onboarding.sections.you')"
      :title="t('onboarding.mode.title')"
      :subtitle="t('onboarding.mode.subtitle')"
    />

    <div class="space-y-2.5" role="radiogroup" :aria-label="t('onboarding.mode.title')">
      <button
        v-for="card in cards"
        :key="card.id"
        type="button"
        role="radio"
        :aria-checked="state.mode === card.id"
        :aria-disabled="card.disabled"
        :disabled="card.disabled"
        class="w-full flex items-start gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-colors"
        :class="[
          state.mode === card.id
            ? 'border-emerald-500/60 bg-emerald-500/[0.06]'
            : 'border-zinc-800 bg-zinc-900/40',
          card.disabled ? 'opacity-55 cursor-not-allowed' : state.mode !== card.id ? 'hover:border-zinc-700 hover:bg-zinc-900/70' : '',
        ]"
        @click="select(card)"
      >
        <span
          class="mt-0.5 w-8 h-8 shrink-0 rounded-lg flex items-center justify-center border"
          :class="state.mode === card.id ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-800 text-zinc-400'"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path :d="card.icon" />
          </svg>
        </span>
        <span class="flex-1 min-w-0">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-sm font-medium text-zinc-100">{{ t(`onboarding.mode.${card.id}.title`) }}</span>
            <span
              v-for="badge in card.badges"
              :key="badge"
              class="text-[10px] leading-none px-1.5 py-1 rounded-md border border-zinc-700 text-zinc-400"
            >{{ badge }}</span>
          </span>
          <span class="block mt-1 text-xs leading-relaxed text-zinc-400">{{ t(`onboarding.mode.${card.id}.desc`) }}</span>        </span>
        <span
          class="mt-1 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center"
          :class="state.mode === card.id ? 'border-emerald-500' : 'border-zinc-700'"
        >
          <span v-if="state.mode === card.id" class="w-2 h-2 rounded-full bg-emerald-500" />
        </span>
      </button>
    </div>

    <p class="mt-4 text-xs text-zinc-500 flex items-center gap-2 min-h-[1rem]">
      <template v-if="state.envStatus === 'loading'">
        <span class="w-3 h-3 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
        {{ t('onboarding.mode.analyzing') }}
      </template>
      <template v-else>{{ t('onboarding.mode.changeLater') }}</template>
    </p>
  </div>
</template>

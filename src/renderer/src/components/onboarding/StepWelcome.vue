<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import { SECTIONS, useOnboarding, type Language } from './useOnboarding';
import StepHeader from './StepHeader.vue';

const { t } = useI18n();
const { state, selectLanguage } = useOnboarding();

const LANGUAGES: { id: Language; label: string; hint: string }[] = [
  { id: 'en', label: 'English', hint: 'EN' },
  { id: 'fr', label: 'Français', hint: 'FR' },
];
</script>

<template>
  <div>
    <StepHeader :title="t('onboarding.welcome.title')" :subtitle="t('onboarding.welcome.subtitle')" />

    <fieldset>
      <legend class="text-xs font-medium text-zinc-400 mb-2.5">{{ t('onboarding.welcome.language') }}</legend>
      <div class="grid grid-cols-2 gap-2" role="radiogroup">
        <button
          v-for="lang in LANGUAGES"
          :key="lang.id"
          type="button"
          role="radio"
          :aria-checked="state.language === lang.id"
          class="choice flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors"
          :class="state.language === lang.id
            ? 'border-emerald-500/60 bg-emerald-500/[0.06] text-zinc-50'
            : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700'"
          @click="selectLanguage(lang.id)"
        >
          <span class="text-sm font-medium">{{ lang.label }}</span>
          <span class="font-mono text-[10px] text-zinc-500">{{ lang.hint }}</span>
        </button>
      </div>
    </fieldset>

    <div class="mt-8">
      <div class="text-xs font-medium text-zinc-400 mb-3">{{ t('onboarding.welcome.overview') }}</div>
      <ol class="space-y-0 border-l border-zinc-800 ml-1">
        <li v-for="(section, i) in SECTIONS" :key="section" class="relative pl-5 pb-3.5 last:pb-0">
          <span class="absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full border border-zinc-600 bg-zinc-950" />
          <div class="flex items-baseline gap-2">
            <span class="font-mono text-[10px] text-zinc-600">0{{ i + 1 }}</span>
            <span class="text-sm text-zinc-200">{{ t(`onboarding.sections.${section}`) }}</span>
          </div>
          <p class="text-xs text-zinc-500 mt-0.5">{{ t(`onboarding.welcome.sectionLines.${section}`) }}</p>
        </li>
      </ol>
    </div>
  </div>
</template>

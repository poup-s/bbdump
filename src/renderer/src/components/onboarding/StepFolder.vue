<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';
import StepHeader from './StepHeader.vue';

const { t } = useI18n();
const { state, chooseFolder } = useOnboarding();
</script>

<template>
  <div>
    <StepHeader
      :eyebrow="t('onboarding.sections.data')"
      :title="t('onboarding.folder.title')"
      :subtitle="t('onboarding.folder.subtitle')"
    />

    <div class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="flex items-center gap-3">
        <span class="w-8 h-8 shrink-0 rounded-lg border border-zinc-800 flex items-center justify-center text-zinc-400">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-[11px] text-zinc-500">{{ t('onboarding.folder.selected') }}</div>
          <div class="font-mono text-xs text-zinc-200 truncate" :title="state.backupPath">{{ state.backupPath || '—' }}</div>
        </div>
        <button type="button" class="btn-secondary shrink-0" @click="chooseFolder">{{ t('onboarding.folder.change') }}</button>
      </div>
    </div>

    <ul class="mt-5 space-y-2 text-xs text-zinc-500">
      <li class="flex gap-2"><span class="text-zinc-700">—</span>{{ t('onboarding.folder.hintPerDatabase') }}</li>
      <li class="flex gap-2"><span class="text-zinc-700">—</span>{{ t('onboarding.folder.hintSync') }}</li>
    </ul>
  </div>
</template>

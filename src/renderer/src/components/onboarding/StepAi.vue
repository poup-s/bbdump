<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';
import StepHeader from './StepHeader.vue';
import McpClientList from '../McpClientList.vue';

const { t } = useI18n();
const { state } = useOnboarding();

const onChanged = (clients: Array<{ name: string; state: string }>) => {
  state.aiConnected = clients.filter(client => client.state !== 'not-installed').map(client => client.name);
};
</script>

<template>
  <div>
    <StepHeader
      :eyebrow="t('onboarding.sections.ai')"
      :title="t('onboarding.ai.title')"
      :subtitle="t('onboarding.ai.subtitle')"
    />

    <div class="flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 mb-4">
      <svg class="w-4 h-4 mt-px shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
      <p class="text-xs leading-relaxed text-zinc-400">{{ t('onboarding.ai.readOnly') }}</p>
    </div>

    <McpClientList variant="onboarding" @changed="onChanged" />

    <p class="mt-4 text-xs text-zinc-500">{{ t('onboarding.ai.later') }}</p>
  </div>
</template>

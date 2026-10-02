<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding, type StepId } from './useOnboarding';
import StepHeader from './StepHeader.vue';

const { t } = useI18n();
const { state, serverReady, remoteParsed, remoteActive, goToStep, finish, done } = useOnboarding();

interface RecapRow {
  label: string;
  value: string;
  ok: boolean;
  step: StepId;
  mono?: boolean;
}

const rows = computed<RecapRow[]>(() => {
  const env = state.env;
  const list: RecapRow[] = [
    {
      label: t('onboarding.ready.mode'),
      value: t(`onboarding.mode.${state.mode ?? 'local'}.title`),
      ok: true,
      step: 'mode',
    },
    {
      label: t('onboarding.ready.tools'),
      value: env?.clientTools.ready
        ? `pg_dump ${env.clientTools.pgDump.version ?? ''}`.trim()
        : state.envSkipped ? t('onboarding.ready.notChecked') : t('onboarding.ready.missing'),
      ok: !!env?.clientTools.ready,
      step: 'machine',
    },
  ];

  if (state.mode === 'local') {
    list.push({
      label: t('onboarding.ready.server'),
      value: serverReady.value
        ? `PostgreSQL ${env?.server.version ?? ''} · ${t('onboarding.ready.running')}`.replace('  ', ' ')
        : t('onboarding.ready.serverNotReady'),
      ok: serverReady.value,
      step: 'machine',
    });
  }

  const databases: string[] = [];
  if (state.mode === 'local' && state.selectedLocal.length) {
    databases.push(t('onboarding.ready.localSelected', { count: state.selectedLocal.length }));
  }
  if (remoteActive.value && remoteParsed.value) {
    databases.push(`${remoteParsed.value.database} (${state.remote.test === 'ok' ? t('onboarding.ready.tested') : t('onboarding.ready.untested')})`);
  }
  list.push({
    label: t('onboarding.ready.databases'),
    value: databases.length ? databases.join(' · ') : t('onboarding.ready.noneYet'),
    ok: databases.length > 0,
    step: 'databases',
  });

  list.push({
    label: t('onboarding.ready.folder'),
    value: state.backupPath,
    ok: !!state.backupPath,
    step: 'folder',
    mono: true,
  });

  list.push({
    label: t('onboarding.ready.ai'),
    value: state.aiConnected.length ? state.aiConnected.join(', ') : t('onboarding.ready.noAi'),
    ok: state.aiConnected.length > 0,
    step: 'ai',
  });
  return list;
});
</script>

<template>
  <div>
    <StepHeader :title="t('onboarding.ready.title')" :subtitle="t('onboarding.ready.subtitle')" />

    <dl class="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80">
      <div v-for="row in rows" :key="row.label" class="group flex items-center gap-3 px-4 py-3">
        <span class="w-1.5 h-1.5 shrink-0 rounded-full" :class="row.ok ? 'bg-emerald-500' : 'bg-zinc-600'" />
        <dt class="w-24 shrink-0 text-xs text-zinc-500">{{ row.label }}</dt>
        <dd class="flex-1 min-w-0 truncate text-sm text-zinc-200" :class="row.mono ? 'font-mono !text-xs' : ''" :title="row.value">{{ row.value }}</dd>
        <button
          type="button"
          class="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-100 opacity-70 group-hover:opacity-100 focus:opacity-100 transition"
          :disabled="state.finishing"
          @click="goToStep(row.step)"
        >
          {{ t('onboarding.ready.edit') }}
        </button>
      </div>
    </dl>

    <div v-if="state.finishError" class="mt-4 rounded-xl border border-red-400/20 bg-red-400/[0.04] p-4" role="alert">
      <p class="text-xs text-red-200/90 break-words">{{ state.finishError }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn-secondary" :disabled="state.finishing" @click="finish">{{ t('onboarding.retry') }}</button>
        <button v-if="state.saved" type="button" class="btn-ghost !text-xs" :disabled="state.finishing" @click="done">{{ t('onboarding.ready.continueAnyway') }}</button>
      </div>
    </div>
    <p v-else class="mt-4 text-xs text-zinc-500">{{ t('onboarding.ready.footnote') }}</p>
  </div>
</template>

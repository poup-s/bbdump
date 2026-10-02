<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { store } from '../../store';
import { useOnboarding } from './useOnboarding';
import StepHeader from './StepHeader.vue';
import RemoteDatabaseForm from './RemoteDatabaseForm.vue';

const { t } = useI18n();
const { state, discoverLocal, goToStep } = useOnboarding();

const local = computed(() => state.mode === 'local');
const allSelected = computed(() => state.localDbs.length > 0 && state.selectedLocal.length === state.localDbs.length);

/** Already managed by bbdump (onboarding replayed): shown, not imported twice. */
const alreadyManaged = (name: string) =>
  store.databases.some(db => db.name === name && ['localhost', '127.0.0.1', '::1'].includes(db.host));

const toggle = (name: string) => {
  state.selectedLocal = state.selectedLocal.includes(name)
    ? state.selectedLocal.filter(n => n !== name)
    : [...state.selectedLocal, name];
};

const toggleAll = () => {
  state.selectedLocal = allSelected.value ? [] : state.localDbs.map(db => db.name);
};

const remoteSection = ref<HTMLElement | null>(null);
const toggleRemote = async () => {
  state.remoteOpen = !state.remoteOpen;
  if (!state.remoteOpen) return;
  await nextTick();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  remoteSection.value?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  remoteSection.value?.querySelector('input')?.focus({ preventScroll: true });
};

onMounted(() => {
  if (local.value) discoverLocal();
});
</script>

<template>
  <div>
    <StepHeader
      :eyebrow="t('onboarding.sections.data')"
      :title="local ? t('onboarding.databases.titleLocal') : t('onboarding.databases.titleRemote')"
      :subtitle="local ? t('onboarding.databases.subtitleLocal') : t('onboarding.databases.subtitleRemote')"
    />

    <!-- Local mode: databases found on this computer's server -->
    <template v-if="local">
      <div v-if="state.localStatus === 'loading' || state.localStatus === 'idle'" class="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80" aria-busy="true">
        <div v-for="i in 3" :key="i" class="px-4 py-3.5 flex items-center gap-3">
          <span class="w-4 h-4 rounded border border-zinc-700" />
          <span class="h-2.5 rounded bg-zinc-800 animate-pulse" :class="['w-32', 'w-44', 'w-24'][i - 1]" />
        </div>
        <p class="sr-only">{{ t('onboarding.databases.scanning') }}</p>
      </div>

      <div v-else-if="state.localStatus === 'error'" class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div class="text-sm text-zinc-100">{{ t('onboarding.databases.serverUnreachable') }}</div>
        <p class="mt-1 text-xs leading-relaxed text-zinc-400">{{ t('onboarding.databases.serverUnreachableDesc') }}</p>
        <div class="mt-3.5 flex flex-wrap gap-2">
          <button type="button" class="btn-secondary" @click="discoverLocal">{{ t('onboarding.retry') }}</button>
          <button type="button" class="btn-ghost !text-xs" @click="goToStep('machine')">{{ t('onboarding.databases.backToMachine') }}</button>
        </div>
      </div>

      <div v-else-if="state.localDbs.length === 0" class="rounded-xl border border-dashed border-zinc-800 p-5 text-center">
        <div class="text-sm text-zinc-200">{{ t('onboarding.databases.none') }}</div>
        <p class="mt-1 text-xs text-zinc-500">{{ t('onboarding.databases.noneDesc') }}</p>
      </div>

      <div v-else>
        <div class="flex items-center justify-between mb-2 px-1">
          <button type="button" class="text-xs text-zinc-400 hover:text-zinc-100 transition-colors" @click="toggleAll">
            {{ allSelected ? t('onboarding.databases.deselectAll') : t('onboarding.databases.selectAll') }}
          </button>
          <span class="font-mono text-[11px] text-zinc-500 tabular-nums">{{ state.selectedLocal.length }} / {{ state.localDbs.length }}</span>
        </div>
        <div class="rounded-xl border border-zinc-800 divide-y divide-zinc-800/80 max-h-64 overflow-y-auto">
          <button
            v-for="db in state.localDbs"
            :key="db.name"
            type="button"
            role="checkbox"
            :aria-checked="state.selectedLocal.includes(db.name)"
            class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
            @click="toggle(db.name)"
          >
            <span
              class="w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors"
              :class="state.selectedLocal.includes(db.name) ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'"
            >
              <svg v-if="state.selectedLocal.includes(db.name)" class="w-3 h-3 text-zinc-950" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <span class="flex-1 min-w-0">
              <span class="block text-sm text-zinc-100 truncate">{{ db.name }}</span>
              <span class="block text-[11px] text-zinc-500 truncate">
                {{ db.owner }}<template v-if="db.size"> · {{ db.size }}</template>
              </span>
            </span>
            <span v-if="alreadyManaged(db.name)" class="text-[10px] text-zinc-500 shrink-0">{{ t('onboarding.databases.alreadyManaged') }}</span>
          </button>
        </div>
      </div>

      <!-- Local mode can manage remote databases too -->
      <div class="mt-6 pt-5 border-t border-zinc-800/80">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
          :aria-expanded="state.remoteOpen"
          @click="toggleRemote"
        >
          <svg class="w-3 h-3 transition-transform" :class="state.remoteOpen ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {{ t('onboarding.databases.addRemoteToo') }}
        </button>
        <div v-if="state.remoteOpen" ref="remoteSection" class="mt-4">
          <RemoteDatabaseForm />
        </div>
      </div>
    </template>

    <!-- Remote mode: first remote database -->
    <template v-else>
      <RemoteDatabaseForm />
      <p class="mt-5 text-xs text-zinc-500">{{ t('onboarding.databases.optional') }}</p>
    </template>
  </div>
</template>

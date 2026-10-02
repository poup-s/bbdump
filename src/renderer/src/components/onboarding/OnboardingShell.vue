<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, type Component } from 'vue';
import Dashboard3DScene from '../Dashboard3DScene.vue';
import { useI18n } from '../../composables/useI18n';
import { provideOnboarding, SECTIONS, STEPS, type StepId } from './useOnboarding';
import StepWelcome from './StepWelcome.vue';
import StepMode from './StepMode.vue';
import StepMachine from './StepMachine.vue';
import StepDatabases from './StepDatabases.vue';
import StepFolder from './StepFolder.vue';
import StepAi from './StepAi.vue';
import StepReady from './StepReady.vue';

const { t } = useI18n();
const onboarding = provideOnboarding();
const { state, step, canContinue, next, back, finish, loadInitial, loadEnvironment, listenProgress, canCancel, cancel } = onboarding;

const VIEWS: Record<StepId, Component> = {
  welcome: StepWelcome,
  mode: StepMode,
  machine: StepMachine,
  databases: StepDatabases,
  folder: StepFolder,
  ai: StepAi,
  ready: StepReady,
};

const panel = ref<HTMLElement | null>(null);
const isFirst = computed(() => state.stepIndex === 0);
const isLast = computed(() => state.stepIndex === STEPS.length - 1);
const currentSection = computed(() => step.value.section);
const sectionIndex = computed(() => (currentSection.value ? SECTIONS.indexOf(currentSection.value) : -1));

/** done: every section before the current one (all of them on the last step) */
const sectionState = (index: number) => {
  if (isLast.value) return 'done';
  if (index === sectionIndex.value) return 'active';
  const firstStepOfSection = STEPS.findIndex(s => s.section === SECTIONS[index]);
  return state.stepIndex > firstStepOfSection ? 'done' : 'todo';
};

const continueLabel = computed(() => {
  if (step.value.id === 'welcome') return t('onboarding.welcome.start');
  if (step.value.id === 'databases' && !onboarding.remoteParsed.value && !state.selectedLocal.length) return t('onboarding.skip');
  if (step.value.id === 'ai' && !state.aiConnected.length) return t('onboarding.skip');
  if (isLast.value) return t('onboarding.getStarted');
  return t('onboarding.continue');
});

const primary = () => (isLast.value ? finish() : next());

// Enter continues when the step is valid (native behaviour kept on buttons, selects, text areas)
const onKeydown = (event: KeyboardEvent) => {
  // Escape leaves an onboarding opened from the app (nothing is saved before the end)
  if (event.key === 'Escape' && canCancel.value && !state.installing && !event.defaultPrevented) {
    cancel();
    return;
  }
  if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  // Radio cards are buttons too: there, Enter confirms the choice and moves on
  if (target?.closest('button:not([role="radio"]), a, select, textarea, summary')) return;
  if (!canContinue.value) return;
  event.preventDefault();
  primary();
};

/** Move focus to the new step's heading so keyboard and screen reader users follow along. */
const focusHeading = () => {
  nextTick(() => {
    const heading = panel.value?.querySelector<HTMLElement>('[data-step-heading]');
    heading?.focus({ preventScroll: true });
    panel.value?.querySelector('.step-body')?.scrollTo({ top: 0 });
  });
};

let stopProgress: () => void = () => {};

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  stopProgress = listenProgress();
  await loadInitial();
  // Analyse the machine in the background while the user reads the first steps
  loadEnvironment();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  stopProgress();
});
</script>

<template>
  <div class="onboarding dark fixed inset-0 z-50 flex flex-col lg:flex-row bg-[#09090b] text-zinc-100 overflow-hidden">
    <!-- Window drag strip (frameless window) -->
    <div class="drag absolute top-0 inset-x-0 h-10 z-10" aria-hidden="true" />

    <!-- Stage: the stack the steps walk through -->
    <section class="stage relative shrink-0 h-44 sm:h-56 max-h-[30vh] lg:max-h-none lg:h-auto lg:flex-1 lg:min-w-0" aria-hidden="true">
      <div class="glow absolute inset-0 pointer-events-none" />
      <div class="absolute inset-0">
        <Dashboard3DScene :focus="step.focus" dark />
      </div>
      <div class="absolute left-6 bottom-5 lg:left-10 lg:bottom-9 pointer-events-none hidden sm:block">
        <Transition name="caption" mode="out-in">
          <div :key="step.focus" class="max-w-xs">
            <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400/80">
              {{ t(`onboarding.stage.${step.focus}.label`) }}
            </div>
            <div class="mt-1 text-xs text-zinc-500 leading-relaxed">{{ t(`onboarding.stage.${step.focus}.line`) }}</div>
          </div>
        </Transition>
      </div>
    </section>

    <!-- Panel: progress, step card, navigation -->
    <section
      ref="panel"
      class="panel relative flex flex-col min-h-0 flex-1 lg:flex-none lg:w-[480px] xl:w-[520px] border-t lg:border-t-0 lg:border-l border-white/[0.06] bg-zinc-950/70"
    >
      <header class="shrink-0 px-6 sm:px-8 pt-5 lg:pt-12 pb-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2.5">
            <img src="/logo.png" alt="" class="w-6 h-6 rounded-md" />
            <span class="text-sm font-semibold tracking-tight">bbdump</span>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="currentSection" class="font-mono text-[10px] text-zinc-500 tabular-nums">
              {{ sectionIndex + 1 }} / {{ SECTIONS.length }}
            </span>
            <button
              v-if="canCancel"
              type="button"
              class="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
              :disabled="state.finishing || !!state.installing"
              :title="t('onboarding.cancelHint')"
              @click="cancel"
            >
              {{ t('onboarding.cancel') }}
            </button>
          </div>
        </div>

        <ol class="mt-5 grid grid-cols-4 gap-2" :aria-label="t('onboarding.progress')">
          <li v-for="(section, i) in SECTIONS" :key="section" :aria-current="sectionState(i) === 'active' ? 'step' : undefined">
            <div class="h-[3px] rounded-full overflow-hidden bg-zinc-800">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="{
                  'w-full bg-emerald-500': sectionState(i) === 'active' || isLast,
                  'w-full bg-zinc-500': sectionState(i) === 'done' && !isLast,
                  'w-0': sectionState(i) === 'todo',
                }"
              />
            </div>
            <div
              class="mt-2 text-[11px] transition-colors"
              :class="sectionState(i) === 'active' ? 'text-zinc-100' : sectionState(i) === 'done' ? 'text-zinc-400' : 'text-zinc-600'"
            >
              {{ t(`onboarding.sections.${section}`) }}
            </div>
          </li>
        </ol>
      </header>

      <div class="step-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6 sm:px-8 pb-6">
        <Transition :name="state.direction > 0 ? 'step-forward' : 'step-back'" mode="out-in" @after-enter="focusHeading">
          <component :is="VIEWS[step.id]" :key="step.id" />
        </Transition>
      </div>

      <footer class="shrink-0 flex items-center gap-3 px-6 sm:px-8 py-4 border-t border-white/[0.06]">
        <button
          v-if="!isFirst"
          type="button"
          class="btn-ghost"
          :disabled="state.finishing"
          @click="back"
        >
          {{ t('onboarding.back') }}
        </button>
        <span class="flex-1" />
        <span v-if="canContinue && !isFirst" class="hidden sm:inline text-[11px] text-zinc-600">
          <kbd class="font-mono">↵</kbd> Enter
        </span>
        <button
          type="button"
          class="btn-primary"
          :disabled="!canContinue"
          @click="primary"
        >
          <span v-if="state.finishing" class="w-3.5 h-3.5 rounded-full border-2 border-zinc-900/30 border-t-zinc-900 animate-spin" />
          {{ continueLabel }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.drag {
  -webkit-app-region: drag;
}
.onboarding :deep(button),
.onboarding :deep(input),
.onboarding :deep(select),
.onboarding :deep(a) {
  -webkit-app-region: no-drag;
}

.glow {
  background:
    radial-gradient(60% 55% at 50% 50%, rgba(16, 185, 129, 0.07), transparent 70%),
    radial-gradient(120% 90% at 50% 120%, rgba(255, 255, 255, 0.03), transparent 60%);
}

/* Shared controls, used by every step through :deep() */
.onboarding :deep(.btn-primary) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-width: 7.5rem;
  padding: 0.55rem 1.1rem;
  border-radius: 0.6rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #09090b;
  background: #fafafa;
  transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
}
.onboarding :deep(.btn-primary:hover:not(:disabled)) {
  background: #e4e4e7;
}
.onboarding :deep(.btn-primary:active:not(:disabled)) {
  transform: translateY(1px);
}
.onboarding :deep(.btn-primary:disabled) {
  opacity: 0.35;
  cursor: not-allowed;
}
.onboarding :deep(.btn-ghost),
.onboarding :deep(.btn-secondary) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.55rem 0.9rem;
  border-radius: 0.6rem;
  font-size: 0.875rem;
  color: #d4d4d8;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.onboarding :deep(.btn-ghost:hover:not(:disabled)) {
  background: rgba(255, 255, 255, 0.05);
  color: #fafafa;
}
.onboarding :deep(.btn-secondary) {
  padding: 0.4rem 0.75rem;
  font-size: 0.8125rem;
  border: 1px solid #3f3f46;
  background: rgba(24, 24, 27, 0.6);
}
.onboarding :deep(.btn-secondary:hover:not(:disabled)) {
  border-color: #52525b;
  background: #27272a;
  color: #fafafa;
}
.onboarding :deep(.btn-ghost:disabled),
.onboarding :deep(.btn-secondary:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}
.onboarding :deep(button:focus-visible),
.onboarding :deep(a:focus-visible),
.onboarding :deep(select:focus-visible),
.onboarding :deep(input:focus-visible) {
  outline: 2px solid rgba(16, 185, 129, 0.7);
  outline-offset: 2px;
}
.onboarding :deep([data-step-heading]:focus) {
  outline: none;
}

/* Step transitions: a short slide in the direction of travel */
.step-forward-enter-active,
.step-forward-leave-active,
.step-back-enter-active,
.step-back-leave-active {
  transition: opacity 0.22s ease, transform 0.26s cubic-bezier(0.2, 0.7, 0.2, 1);
}
.step-forward-enter-from,
.step-back-leave-to {
  opacity: 0;
  transform: translateX(18px);
}
.step-forward-leave-to,
.step-back-enter-from {
  opacity: 0;
  transform: translateX(-18px);
}

.caption-enter-active,
.caption-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.caption-enter-from,
.caption-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .step-forward-enter-active,
  .step-forward-leave-active,
  .step-back-enter-active,
  .step-back-leave-active,
  .caption-enter-active,
  .caption-leave-active {
    transition: opacity 0.12s linear;
  }
  .step-forward-enter-from,
  .step-forward-leave-to,
  .step-back-enter-from,
  .step-back-leave-to,
  .caption-enter-from,
  .caption-leave-to {
    transform: none;
  }
}
</style>

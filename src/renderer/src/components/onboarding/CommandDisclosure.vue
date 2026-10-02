<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { SetupComponent } from '../../../../types/setup';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';

const props = withDefaults(defineProps<{
  component: SetupComponent;
  /** Open from the start (manual install: the command is the way forward) */
  initiallyOpen?: boolean;
  /** Command from a failed install, shown instead of the plan */
  command?: string;
}>(), { initiallyOpen: false, command: undefined });

const { t } = useI18n();
const { state, getPlan } = useOnboarding();

const open = ref(props.initiallyOpen);
const copied = ref(false);

const text = computed(() => props.command || state.plans[props.component]?.command || '');
const error = computed(() => state.planErrors[props.component]);

watch(open, value => { if (value && !props.command) getPlan(props.component); }, { immediate: true });
// The plan is dropped when the environment changes: fetch it again while open
watch(() => state.plans[props.component], plan => { if (!plan && open.value && !props.command) getPlan(props.component); });

const copy = async () => {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1800);
  } catch {
    copied.value = false;
  }
};
</script>

<template>
  <div>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg class="w-3 h-3 transition-transform" :class="open ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      {{ open ? t('onboarding.machine.hideCommand') : t('onboarding.machine.showCommand') }}
    </button>

    <div v-if="open" class="mt-2">
      <div v-if="text" class="group relative rounded-lg border border-zinc-800 bg-black/40">
        <pre class="font-mono text-[11px] leading-relaxed text-zinc-300 px-3 py-2.5 pr-16 whitespace-pre-wrap break-all select-text">{{ text }}</pre>
        <button
          type="button"
          class="absolute top-1.5 right-1.5 px-2 py-1 rounded-md text-[11px] border border-zinc-700 text-zinc-300 bg-zinc-900 hover:bg-zinc-800 transition-colors"
          @click="copy"
        >
          {{ copied ? t('onboarding.copied') : t('onboarding.copy') }}
        </button>
      </div>
      <p v-else-if="error" class="text-xs text-zinc-500">{{ error }}</p>
      <p v-else class="text-xs text-zinc-600">…</p>
    </div>
  </div>
</template>

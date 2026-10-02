<script setup lang="ts">
import { computed } from 'vue';
import type { SetupComponent } from '../../../../types/setup';
import { useI18n } from '../../composables/useI18n';
import { useOnboarding } from './useOnboarding';
import CommandDisclosure from './CommandDisclosure.vue';
import InstallProgress from './InstallProgress.vue';

/**
 * What can be done about one missing component: install it (with live progress),
 * finish it in Terminal, or run the command by hand. Never a dead end.
 */
const props = defineProps<{
  component: SetupComponent;
  label: string;
  /** bbdump can run it itself; otherwise the command is shown */
  automatic: boolean;
  /** Why it cannot run automatically (shown instead of the button) */
  manualHint?: string;
  /** Waiting on another component (Homebrew): keep the command folded */
  blocked?: boolean;
}>();

const { t } = useI18n();
const { state, install, loadEnvironment } = useOnboarding();

const running = computed(() => state.installing === props.component);
const handedOver = computed(() => (state.handedOver?.component === props.component ? state.handedOver : null));
const error = computed(() => (state.installError?.component === props.component ? state.installError : null));
const manualCommand = computed(() => handedOver.value?.command || error.value?.manualCommand);
</script>

<template>
  <div class="space-y-2.5">
    <InstallProgress v-if="running" />

    <div v-else-if="handedOver" class="rounded-lg border border-zinc-800 bg-black/20 p-3 space-y-2.5">
      <p class="text-xs leading-relaxed text-zinc-300">{{ t('onboarding.machine.handedOver') }}</p>
      <button type="button" class="btn-secondary" :disabled="state.envStatus === 'loading'" @click="loadEnvironment">
        {{ t('onboarding.machine.doneRecheck') }}
      </button>
    </div>

    <button v-else-if="automatic" type="button" class="btn-secondary" :disabled="!!state.installing" @click="install(component)">
      {{ error ? t('onboarding.retry') : label }}
    </button>

    <p v-else-if="manualHint" class="text-xs text-zinc-400">{{ manualHint }}</p>

    <p
      v-if="error && !running"
      class="text-xs break-words"
      :class="error.cancelled ? 'text-zinc-400' : 'text-red-300/90'"
      role="alert"
    >
      {{ error.message }}
    </p>

    <CommandDisclosure
      :key="manualCommand || 'plan'"
      :component="component"
      :command="manualCommand"
      :initially-open="!!manualCommand || (!automatic && !blocked)"
    />
  </div>
</template>

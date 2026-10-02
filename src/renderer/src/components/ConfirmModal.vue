<script setup lang="ts">
/** The app's confirmation (useConfirm), in the shared dialog shell, above everything else. */
import { computed } from 'vue';
import { useConfirm } from '../composables/useConfirm';
import AppModal from './ui/AppModal.vue';
import { btnDanger, btnGhost, btnPrimary } from './ui/classes';

const { state, confirm, cancel } = useConfirm();

const ICONS = {
  danger: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
};

const tone = computed(() => (state.type === 'danger' || state.type === 'error' ? 'danger' : state.type === 'warning' ? 'warning' : 'default'));
const icon = computed(() => (tone.value === 'danger' ? ICONS.danger : tone.value === 'warning' ? ICONS.warning : ICONS.info));
</script>

<template>
  <AppModal
    v-if="state.show"
    :title="state.title"
    :icon="icon"
    :tone="tone"
    width="sm"
    layer="top"
    :close-label="state.cancelText"
    @close="cancel"
    @submit="confirm"
  >
    <p class="text-[13px] leading-relaxed text-gray-600 dark:text-zinc-300 whitespace-pre-line break-words">{{ state.message }}</p>
    <template #footer>
      <span class="flex-1" />
      <button type="button" :class="btnGhost" @click="cancel">{{ state.cancelText }}</button>
      <button type="button" :class="tone === 'danger' ? btnDanger : btnPrimary" @click="confirm">{{ state.confirmText }}</button>
    </template>
  </AppModal>
</template>

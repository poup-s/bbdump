<script setup lang="ts">
/**
 * Shows its content only when the feature is on for this database. The slot gets `beta`
 * to add a badge. Hiding is a convenience: the main process refuses on its own.
 */
import { computed } from 'vue';
import { useFeatures } from '../../composables/useFeatures';
import type { FeatureKey } from '../../../../shared/engines/features';

const props = defineProps<{ db: { engine?: string } | null | undefined; feature: FeatureKey }>();
const features = useFeatures();
const state = computed(() => features.feature(props.db, props.feature));
</script>

<template>
  <slot v-if="state.enabled" :beta="state.beta" />
</template>

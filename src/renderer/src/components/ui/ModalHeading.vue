<script setup lang="ts">
/** Eyebrow, title and one line of context: the onboarding's step header, for dialogs. */
defineProps<{ eyebrow?: string; title: string; subtitle?: string }>();
</script>

<template>
  <div class="pb-4">
    <div v-if="eyebrow" class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-1.5">{{ eyebrow }}</div>
    <h3 class="text-lg leading-snug font-semibold tracking-tight text-gray-900 dark:text-zinc-50">{{ title }}</h3>
    <p v-if="subtitle" class="mt-1 text-[13px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ subtitle }}</p>
  </div>
</template>

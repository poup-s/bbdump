<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string; subtitle?: string }>();
</script>

<template>
  <div class="pt-2 pb-6">
    <div v-if="eyebrow" class="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-3">{{ eyebrow }}</div>
    <h1 tabindex="-1" data-step-heading class="text-[1.6rem] leading-tight font-semibold tracking-tight text-zinc-50">{{ title }}</h1>
    <p v-if="subtitle" class="mt-2.5 text-sm leading-relaxed text-zinc-400">{{ subtitle }}</p>
  </div>
</template>

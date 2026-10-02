<script setup lang="ts">
/** A large option to pick (connection method…), like the onboarding's mode cards. */
defineProps<{ title: string; description?: string; icon?: string; selected?: boolean }>();
defineEmits<{ (e: 'select'): void }>();
</script>

<template>
  <button
    type="button"
    role="radio"
    :aria-checked="!!selected"
    class="w-full flex items-start gap-3 text-left p-3.5 rounded-xl border transition-colors"
    :class="selected
      ? 'border-emerald-400 dark:border-emerald-600 bg-emerald-50/60 dark:bg-emerald-950/20 ring-1 ring-emerald-400/30'
      : 'border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900'"
    @click="$emit('select')"
  >
    <span
      v-if="icon"
      class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors"
      :class="selected ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" :d="icon" />
      </svg>
    </span>
    <span class="flex-1 min-w-0">
      <span class="block text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ title }}</span>
      <span v-if="description" class="block mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ description }}</span>
    </span>
    <span
      class="mt-1 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center transition-colors"
      :class="selected ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 dark:border-zinc-600'"
      aria-hidden="true"
    >
      <span v-if="selected" class="w-1.5 h-1.5 rounded-full bg-white" />
    </span>
  </button>
</template>

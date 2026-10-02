<script setup lang="ts" generic="T extends string">
/** Small exclusive choice (URL / Manual…), keyboard reachable as a radio group. */
defineProps<{
  options: { value: T; label: string; icon?: string }[];
  label: string;
}>();
const model = defineModel<T | null>({ required: true });
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="inline-flex p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="model === option.value"
      class="flex items-center gap-1.5 px-3 h-7 rounded-md text-[12px] font-medium transition-colors"
      :class="model === option.value
        ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-zinc-100 shadow-sm'
        : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100'"
      @click="model = option.value"
    >
      <svg v-if="option.icon" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" :d="option.icon" />
      </svg>
      {{ option.label }}
    </button>
  </div>
</template>

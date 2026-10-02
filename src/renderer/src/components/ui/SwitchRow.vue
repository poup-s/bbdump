<script setup lang="ts">
/** A setting that is on or off: title, one line of explanation, a switch. */
defineProps<{ title: string; description?: string; disabled?: boolean }>();
const model = defineModel<boolean>({ default: false });
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="!!model"
    :disabled="disabled"
    class="w-full flex items-start gap-3 text-left px-3.5 py-3 rounded-xl border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    :class="model
      ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/50 dark:bg-emerald-950/20'
      : 'border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 bg-white dark:bg-zinc-900'"
    @click="model = !model"
  >
    <span class="flex-1 min-w-0">
      <span class="block text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ title }}</span>
      <span v-if="description" class="block mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ description }}</span>
      <slot />
    </span>
    <span
      class="relative mt-0.5 w-8 h-[18px] shrink-0 rounded-full transition-colors duration-200"
      :class="model ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-zinc-600'"
      aria-hidden="true"
    >
      <span
        class="absolute left-0 top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200"
        :class="model ? 'translate-x-[16px]' : 'translate-x-[2px]'"
      />
    </span>
  </button>
</template>

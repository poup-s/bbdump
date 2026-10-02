<script setup lang="ts">
/** Label + control + hint or error, the same everywhere. The control goes in the slot. */
defineProps<{
  label: string;
  /** id of the control, for the label */
  for?: string;
  required?: boolean;
  optional?: string;
  hint?: string;
  error?: string;
}>();
</script>

<template>
  <div class="min-w-0">
    <div class="flex items-center justify-between gap-2 mb-1.5">
      <label :for="$props.for" class="text-[12px] font-medium text-gray-600 dark:text-zinc-400">
        {{ label }}<span v-if="required" class="text-emerald-600 dark:text-emerald-400 ml-0.5" aria-hidden="true">*</span>
        <span v-if="optional" class="font-normal text-gray-400 dark:text-zinc-500 ml-1">{{ optional }}</span>
      </label>
      <slot name="action" />
    </div>
    <slot />
    <p v-if="error" class="mt-1.5 text-[11px] text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="mt-1.5 text-[11px] leading-relaxed text-gray-500 dark:text-zinc-500">{{ hint }}</p>
  </div>
</template>

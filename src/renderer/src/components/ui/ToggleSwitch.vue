<script setup lang="ts">
/** A bare on/off switch for a settings row; `tone` colours it when on (a risky setting is amber or red). */
withDefaults(defineProps<{ on: boolean; label: string; tone?: 'default' | 'warn' | 'danger'; disabled?: boolean }>(), { tone: 'default', disabled: false });
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="on"
    :aria-label="label"
    :disabled="disabled"
    class="relative w-9 h-5 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
    :class="!on ? 'bg-gray-300 dark:bg-zinc-600' : tone === 'danger' ? 'bg-red-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'"
    @click="emit('toggle')"
  >
    <span
      class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"
      :class="on ? 'translate-x-4' : ''"
    />
  </button>
</template>

<script setup lang="ts">
/** One line of the machine check: status dot, name, detail, and an optional action below. */
defineProps<{
  title: string;
  detail?: string;
  status: 'ok' | 'warn' | 'missing' | 'busy';
}>();
</script>

<template>
  <div class="px-4 py-3.5">
    <div class="flex items-start gap-3">
      <span class="mt-[5px] w-2 h-2 shrink-0 rounded-full" :class="{
        'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]': status === 'ok',
        'bg-amber-400': status === 'warn',
        'bg-zinc-600': status === 'missing',
        'bg-emerald-400 animate-pulse': status === 'busy',
      }" />
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-sm text-zinc-100">{{ title }}</span>
          <slot name="aside" />
        </div>
        <p v-if="detail" class="mt-0.5 text-xs text-zinc-500 break-words">{{ detail }}</p>
        <div v-if="$slots.default" class="mt-3 space-y-2.5">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

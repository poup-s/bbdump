<script setup lang="ts">
/**
 * The mark of a database engine: a small tile in the engine's colour with its initials, the same
 * in the engine choice, the database list and the dialogs, so each engine is told apart at a glance.
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ engine: string; size?: 'sm' | 'md' }>(), { size: 'md' });

const MARKS: Record<string, { text: string; bg: string; fg: string }> = {
  postgresql: { text: 'PG', bg: '#336791', fg: '#ffffff' },
  mysql: { text: 'MY', bg: '#00758f', fg: '#ffffff' },
  mariadb: { text: 'MA', bg: '#7a5230', fg: '#ffffff' },
  mongodb: { text: 'MO', bg: '#13aa52', fg: '#ffffff' },
  sqlserver: { text: 'MS', bg: '#b8292f', fg: '#ffffff' },
  sqlite: { text: 'SL', bg: '#0f80cc', fg: '#ffffff' },
  duckdb: { text: 'DK', bg: '#f5d90a', fg: '#1a1a1a' },
};

const mark = computed(() => MARKS[props.engine] ?? { text: props.engine.slice(0, 2).toUpperCase(), bg: '#71717a', fg: '#ffffff' });
</script>

<template>
  <span
    class="inline-flex items-center justify-center shrink-0 font-mono font-semibold tracking-tight select-none"
    :class="size === 'sm' ? 'w-5 h-5 rounded text-[8.5px]' : 'w-9 h-9 rounded-lg text-[12px]'"
    :style="{ backgroundColor: mark.bg, color: mark.fg }"
    aria-hidden="true"
  >{{ mark.text }}</span>
</template>

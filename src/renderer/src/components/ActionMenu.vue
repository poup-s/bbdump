<script setup lang="ts">
/**
 * "⋯" button with a small action menu. The menu is teleported to <body> with fixed
 * positioning, so the scrolling lists it lives in never clip it; it opens upwards
 * when there is no room below. Closes on outside click, Escape, scroll and resize.
 */
import { nextTick, onBeforeUnmount, ref } from 'vue';

export interface ActionMenuItem {
  key: string;
  label: string;
  /** SVG path(s) for a 24×24 stroke icon */
  icon: string;
  tone?: 'default' | 'danger' | 'warning';
  /** Draws a separator above the item */
  separated?: boolean;
}

defineProps<{ items: ActionMenuItem[]; label: string }>();
const emit = defineEmits<{ (e: 'select', key: string): void }>();

const open = ref(false);
const button = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const position = ref({ top: 0, left: 0 });

const place = () => {
  const rect = button.value?.getBoundingClientRect();
  const panel = menu.value;
  if (!rect || !panel) return;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const below = rect.bottom + 4 + height <= window.innerHeight - 8;
  position.value = {
    top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height),
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
  };
};

const onOutside = (event: MouseEvent) => {
  const target = event.target as Node;
  if (menu.value?.contains(target) || button.value?.contains(target)) return;
  close();
};

const onKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    button.value?.focus();
  }
};

function close() {
  if (!open.value) return;
  open.value = false;
  window.removeEventListener('mousedown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('resize', close);
}

const toggle = async () => {
  if (open.value) return close();
  open.value = true;
  await nextTick();
  place();
  menu.value?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  window.addEventListener('mousedown', onOutside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
};

const choose = (key: string) => {
  close();
  emit('select', key);
};

onBeforeUnmount(close);
</script>

<template>
  <button
    ref="button"
    type="button"
    draggable="false"
    class="p-1 rounded-lg text-gray-400 hover:text-foreground hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
    :class="{ 'bg-gray-100 dark:bg-zinc-800 text-foreground': open }"
    :aria-label="label"
    :title="label"
    aria-haspopup="menu"
    :aria-expanded="open"
    @click.stop="toggle"
    @dragstart.prevent.stop
  >
    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      role="menu"
      class="fixed z-[300] min-w-[190px] py-1 rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg shadow-black/10"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <template v-for="item in items" :key="item.key">
        <div v-if="item.separated" class="my-1 border-t border-gray-100 dark:border-zinc-800" />
        <button
          type="button"
          role="menuitem"
          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors focus:outline-none"
          :class="item.tone === 'danger'
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 focus:bg-red-50 dark:focus:bg-red-500/10'
            : item.tone === 'warning'
              ? 'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-500/10 focus:bg-orange-50 dark:focus:bg-orange-500/10'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 focus:bg-gray-100 dark:focus:bg-zinc-800'"
          @click.stop="choose(item.key)"
        >
          <svg class="w-3.5 h-3.5 shrink-0 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
          </svg>
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script lang="ts">
/** Open dialogs, bottom to top: only the top one answers Escape and Enter. */
const openDialogs: symbol[] = [];
</script>

<script setup lang="ts">
/**
 * Dialog shell shared by the app dialogs, in the onboarding's language:
 * - header: icon, title, optional meta (e.g. "2 / 3"), close button;
 * - optional steps: progress bars with labels (multi-step flows);
 * - optional rail: sections on the left (long forms), one shown at a time;
 * - body (scrolls) and a footer slot.
 * Escape closes (unless busy); Enter emits `submit` outside buttons, selects, text areas and [data-own-enter].
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

export interface ModalSection {
  id: string;
  label: string;
  /** Small dot: something needs attention in this section */
  attention?: boolean;
  /** Number shown on the right (e.g. items in a category) */
  count?: number;
}

const props = withDefaults(defineProps<{
  title: string;
  /** 24×24 stroke icon path */
  icon?: string;
  meta?: string;
  steps?: string[];
  /** 0-based index of the current step */
  step?: number;
  sections?: ModalSection[];
  section?: string;
  width?: 'sm' | 'md' | 'lg';
  /** 'top': above everything (confirmations, also over the database viewer) */
  layer?: 'base' | 'top';
  /** Colour of the header icon */
  tone?: 'default' | 'danger' | 'warning';
  busy?: boolean;
  closeLabel?: string;
}>(), {
  icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
  meta: '',
  steps: () => [],
  step: 0,
  sections: () => [],
  section: '',
  width: 'md',
  layer: 'base',
  tone: 'default',
  busy: false,
  closeLabel: 'Close',
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submit'): void;
  (e: 'update:section', id: string): void;
}>();

const panel = ref<HTMLElement | null>(null);
const body = ref<HTMLElement | null>(null);
const hasRail = computed(() => props.sections.length > 0);

const id = Symbol('dialog');
const isTop = () => openDialogs[openDialogs.length - 1] === id;

const onKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || !isTop()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (!props.busy) emit('close');
    return;
  }
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target && target !== document.body && !panel.value?.contains(target)) return;
  // data-own-enter: a field whose Enter does its own thing (e.g. "Connect" next to it)
  if (target?.closest('button, a, select, textarea, summary, [role="radio"], [role="switch"], [data-own-enter]')) return;
  event.preventDefault();
  event.stopPropagation();
  emit('submit');
};

/** Back to the top of the body (new step / section), focus its first field */
const focusBody = () => {
  nextTick(() => {
    body.value?.scrollTo({ top: 0 });
    const first = body.value?.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([disabled]):not([readonly]), textarea');
    // No field: the dialog itself takes the focus, so Enter / Escape reach it and not the
    // button that opened it
    (first ?? panel.value)?.focus({ preventScroll: true });
  });
};

onMounted(() => {
  openDialogs.push(id);
  // Capture: the dialog answers before the page underneath (viewer shortcuts…)
  window.addEventListener('keydown', onKeydown, true);
  focusBody();
});
onBeforeUnmount(() => {
  const index = openDialogs.indexOf(id);
  if (index >= 0) openDialogs.splice(index, 1);
  window.removeEventListener('keydown', onKeydown, true);
});

defineExpose({ focusBody });
</script>

<template>
  <div class="app-modal fixed inset-0 flex items-center justify-center p-4 bg-black/40 dark:bg-black/60 backdrop-blur-[2px]" :class="layer === 'top' ? 'z-[500]' : 'z-50'">
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-label="title"
      class="app-modal-panel outline-none w-full flex flex-col max-h-[88vh] overflow-hidden rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-gray-900 dark:text-zinc-100 shadow-2xl shadow-black/20"
      :class="width === 'lg' ? 'max-w-[760px]' : width === 'sm' ? 'max-w-[420px]' : 'max-w-[540px]'"
      @click.stop
    >
      <!-- Header -->
      <header class="shrink-0 px-5 pt-4" :class="steps.length ? 'pb-0' : 'pb-4 border-b border-gray-100 dark:border-zinc-800'">
        <div class="flex items-center gap-3">
          <span
            class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center"
            :class="tone === 'danger'
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : tone === 'warning'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" :d="icon" />
            </svg>
          </span>
          <h2 class="text-sm font-semibold truncate">{{ title }}</h2>
          <span class="flex-1" />
          <span v-if="meta" class="font-mono text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums">{{ meta }}</span>
          <button
            type="button"
            class="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
            :disabled="busy"
            :aria-label="closeLabel"
            :title="closeLabel"
            @click="emit('close')"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Steps: the onboarding's progress bars -->
        <ol v-if="steps.length" class="mt-4 mb-1 grid gap-2" :style="{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }">
          <li v-for="(label, index) in steps" :key="label" :aria-current="index === step ? 'step' : undefined">
            <div class="h-[3px] rounded-full overflow-hidden bg-gray-100 dark:bg-zinc-800">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="index < step ? 'w-full bg-gray-400 dark:bg-zinc-500' : index === step ? 'w-full bg-emerald-500' : 'w-0'"
              />
            </div>
            <div
              class="mt-1.5 text-[11px] transition-colors"
              :class="index === step ? 'text-gray-900 dark:text-zinc-100' : index < step ? 'text-gray-500 dark:text-zinc-400' : 'text-gray-400 dark:text-zinc-600'"
            >{{ label }}</div>
          </li>
        </ol>
      </header>

      <div class="flex-1 min-h-0 flex">
        <!-- Rail: sections of a long form -->
        <nav v-if="hasRail" class="w-44 shrink-0 border-r border-gray-100 dark:border-zinc-800 p-3 flex flex-col gap-0.5 overflow-y-auto" :aria-label="title">
          <button
            v-for="item in sections"
            :key="item.id"
            type="button"
            class="relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg text-left text-[13px] transition-colors"
            :class="item.id === section
              ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 font-medium'
              : 'text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100 hover:bg-gray-50 dark:hover:bg-zinc-800/60'"
            :aria-current="item.id === section ? 'true' : undefined"
            @click="emit('update:section', item.id); focusBody()"
          >
            <span v-if="item.id === section" class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-emerald-500" />
            <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ item.label }}</span>
            <span v-if="item.attention" class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
            <span v-if="item.count !== undefined" class="shrink-0 font-mono text-[11px] tabular-nums text-gray-400 dark:text-zinc-500">{{ item.count }}</span>
          </button>
          <div class="flex-1" />
          <slot name="rail-footer" />
        </nav>

        <!-- Body -->
        <div ref="body" class="flex-1 min-w-0 overflow-y-auto px-6 py-5">
          <slot />
        </div>
      </div>

      <!-- Footer -->
      <footer class="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-gray-100 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-900">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.app-modal {
  animation: app-modal-fade 0.16s ease-out;
}
.app-modal-panel {
  animation: app-modal-rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes app-modal-fade {
  from { opacity: 0; }
}
@keyframes app-modal-rise {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
}
@media (prefers-reduced-motion: reduce) {
  .app-modal, .app-modal-panel { animation: none; }
}
</style>

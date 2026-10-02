<script setup lang="ts">
/**
 * Logs page. The log can hold tens of thousands of entries: only the rows on screen are
 * rendered (fixed row height), entries are plain objects (no deep reactivity), and live
 * mode only reads what was written since the last read. Clicking a row shows the whole
 * message (stack traces, pg_dump output) in the panel below.
 */
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { btnSecondary } from './ui/classes';

type Level = 'info' | 'warn' | 'error';
interface RawEntry { timestamp: string; level: Level; database?: string; message: string }
interface LogRead { entries: RawEntry[]; leading: string | null; offset: number; fileId: number; reset: boolean; path: string }

interface Entry {
  id: number;
  time: number;
  level: Level;
  database?: string;
  message: string;
  firstLine: string;
  extraLines: number;
  /** Lowercased message + database, computed once */
  search: string;
  day: string;
}
type Row = { kind: 'day'; key: string; label: string } | { kind: 'log'; key: number; entry: Entry };

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const ROW_HEIGHT = 28;
const OVERSCAN = 12;
const MAX_ENTRIES = 20000;
const LIVE_INTERVAL_MS = 2000;

const entries = shallowRef<Entry[]>([]); // oldest first
const isLoading = ref(true);
const logPath = ref('');
let cursor: { offset: number; fileId: number } | null = null;
let nextId = 1;

// --- Reading ----------------------------------------------------------------------

const dayKey = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const toEntry = (raw: RawEntry): Entry => {
  const time = Date.parse(raw.timestamp) || 0;
  const newline = raw.message.indexOf('\n');
  const firstLine = newline === -1 ? raw.message : raw.message.slice(0, newline);
  return {
    id: nextId++,
    time,
    level: raw.level,
    database: raw.database,
    message: raw.message,
    firstLine,
    extraLines: newline === -1 ? 0 : raw.message.split('\n').length - 1,
    search: `${raw.message}\n${raw.database ?? ''}`.toLowerCase(),
    day: dayKey(time),
  };
};

let reading = false;
const read = async (full = false) => {
  if (reading) return;
  reading = true;
  try {
    const result = await ipcRenderer.invoke('logs-read', full ? undefined : cursor ?? undefined) as LogRead;
    cursor = { offset: result.offset, fileId: result.fileId };
    logPath.value = result.path;
    if (result.reset) {
      entries.value = result.entries.map(toEntry);
      selectedId.value = null;
      return;
    }
    if (!result.entries.length && !result.leading) return;
    let list = entries.value;
    // The end of the last entry, written after the previous read
    if (result.leading && list.length) {
      const last = list[list.length - 1];
      list = [...list.slice(0, -1), toEntry({ timestamp: new Date(last.time).toISOString(), level: last.level, database: last.database, message: `${last.message}\n${result.leading}` })];
    }
    const added = result.entries.map(toEntry);
    list = [...list, ...added];
    if (list.length > MAX_ENTRIES) list = list.slice(list.length - MAX_ENTRIES);
    keepScrollPosition(() => { entries.value = list; });
  } catch (error) {
    addToast(t('toasts.logsLoadError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    reading = false;
    isLoading.value = false;
  }
};

// --- Live -------------------------------------------------------------------------

const live = ref(true);
let liveTimer: ReturnType<typeof setInterval> | null = null;
const startLive = () => {
  stopLive();
  if (live.value) liveTimer = setInterval(() => { if (!document.hidden) read(); }, LIVE_INTERVAL_MS);
};
const stopLive = () => { if (liveTimer) clearInterval(liveTimer); liveTimer = null; };
watch(live, (on) => {
  startLive();
  if (on) read(); // catch up at once
});
/** Back on the window: catch up without waiting for the next tick */
const onVisibility = () => { if (live.value && !document.hidden) read(); };

// --- Filters ----------------------------------------------------------------------

const level = ref<'all' | Level>('all');
const database = ref('all');
const query = ref('');
const appliedQuery = ref('');
let queryTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, (value) => {
  if (queryTimer) clearTimeout(queryTimer);
  queryTimer = setTimeout(() => { appliedQuery.value = value.trim().toLowerCase(); }, 150);
});

const databases = computed(() => {
  const names = new Set<string>();
  for (const e of entries.value) if (e.database) names.add(e.database);
  return [...names].sort();
});

/** Entries matching database and search, newest first (the level is applied after, for the counts) */
const matching = computed(() => {
  const q = appliedQuery.value;
  const db = database.value;
  const out: Entry[] = [];
  const list = entries.value;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (db !== 'all' && e.database !== db) continue;
    if (q && !e.search.includes(q)) continue;
    out.push(e);
  }
  return out;
});

const counts = computed(() => {
  const c = { all: matching.value.length, error: 0, warn: 0, info: 0 };
  for (const e of matching.value) c[e.level]++;
  return c;
});

const visibleEntries = computed(() => (level.value === 'all' ? matching.value : matching.value.filter(e => e.level === level.value)));
const filtersActive = computed(() => level.value !== 'all' || database.value !== 'all' || !!appliedQuery.value);

const dayLabel = (time: number) => {
  const today = new Date();
  const key = dayKey(time);
  if (key === dayKey(today.getTime())) return t('logs.today');
  if (key === dayKey(today.getTime() - 86400000)) return t('logs.yesterday');
  return new Intl.DateTimeFormat(currentLanguage.value, { weekday: 'long', day: 'numeric', month: 'long', year: new Date(time).getFullYear() === today.getFullYear() ? undefined : 'numeric' }).format(time);
};

/** Entries with a separator at each new day */
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  let day = '';
  for (const entry of visibleEntries.value) {
    if (entry.day !== day) {
      day = entry.day;
      out.push({ kind: 'day', key: `d-${day}`, label: dayLabel(entry.time) });
    }
    out.push({ kind: 'log', key: entry.id, entry });
  }
  return out;
});

// --- Virtual list -----------------------------------------------------------------

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
let frame = 0;
const onScroll = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    scrollTop.value = scroller.value?.scrollTop ?? 0;
    if (scrollTop.value < ROW_HEIGHT) newSinceScroll.value = 0;
  });
};
let resizeObserver: ResizeObserver | null = null;

const range = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
});
const shownRows = computed(() => rows.value.slice(range.value.start, range.value.end));

/** New entries go on top: a reader scrolled down stays on the same lines */
const newSinceScroll = ref(0);
const keepScrollPosition = (update: () => void) => {
  const el = scroller.value;
  const before = rows.value.length;
  update();
  if (!el || el.scrollTop < ROW_HEIGHT) return;
  nextTick(() => {
    const added = rows.value.length - before;
    if (added > 0) {
      el.scrollTop += added * ROW_HEIGHT;
      newSinceScroll.value += added;
    }
  });
};
const scrollToTop = () => {
  scroller.value?.scrollTo({ top: 0 });
  newSinceScroll.value = 0;
};
watch([level, database, appliedQuery], () => { scroller.value?.scrollTo({ top: 0 }); });

// --- Selection --------------------------------------------------------------------

const selectedId = ref<number | null>(null);
const selected = computed(() => (selectedId.value === null ? null : entries.value.find(e => e.id === selectedId.value) ?? null));

const select = (entry: Entry) => { selectedId.value = selectedId.value === entry.id ? null : entry.id; };

/** ↑ ↓ go from entry to entry, Escape closes the detail */
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') { selectedId.value = null; return; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const list = rows.value;
  const current = list.findIndex(r => r.kind === 'log' && r.entry.id === selectedId.value);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  let i = current === -1 ? (step === 1 ? -1 : list.length) : current;
  do { i += step; } while (i >= 0 && i < list.length && list[i].kind !== 'log');
  const row = list[i];
  if (!row || row.kind !== 'log') return;
  selectedId.value = row.entry.id;
  const el = scroller.value;
  if (!el) return;
  const top = i * ROW_HEIGHT;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
};

// --- Text -------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (time: number) => {
  const d = new Date(time);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fullDate = (time: number) => new Intl.DateTimeFormat(currentLanguage.value, {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
} as Intl.DateTimeFormatOptions).format(time);

/** The search term highlighted in the visible text */
const highlight = (text: string) => {
  const q = appliedQuery.value;
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, from)) {
    if (i > from) parts.push({ text: text.slice(from, i), hit: false });
    parts.push({ text: text.slice(i, i + q.length), hit: true });
    from = i + q.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
};

const asText = (e: Entry) => `[${new Date(e.time).toISOString()}] [${e.level.toUpperCase()}]${e.database ? ` [${e.database}]` : ''} ${e.message}`;

const copyEntry = async (entry: Entry) => {
  try {
    await navigator.clipboard.writeText(asText(entry));
    addToast(t('logs.copied'), 'success');
  } catch {
    addToast(t('logs.copyError'), 'error');
  }
};

const copyShown = async () => {
  try {
    // Oldest first, like the file
    await navigator.clipboard.writeText([...visibleEntries.value].reverse().map(asText).join('\n'));
    addToast(t('logs.allCopied', { count: visibleEntries.value.length }), 'success');
  } catch {
    addToast(t('logs.copyError'), 'error');
  }
};

const isMac = navigator.userAgent.includes('Mac');
const reveal = () => { if (logPath.value) ipcRenderer.invoke('show-item-in-folder', logPath.value); };

const clearLogs = () => {
  showConfirm({
    title: t('logs.clearConfirmTitle'),
    message: t('logs.clearConfirm'),
    confirmText: t('logs.clear'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('clear-logs');
        await read(true);
        addToast(t('toasts.logsCleared'), 'success');
      } catch (error) {
        addToast(t('toasts.logsClearError'), 'error', { detail: getErrorMessage(error) });
      }
    },
  });
};

const resetFilters = () => {
  level.value = 'all';
  database.value = 'all';
  query.value = '';
  appliedQuery.value = '';
};

const LEVELS = computed(() => [
  { value: 'all' as const, label: t('logs.levels.all'), count: counts.value.all, dot: '' },
  { value: 'error' as const, label: t('logs.levels.error'), count: counts.value.error, dot: 'bg-red-500' },
  { value: 'warn' as const, label: t('logs.levels.warn'), count: counts.value.warn, dot: 'bg-amber-500' },
  { value: 'info' as const, label: t('logs.levels.info'), count: counts.value.info, dot: 'bg-gray-400 dark:bg-zinc-500' },
]);

const levelText: Record<Level, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-gray-400 dark:text-zinc-500',
};

onMounted(async () => {
  if (scroller.value) {
    viewportHeight.value = scroller.value.clientHeight;
    resizeObserver = new ResizeObserver(() => { viewportHeight.value = scroller.value?.clientHeight ?? viewportHeight.value; });
    resizeObserver.observe(scroller.value);
  }
  await read(true);
  startLive();
  document.addEventListener('visibilitychange', onVisibility);
});
onUnmounted(() => {
  stopLive();
  document.removeEventListener('visibilitychange', onVisibility);
  resizeObserver?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  if (queryTimer) clearTimeout(queryTimer);
});
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4 mb-3 shrink-0">
      <div>
        <h2 class="text-lg font-bold tracking-tight">{{ t('nav.logs') }}</h2>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 tabular-nums">
          {{ filtersActive
            ? t('logs.countFiltered', { shown: visibleEntries.length.toLocaleString(currentLanguage), total: entries.length.toLocaleString(currentLanguage) })
            : t('logs.count', { count: entries.length.toLocaleString(currentLanguage) }) }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          :aria-checked="live"
          class="inline-flex items-center gap-2 h-8 px-3 rounded-lg border text-[12.5px] font-medium transition-colors"
          :class="live
            ? 'border-emerald-200 dark:border-emerald-900/70 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
            : 'border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400 hover:bg-gray-50 dark:hover:bg-zinc-800/50'"
          :title="t('logs.liveHint')"
          @click="live = !live"
        >
          <span class="relative flex w-2 h-2">
            <span v-if="live" class="absolute inset-0 rounded-full bg-emerald-500 opacity-60 animate-ping" />
            <span class="relative w-2 h-2 rounded-full" :class="live ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-zinc-600'" />
          </span>
          {{ t('logs.live') }}
        </button>
        <button type="button" :class="btnSecondary" :disabled="!visibleEntries.length" @click="copyShown">{{ filtersActive ? t('logs.copyShown') : t('logs.copyAll') }}</button>
        <button type="button" :class="btnSecondary" :disabled="!logPath" @click="reveal">{{ isMac ? t('about.showInFinder') : t('about.showInFolder') }}</button>
        <button
          type="button"
          class="h-8 px-3 rounded-lg text-[12.5px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-40"
          :disabled="!entries.length"
          @click="clearLogs"
        >{{ t('logs.clear') }}</button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex flex-col rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-zinc-800 shrink-0">
        <div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-zinc-800/70" role="radiogroup" :aria-label="t('logs.filterLevel')">
          <button
            v-for="l in LEVELS"
            :key="l.value"
            type="button"
            role="radio"
            :aria-checked="level === l.value"
            class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] transition-colors"
            :class="level === l.value ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'"
            @click="level = l.value"
          >
            <span v-if="l.dot" class="w-1.5 h-1.5 rounded-full" :class="l.dot" />
            {{ l.label }}
            <span class="font-mono text-[10.5px] tabular-nums text-gray-400 dark:text-zinc-500">{{ l.count.toLocaleString(currentLanguage) }}</span>
          </button>
        </div>

        <select
          v-model="database"
          :aria-label="t('logs.filterDatabase')"
          class="h-8 max-w-[200px] bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg px-2 text-[12.5px] text-gray-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
        >
          <option value="all">{{ t('logs.allDatabases') }}</option>
          <option v-for="db in databases" :key="db" :value="db">{{ db }}</option>
        </select>

        <div class="relative flex-1 min-w-[180px]">
          <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            v-model="query"
            type="search"
            spellcheck="false"
            :placeholder="t('logs.searchPlaceholder')"
            :aria-label="t('logs.search')"
            class="w-full h-8 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg pl-8 pr-2 text-[12.5px] text-gray-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </div>
      </div>

      <!-- Entries -->
      <div class="relative flex-1 min-h-0">
        <button
          v-if="newSinceScroll > 0"
          type="button"
          class="absolute top-2 left-1/2 -translate-x-1/2 z-10 h-7 px-3 rounded-full bg-gray-900 dark:bg-white text-white dark:text-zinc-900 text-[12px] font-medium shadow-lg"
          @click="scrollToTop"
        >↑ {{ t('logs.newEntries', { count: newSinceScroll }) }}</button>

        <div
          ref="scroller"
          class="h-full overflow-y-auto focus:outline-none"
          tabindex="0"
          :aria-label="t('nav.logs')"
          @scroll.passive="onScroll"
          @keydown="onKeydown"
        >
          <div v-if="isLoading" class="h-full grid place-items-center text-[12.5px] text-gray-400">{{ t('logs.loading') }}</div>

          <div v-else-if="!rows.length" class="h-full flex flex-col items-center justify-center gap-2 p-8 text-center">
            <p class="text-[13px] font-medium text-gray-600 dark:text-zinc-300">{{ entries.length ? t('logs.noMatch') : t('logs.noLogs') }}</p>
            <p class="text-[12px] text-gray-400 dark:text-zinc-500">{{ entries.length ? t('logs.noMatchHint') : t('logs.noLogsHint') }}</p>
            <button v-if="filtersActive" type="button" :class="btnSecondary" class="mt-1" @click="resetFilters">{{ t('logs.resetFilters') }}</button>
          </div>

          <div v-else :style="{ height: `${rows.length * ROW_HEIGHT}px` }" class="relative">
            <div :style="{ transform: `translateY(${range.start * ROW_HEIGHT}px)` }" class="absolute inset-x-0 top-0">
              <template v-for="row in shownRows" :key="row.key">
                <div
                  v-if="row.kind === 'day'"
                  class="flex items-end px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-zinc-500 bg-gray-50/80 dark:bg-zinc-800/30 border-b border-gray-100 dark:border-zinc-800"
                  :style="{ height: `${ROW_HEIGHT}px` }"
                >{{ row.label }}</div>
                <div
                  v-else
                  class="group grid grid-cols-[62px_44px_minmax(0,1fr)_auto] items-center gap-2 px-3 font-mono text-[12px] cursor-pointer border-l-2"
                  :class="[
                    selectedId === row.entry.id ? 'bg-emerald-50 dark:bg-emerald-950/25 border-l-emerald-500' : 'hover:bg-gray-50 dark:hover:bg-zinc-800/40',
                    selectedId !== row.entry.id && row.entry.level === 'error' ? 'border-l-red-500 bg-red-50/40 dark:bg-red-950/10' : '',
                    selectedId !== row.entry.id && row.entry.level === 'warn' ? 'border-l-amber-400' : '',
                    selectedId !== row.entry.id && row.entry.level === 'info' ? 'border-l-transparent' : '',
                  ]"
                  :style="{ height: `${ROW_HEIGHT}px` }"
                  @click="select(row.entry)"
                >
                  <span class="text-gray-400 dark:text-zinc-500 tabular-nums">{{ clock(row.entry.time) }}</span>
                  <span class="text-[10.5px] font-semibold uppercase" :class="levelText[row.entry.level]">{{ row.entry.level === 'error' ? 'err' : row.entry.level }}</span>
                  <span class="truncate text-gray-800 dark:text-zinc-200">
                    <span v-if="row.entry.database" class="mr-1.5 px-1.5 py-px rounded bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 text-[11px]">{{ row.entry.database }}</span>
                    <template v-for="(part, i) in highlight(row.entry.firstLine)" :key="i"><mark v-if="part.hit" class="bg-amber-200/80 dark:bg-amber-500/30 text-inherit rounded-sm">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
                  </span>
                  <span v-if="row.entry.extraLines" class="text-[10.5px] text-gray-400 dark:text-zinc-500 whitespace-nowrap">{{ row.entry.extraLines === 1 ? t('logs.moreLine') : t('logs.moreLines', { count: row.entry.extraLines }) }}</span>
                  <span v-else />
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Detail -->
      <div v-if="selected" class="shrink-0 h-[38%] min-h-[150px] flex flex-col border-t border-gray-200 dark:border-zinc-800 bg-gray-50/60 dark:bg-zinc-950/40">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-zinc-800">
          <span class="text-[10.5px] font-semibold uppercase font-mono" :class="levelText[selected.level]">{{ selected.level }}</span>
          <span v-if="selected.database" class="px-1.5 py-px rounded bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 font-mono text-[11px]">{{ selected.database }}</span>
          <span class="text-[12px] text-gray-500 dark:text-zinc-400">{{ fullDate(selected.time) }}</span>
          <div class="ml-auto flex items-center gap-1">
            <button type="button" class="h-7 px-2.5 rounded-md text-[12px] font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800" @click="copyEntry(selected)">{{ t('logs.copy') }}</button>
            <button type="button" class="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800" :aria-label="t('common.close')" @click="selectedId = null">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <pre class="flex-1 min-h-0 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-gray-800 dark:text-zinc-200 whitespace-pre-wrap break-words select-text"><template v-for="(part, i) in highlight(selected.message)" :key="i"><mark v-if="part.hit" class="bg-amber-200/80 dark:bg-amber-500/30 text-inherit rounded-sm">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
      </div>
    </div>
  </div>
</template>

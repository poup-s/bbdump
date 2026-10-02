<script setup lang="ts">
/**
 * Home page: four cards that say how backups are doing (real status, databases, last and
 * next backup, storage), above the 3D scene. The header (52 px) and the card row (114 px)
 * keep fixed heights so the scene stays exactly where it was.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import { getErrorMessage } from '../utils';
import { relative, formatBytes } from '../timeText';
import Dashboard3DScene from './Dashboard3DScene.vue';

interface Run { at: string; success: boolean; error?: string }
interface Overview {
  id: string;
  cron: string;
  cronValid: boolean;
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  missed: boolean;
  lastBackup: string | null;
  runs: Run[];
  backupCount: number;
  backupSize: number;
}

const { t, currentLanguage } = useI18n();

const overview = ref<Overview[]>([]);
const launchAtLogin = ref(true);
const isLoading = ref(false);
const now = ref(Date.now());

const load = async () => {
  isLoading.value = true;
  try {
    const result = await ipcRenderer.invoke('schedule-overview') as { databases: Overview[]; launchAtLogin: boolean };
    overview.value = result.databases;
    launchAtLogin.value = result.launchAtLogin;
    now.value = Date.now();
  } catch (error) {
    console.error('Dashboard:', getErrorMessage(error));
  } finally {
    isLoading.value = false;
  }
};

const nameOf = (id: string) => { const db = store.databases.find(d => d.id === id); return db ? db.displayName || db.name : id; };
const known = computed(() => overview.value.filter(o => store.databases.some(d => d.id === o.id)));
const scheduled = computed(() => known.value.filter(o => o.enabled && o.cron && o.cronValid));

// --- Status: the most serious thing first ------------------------------------------

type Tone = 'ok' | 'warn' | 'error' | 'idle';
const status = computed<{ tone: Tone; title: string; detail: string; tab: string }>(() => {
  const failing = known.value.filter(o => o.runs[0] && !o.runs[0].success);
  if (failing.length) {
    return {
      tone: 'error',
      title: t('home.status.failing', { count: failing.length }),
      detail: failing.map(o => nameOf(o.id)).join(', '),
      tab: 'tasks',
    };
  }
  const missed = scheduled.value.filter(o => o.missed);
  if (missed.length) return { tone: 'warn', title: t('home.status.missed', { count: missed.length }), detail: missed.map(o => nameOf(o.id)).join(', '), tab: 'tasks' };
  const invalid = known.value.filter(o => o.enabled && o.cron && !o.cronValid);
  if (invalid.length) return { tone: 'warn', title: t('home.status.invalid'), detail: invalid.map(o => nameOf(o.id)).join(', '), tab: 'tasks' };
  if (!scheduled.value.length) return { tone: 'idle', title: t('home.status.noSchedule'), detail: t('home.status.noScheduleHint'), tab: 'tasks' };
  if (!launchAtLogin.value) return { tone: 'warn', title: t('home.status.notAtLogin'), detail: t('home.status.notAtLoginHint'), tab: 'tasks' };
  return { tone: 'ok', title: t('home.status.ok'), detail: t('home.status.okDetail', { count: scheduled.value.length }), tab: 'tasks' };
});
const toneClasses: Record<Tone, { card: string; dot: string; title: string }> = {
  ok: { card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/50', dot: 'bg-emerald-500', title: 'text-emerald-800 dark:text-emerald-300' },
  warn: { card: 'bg-amber-50 dark:bg-amber-950/25 border-amber-200 dark:border-amber-900/50', dot: 'bg-amber-500', title: 'text-amber-900 dark:text-amber-200' },
  error: { card: 'bg-red-50 dark:bg-red-950/25 border-red-200 dark:border-red-900/50', dot: 'bg-red-500', title: 'text-red-800 dark:text-red-300' },
  idle: { card: 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-zinc-800', dot: 'bg-gray-300 dark:bg-zinc-600', title: 'text-gray-900 dark:text-white' },
};

// --- Databases ----------------------------------------------------------------------

const localCount = computed(() => store.databases.filter(db => db.isLocalBbdump).length);
const remoteCount = computed(() => store.databases.length - localCount.value);

// --- Last and next backup ------------------------------------------------------------

const last = computed(() => {
  let best: { id: string; at: number; success: boolean } | null = null;
  for (const o of known.value) {
    const run = o.runs[0];
    const at = run ? new Date(run.at).getTime() : o.lastBackup ? new Date(o.lastBackup).getTime() : 0;
    if (at && (!best || at > best.at)) best = { id: o.id, at, success: run ? run.success : true };
  }
  return best;
});
const next = computed(() => scheduled.value
  .filter(o => o.nextRun)
  .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!))[0] ?? null);
const running = computed(() => known.value.find(o => o.running) ?? null);

// --- Storage -------------------------------------------------------------------------

const totalSize = computed(() => overview.value.reduce((sum, o) => sum + o.backupSize, 0));
const totalFiles = computed(() => overview.value.reduce((sum, o) => sum + o.backupCount, 0));
const databasesWithFiles = computed(() => overview.value.filter(o => o.backupCount > 0).length);
/** The database whose backups take the most room */
const biggest = computed(() => {
  const top = [...overview.value].sort((a, b) => b.backupSize - a.backupSize)[0];
  return top && top.backupSize > 0 ? { name: nameOf(top.id), size: top.backupSize } : null;
});

const goTo = (tab: string) => { store.activeTab = tab; };

// --- Refresh -------------------------------------------------------------------------

const unsubscribers: Array<() => void> = [];
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
const refreshSoon = () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 300);
};

onMounted(() => {
  load();
  for (const channel of ['backup-started', 'backup-complete', 'scheduled-backup-started', 'scheduled-backup-completed']) {
    const off = ipcRenderer.on(channel, refreshSoon) as unknown;
    if (typeof off === 'function') unsubscribers.push(off as () => void);
  }
  clock = setInterval(load, 60000);
});
onUnmounted(() => {
  unsubscribers.forEach(off => off());
  if (refreshTimer) clearTimeout(refreshTimer);
  if (clock) clearInterval(clock);
});

const card = 'h-[114px] rounded-xl px-5 py-4 border text-left flex flex-col min-w-0 transition-colors';
const plainCard = `${card} bg-white dark:bg-zinc-900 border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700`;
const label = 'text-[11px] font-medium text-gray-500 dark:text-zinc-400';
</script>

<template>
  <div class="h-full flex flex-col gap-6">
    <!-- Header: 52 px, as before -->
    <div class="h-[52px] shrink-0 flex justify-between items-center">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white leading-tight">{{ t('dashboard.title') }}</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 truncate">{{ t('home.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="p-2.5 rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        :aria-label="t('common.refresh')"
        :title="t('common.refresh')"
        @click="load"
      >
        <svg class="w-4 h-4" :class="{ 'animate-spin': isLoading }" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>

    <!-- Cards: 114 px each, as before -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
      <!-- Status -->
      <button type="button" :class="[card, toneClasses[status.tone].card]" @click="goTo(status.tab)">
        <span class="flex items-center gap-2" :class="label">
          <span class="relative flex w-2 h-2">
            <span v-if="status.tone === 'error' || running" class="absolute inset-0 rounded-full opacity-60 animate-ping" :class="running ? 'bg-sky-500' : toneClasses[status.tone].dot" />
            <span class="relative w-2 h-2 rounded-full" :class="running ? 'bg-sky-500' : toneClasses[status.tone].dot" />
          </span>
          {{ t('home.status.label') }}
        </span>
        <template v-if="running">
          <span class="mt-1.5 text-[17px] font-semibold leading-snug text-sky-700 dark:text-sky-300 truncate">{{ t('home.status.running') }}</span>
          <span class="mt-auto text-[12px] text-gray-500 dark:text-zinc-400 truncate">{{ nameOf(running.id) }}</span>
        </template>
        <template v-else>
          <span class="mt-1.5 text-[15px] font-semibold leading-tight line-clamp-2" :class="toneClasses[status.tone].title">{{ status.title }}</span>
          <span class="mt-auto text-[12px] text-gray-500 dark:text-zinc-400 truncate" :title="status.detail">{{ status.detail }}</span>
        </template>
      </button>

      <!-- Databases -->
      <button type="button" :class="plainCard" @click="goTo('databases')">
        <span :class="label">{{ t('home.databases.label') }}</span>
        <span class="mt-1 text-[26px] font-semibold leading-none tabular-nums text-gray-900 dark:text-white">{{ store.databases.length }}</span>
        <span class="mt-auto text-[12px] text-gray-500 dark:text-zinc-400 truncate">
          {{ t('home.databases.split', { local: localCount, remote: remoteCount }) }}
        </span>
        <span class="text-[12px] text-gray-400 dark:text-zinc-500 truncate">{{ t('home.databases.scheduled', { count: scheduled.length }) }}</span>
      </button>

      <!-- Last / next backup -->
      <button type="button" :class="plainCard" @click="goTo(next ? 'tasks' : 'backups')">
        <span :class="label">{{ t('home.last.label') }}</span>
        <template v-if="last">
          <span class="mt-1 flex items-baseline gap-2 min-w-0">
            <span class="text-[17px] font-semibold truncate" :class="last.success ? 'text-gray-900 dark:text-white' : 'text-red-700 dark:text-red-400'">{{ nameOf(last.id) }}</span>
            <span class="shrink-0 text-[12px] text-gray-500 dark:text-zinc-400">{{ relative(last.at, now, currentLanguage, t) }}</span>
          </span>
          <span v-if="!last.success" class="text-[12px] text-red-600 dark:text-red-400">{{ t('tasks.run.failed') }}</span>
        </template>
        <span v-else class="mt-1 text-[15px] font-medium text-gray-500 dark:text-zinc-400">{{ t('home.last.none') }}</span>
        <span class="mt-auto text-[12px] text-gray-500 dark:text-zinc-400 truncate">
          <template v-if="next?.nextRun">{{ t('home.last.next', { name: nameOf(next.id), when: relative(new Date(next.nextRun).getTime(), now, currentLanguage, t) }) }}</template>
          <template v-else>{{ t('home.last.noNext') }}</template>
        </span>
      </button>

      <!-- Storage -->
      <button type="button" :class="plainCard" @click="goTo('backups')">
        <span :class="label">{{ t('home.storage.label') }}</span>
        <span class="mt-1 text-[26px] font-semibold leading-none tabular-nums text-gray-900 dark:text-white">{{ formatBytes(totalSize, currentLanguage) }}</span>
        <span class="mt-auto text-[12px] text-gray-500 dark:text-zinc-400 truncate">
          {{ t('home.storage.files', { count: totalFiles, databases: databasesWithFiles }) }}
        </span>
        <span v-if="biggest && databasesWithFiles > 1" class="text-[12px] text-gray-400 dark:text-zinc-500 truncate">
          {{ t('home.storage.biggest', { name: biggest.name, size: formatBytes(biggest.size, currentLanguage) }) }}
        </span>
      </button>
    </div>

    <!-- 3D scene: the rest of the height, unchanged -->
    <div class="flex-1 min-h-0">
      <Dashboard3DScene />
    </div>
  </div>
</template>

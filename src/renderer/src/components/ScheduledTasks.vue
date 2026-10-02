<script setup lang="ts">
/**
 * Tasks page: every database with a schedule, paused ones included, in the order they
 * will run. For each: the schedule in words, the next run, the last runs (failures too,
 * from the backup history), and run now / pause / edit. Databases without a schedule
 * are listed below, one click from getting one.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { getErrorMessage } from '../utils';
import { describeCron } from '../cronText';
import { relative, dayAndTime, formatBytes, formatDuration } from '../timeText';
import { btnSecondary } from './ui/classes';

interface Run { at: string; success: boolean; trigger: 'manual' | 'scheduled' | 'catch-up'; durationMs: number; size?: number; error?: string }
interface Overview {
  id: string;
  cron: string;
  cronValid: boolean;
  enabled: boolean;
  scheduled: boolean;
  running: boolean;
  nextRun: string | null;
  missed: boolean;
  lastBackup: string | null;
  runs: Run[];
  retentionCount: number | null;
  verifyBackups: boolean;
  encryptBackups: boolean;
  backupCount: number;
  backupSize: number;
}

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();

const overview = ref<Overview[]>([]);
const launchAtLogin = ref(true);
const loaded = ref(false);
const now = ref(Date.now());

const load = async () => {
  try {
    const result = await ipcRenderer.invoke('schedule-overview') as { databases: Overview[]; launchAtLogin: boolean };
    overview.value = result.databases;
    launchAtLogin.value = result.launchAtLogin;
    now.value = Date.now();
  } catch (error) {
    console.error('Tasks page:', getErrorMessage(error));
  } finally {
    loaded.value = true;
  }
};

const dbOf = (id: string) => store.databases.find(d => d.id === id);
const nameOf = (id: string) => { const db = dbOf(id); return db ? db.displayName || db.name : id; };

/**
 * Running schedules, in run order (an invalid one last). A database whose automatic
 * backups are off is listed apart: new databases get a schedule switched off, so
 * "paused" and "never scheduled" look the same and are shown the same way.
 */
const tasks = computed(() => overview.value
  .filter(o => o.cron && o.enabled && dbOf(o.id))
  .sort((a, b) => {
    if (a.cronValid !== b.cronValid) return a.cronValid ? -1 : 1;
    if (a.nextRun && b.nextRun) return a.nextRun.localeCompare(b.nextRun);
    return nameOf(a.id).localeCompare(nameOf(b.id));
  }));
const inactive = computed(() => overview.value
  .filter(o => !(o.cron && o.enabled) && dbOf(o.id))
  .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id))));

const nextTask = computed(() => tasks.value.find(o => o.nextRun));
const counts = computed(() => ({
  active: tasks.value.filter(o => o.cronValid).length,
  inactive: inactive.value.length,
  failing: tasks.value.filter(o => o.runs[0] && !o.runs[0].success).length,
}));

const when = (o: Overview) => describeCron(o.cron, t, currentLanguage.value);
const at = (iso: string) => new Date(iso).getTime();
const lastRun = (o: Overview): Run | null => o.runs[0] ?? (o.lastBackup ? { at: o.lastBackup, success: true, trigger: 'manual', durationMs: 0 } : null);

/** Oldest to newest, for the strip of runs */
const strip = (o: Overview) => [...o.runs].slice(0, 12).reverse();
const runTitle = (run: Run) => [
  dayAndTime(at(run.at), now.value, currentLanguage.value, t),
  run.success ? t('tasks.run.ok') : t('tasks.run.failed'),
  t(`tasks.trigger.${run.trigger}`),
  run.durationMs ? formatDuration(run.durationMs, currentLanguage.value) : '',
  run.size ? formatBytes(run.size, currentLanguage.value) : '',
  run.error ?? '',
].filter(Boolean).join(' · ');

// --- Actions ----------------------------------------------------------------------

const runNow = async (o: Overview) => {
  if (o.running) return;
  o.running = true;
  try {
    // backup-started / backup-complete show the toasts and refresh this page
    await ipcRenderer.invoke('backup-now', o.id);
  } catch (error) {
    addToast(t('toasts.backupStartError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    load();
  }
};

const togglePause = async (o: Overview) => {
  try {
    const config = await ipcRenderer.invoke('toggle-schedule', o.id, !o.enabled);
    store.databases = config.databases;
    addToast(o.enabled ? t('tasks.pausedToast', { name: nameOf(o.id) }) : t('tasks.resumedToast', { name: nameOf(o.id) }), 'success');
    await load();
  } catch (error) {
    addToast(t('toasts.settingsSaveError'), 'error', { detail: getErrorMessage(error) });
  }
};

const editSchedule = (id: string) => {
  const db = dbOf(id);
  if (!db) return;
  store.editingDatabase = JSON.parse(JSON.stringify(db));
  store.modalTargetSection = 'schedule';
  store.showDatabaseModal = true;
};

const enableLaunchAtLogin = async () => {
  try {
    await ipcRenderer.invoke('save-settings', { launchAtLogin: true });
    launchAtLogin.value = true;
    addToast(t('toasts.settingsSaved'), 'success');
  } catch (error) {
    addToast(t('toasts.settingsSaveError'), 'error', { detail: getErrorMessage(error) });
  }
};

// --- Refresh ----------------------------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const refreshSoon = () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 300);
};
const unsubscribers: Array<() => void> = [];
let clock: ReturnType<typeof setInterval> | null = null;

// The schedule may have changed in the database dialog
watch(() => store.showDatabaseModal, (open, wasOpen) => { if (!open && wasOpen) load(); });

onMounted(() => {
  load();
  for (const channel of ['backup-started', 'backup-complete', 'scheduled-backup-started', 'scheduled-backup-completed']) {
    const off = ipcRenderer.on(channel, refreshSoon) as unknown;
    if (typeof off === 'function') unsubscribers.push(off as () => void);
  }
  // Relative times ("in 3 h") and next runs move on
  clock = setInterval(load, 30000);
});
onUnmounted(() => {
  unsubscribers.forEach(off => off());
  if (clock) clearInterval(clock);
  if (refreshTimer) clearTimeout(refreshTimer);
});

const card = 'bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-800';
const sectionTitle = 'text-[10px] font-bold text-gray-400 uppercase tracking-wider';
const chip = 'text-[10.5px] px-1.5 py-px rounded border border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400';
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="mb-4 shrink-0">
      <h2 class="text-lg font-bold tracking-tight">{{ t('scheduled.title') }}</h2>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ t('tasks.description') }}</p>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto space-y-4 pb-6">
      <!-- Runs only while bbdump is open -->
      <div
        v-if="loaded && !launchAtLogin && counts.active > 0"
        class="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/25"
      >
        <p class="flex-1 text-[12.5px] leading-snug text-amber-900 dark:text-amber-200">{{ t('tasks.launchAtLoginHint') }}</p>
        <button type="button" :class="btnSecondary" class="shrink-0" @click="enableLaunchAtLogin">{{ t('tasks.enableLaunchAtLogin') }}</button>
      </div>

      <!-- Summary -->
      <div v-if="tasks.length || inactive.length" class="grid grid-cols-2 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] gap-3">
        <div :class="card" class="col-span-2 md:col-span-1 px-4 py-3">
          <div :class="sectionTitle">{{ t('tasks.next') }}</div>
          <template v-if="nextTask?.nextRun">
            <div class="mt-1 flex items-baseline gap-2 min-w-0">
              <span class="text-[15px] font-semibold truncate">{{ nameOf(nextTask.id) }}</span>
              <span class="text-[13px] text-gray-500 dark:text-zinc-400 whitespace-nowrap">{{ relative(at(nextTask.nextRun), now, currentLanguage, t) }}</span>
            </div>
            <div class="text-[12px] text-gray-400 dark:text-zinc-500">{{ dayAndTime(at(nextTask.nextRun), now, currentLanguage, t) }}</div>
          </template>
          <div v-else class="mt-1 text-[13px] text-gray-500 dark:text-zinc-400">{{ t('tasks.nothingPlanned') }}</div>
        </div>
        <div v-for="item in [
          { label: t('tasks.countActive'), value: counts.active, tone: 'text-emerald-600 dark:text-emerald-400' },
          { label: t('tasks.countOff'), value: counts.inactive, tone: 'text-gray-500 dark:text-zinc-400' },
          { label: t('tasks.countFailing'), value: counts.failing, tone: counts.failing ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-zinc-400' },
        ]" :key="item.label" :class="card" class="px-4 py-3">
          <div :class="sectionTitle">{{ item.label }}</div>
          <div class="mt-1 text-[22px] font-semibold tabular-nums leading-tight" :class="item.tone">{{ item.value }}</div>
        </div>
      </div>

      <!-- Scheduled -->
      <div v-if="tasks.length" :class="card" class="overflow-hidden">
        <div
          v-for="(o, index) in tasks"
          :key="o.id"
          class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_auto] gap-x-5 gap-y-2 items-center px-4 py-3.5"
          :class="index ? 'border-t border-gray-100 dark:border-zinc-800' : ''"
        >
          <!-- Database and schedule -->
          <div class="min-w-0" :class="!o.enabled ? 'opacity-60' : ''">
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="o.running ? 'bg-sky-500 animate-pulse' : !o.cronValid ? 'bg-red-500' : !o.enabled ? 'bg-gray-300 dark:bg-zinc-600' : o.runs[0] && !o.runs[0].success ? 'bg-red-500' : 'bg-emerald-500'"
                aria-hidden="true"
              />
              <span class="text-[14px] font-medium truncate">{{ nameOf(o.id) }}</span>
            </div>
            <div class="mt-0.5 pl-4 flex items-center gap-2 min-w-0">
              <span class="text-[12.5px] text-gray-600 dark:text-zinc-300 truncate">{{ !o.cronValid ? t('tasks.invalidSchedule') : when(o) ?? t('tasks.customSchedule') }}</span>
              <code class="shrink-0 font-mono text-[10.5px] px-1.5 py-px rounded bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400">{{ o.cron }}</code>
            </div>
            <div class="mt-1.5 pl-4 flex flex-wrap gap-1.5">
              <span :class="chip">{{ o.retentionCount === 1 ? t('tasks.keepsOne') : o.retentionCount ? t('tasks.keeps', { count: o.retentionCount }) : t('tasks.keepsAll') }}</span>
              <span v-if="o.verifyBackups" :class="chip">{{ t('tasks.verified') }}</span>
              <span v-if="o.encryptBackups" :class="chip">{{ t('tasks.encrypted') }}</span>
            </div>
          </div>

          <!-- Next run -->
          <div class="min-w-0 pl-4 lg:pl-0">
            <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider lg:hidden">{{ t('tasks.next') }}</div>
            <div v-if="o.running" class="text-[13px] font-medium text-sky-600 dark:text-sky-400">{{ t('tasks.running') }}</div>
            <div v-else-if="!o.enabled" class="text-[13px] text-gray-500 dark:text-zinc-400">{{ t('scheduled.paused') }}</div>
            <template v-else-if="o.nextRun">
              <div class="text-[13px] font-medium">{{ relative(at(o.nextRun), now, currentLanguage, t) }}</div>
              <div class="text-[11.5px] text-gray-400 dark:text-zinc-500">{{ dayAndTime(at(o.nextRun), now, currentLanguage, t) }}</div>
            </template>
            <div v-else class="text-[13px] text-gray-400">—</div>
            <div v-if="o.missed && o.enabled && !o.running" class="mt-0.5 text-[11.5px] text-amber-600 dark:text-amber-400">{{ t('tasks.missed') }}</div>
          </div>

          <!-- Last runs -->
          <div class="min-w-0 pl-4 lg:pl-0">
            <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider lg:hidden">{{ t('tasks.lastRuns') }}</div>
            <template v-if="lastRun(o)">
              <div class="flex items-center gap-2">
                <span class="text-[13px]" :class="lastRun(o)!.success ? 'text-gray-700 dark:text-zinc-200' : 'text-red-600 dark:text-red-400 font-medium'">
                  {{ lastRun(o)!.success ? t('tasks.run.ok') : t('tasks.run.failed') }}
                </span>
                <span class="text-[12px] text-gray-400 dark:text-zinc-500 whitespace-nowrap">{{ relative(at(lastRun(o)!.at), now, currentLanguage, t) }}</span>
              </div>
              <div v-if="o.runs.length" class="mt-1 flex items-center gap-[3px]" role="list" :aria-label="t('tasks.lastRuns')">
                <span
                  v-for="(run, i) in strip(o)"
                  :key="i"
                  role="listitem"
                  class="w-[7px] h-3.5 rounded-[2px]"
                  :class="run.success ? 'bg-emerald-400/80 dark:bg-emerald-500/70' : 'bg-red-500'"
                  :title="runTitle(run)"
                  :aria-label="runTitle(run)"
                />
              </div>
              <p v-if="!lastRun(o)!.success && lastRun(o)!.error" class="mt-1 text-[11.5px] font-mono text-red-600/90 dark:text-red-400/90 truncate" :title="lastRun(o)!.error">{{ lastRun(o)!.error }}</p>
            </template>
            <div v-else class="text-[13px] text-gray-400 dark:text-zinc-500">{{ t('scheduled.never') }}</div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2 pl-4 lg:pl-0">
            <button type="button" :class="btnSecondary" :disabled="o.running" @click="runNow(o)">
              {{ o.running ? t('tasks.running') : t('tasks.runNow') }}
            </button>
            <button
              type="button"
              role="switch"
              :aria-checked="o.enabled"
              :aria-label="o.enabled ? t('tasks.pause') : t('tasks.resume')"
              :title="o.enabled ? t('tasks.pause') : t('tasks.resume')"
              class="relative w-9 h-5 rounded-full transition-colors shrink-0"
              :class="o.enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-zinc-700'"
              @click="togglePause(o)"
            >
              <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform" :class="o.enabled ? 'translate-x-4' : ''" />
            </button>
            <button
              type="button"
              class="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
              :aria-label="t('scheduled.editSchedule')"
              :title="t('scheduled.editSchedule')"
              @click="editSchedule(o.id)"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Nothing scheduled -->
      <div v-else-if="loaded" :class="card" class="px-6 py-10 text-center">
        <p class="text-[14px] font-medium text-gray-700 dark:text-zinc-200">{{ t('scheduled.noData') }}</p>
        <p class="mt-1 text-[12.5px] text-gray-500 dark:text-zinc-400">{{ t('tasks.emptyHint') }}</p>
      </div>

      <!-- Automatic backups switched off -->
      <div v-if="inactive.length" :class="card" class="overflow-hidden">
        <div class="px-4 pt-3 pb-1" :class="sectionTitle">{{ t('tasks.offTitle') }}</div>
        <div
          v-for="o in inactive"
          :key="o.id"
          class="flex items-center gap-3 px-4 py-2 border-t border-gray-100 dark:border-zinc-800 first-of-type:border-t-0"
        >
          <span class="w-2 h-2 rounded-full shrink-0 bg-gray-300 dark:bg-zinc-600" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-gray-700 dark:text-zinc-200 truncate">{{ nameOf(o.id) }}</div>
            <div class="text-[11.5px] text-gray-400 dark:text-zinc-500 truncate">
              {{ o.cron && o.cronValid ? t('tasks.offWith', { when: when(o) ?? o.cron }) : t('tasks.noSchedule') }}
              <template v-if="lastRun(o)"> · {{ t('tasks.lastBackupAt', { when: relative(at(lastRun(o)!.at), now, currentLanguage, t) }) }}</template>
            </div>
          </div>
          <button v-if="o.cron && o.cronValid" type="button" :class="btnSecondary" @click="togglePause(o)">{{ t('tasks.enable') }}</button>
          <button type="button" class="h-8 px-2.5 rounded-lg text-[12.5px] font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800" @click="editSchedule(o.id)">{{ t('tasks.configure') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

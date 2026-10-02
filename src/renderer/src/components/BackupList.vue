<script setup lang="ts">
/**
 * Backups page: the backup files grouped by database (newest group first), with each
 * group's size and retention, and per file: restore, show in Finder, export, delete.
 * Several files can be selected to delete them at once. Refreshes after each backup.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getErrorMessage } from '../utils';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import type { Backup } from '../types';
import { relative, dayAndTime, formatBytes } from '../timeText';
import { btnSecondary } from './ui/classes';

interface DbInfo { id: string; retentionCount: number | null; running: boolean }
interface Group {
  key: string;
  databaseId: string;
  name: string;
  known: boolean;
  files: Backup[];
  size: number;
  biggest: number;
  latest: number;
  retentionCount: number | null;
  running: boolean;
}

const { t, currentLanguage } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const isLoading = ref(true);
const filter = ref('all');
const selected = ref<Set<string>>(new Set());
const isDeleting = ref(false);
const collapsed = ref<Set<string>>(new Set());
const dbInfo = ref<Record<string, DbInfo>>({});
const now = ref(Date.now());

/** What actions target: the absolute path (backups can live in several folders) */
const fileRef = (backup: Backup) => backup.file || backup.filename;
const time = (backup: Backup) => new Date(backup.created).getTime();
const isMac = navigator.userAgent.includes('Mac');

const load = async () => {
  try {
    const [response, overview] = await Promise.all([
      ipcRenderer.invoke('get-backups'),
      ipcRenderer.invoke('schedule-overview').catch(() => null),
    ]);
    store.backups = response.backups || [];
    if (overview) dbInfo.value = Object.fromEntries((overview.databases as DbInfo[]).map(d => [d.id, d]));
    // Files deleted elsewhere leave the selection
    const present = new Set(store.backups.map(fileRef));
    selected.value = new Set([...selected.value].filter(f => present.has(f)));
    now.value = Date.now();
  } catch (error) {
    addToast(t('toasts.backupsLoadError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    isLoading.value = false;
  }
};

const groups = computed<Group[]>(() => {
  const byDb = new Map<string, Backup[]>();
  for (const b of store.backups) {
    if (filter.value !== 'all' && b.databaseId !== filter.value) continue;
    byDb.set(b.databaseId, [...(byDb.get(b.databaseId) ?? []), b]);
  }
  return [...byDb.entries()].map(([databaseId, files]) => {
    const db = store.databases.find(d => d.id === databaseId);
    const sorted = [...files].sort((a, b) => time(b) - time(a));
    return {
      key: databaseId,
      databaseId,
      name: db ? db.displayName || db.name : databaseId,
      known: !!db,
      files: sorted,
      size: files.reduce((sum, f) => sum + f.size, 0),
      biggest: Math.max(...files.map(f => f.size), 1),
      latest: sorted.length ? time(sorted[0]) : 0,
      retentionCount: dbInfo.value[databaseId]?.retentionCount ?? null,
      running: !!dbInfo.value[databaseId]?.running,
    };
  }).sort((a, b) => (a.known === b.known ? b.latest - a.latest : a.known ? -1 : 1));
});

const shownFiles = computed(() => groups.value.flatMap(g => g.files));
const totalSize = computed(() => shownFiles.value.reduce((sum, f) => sum + f.size, 0));
const selectedSize = computed(() => store.backups.filter(b => selected.value.has(fileRef(b))).reduce((sum, f) => sum + f.size, 0));
/** Databases that have backups, for the filter */
const filterOptions = computed(() => {
  const ids = new Set(store.backups.map(b => b.databaseId));
  return [...ids].map(id => {
    const db = store.databases.find(d => d.id === id);
    return { id, name: db ? db.displayName || db.name : t('backupsPage.removedDatabase', { id }) };
  }).sort((a, b) => a.name.localeCompare(b.name));
});

// --- Selection --------------------------------------------------------------------

const toggleOne = (backup: Backup) => {
  const next = new Set(selected.value);
  const key = fileRef(backup);
  if (next.has(key)) next.delete(key); else next.add(key);
  selected.value = next;
};
const groupState = (g: Group) => {
  const n = g.files.filter(f => selected.value.has(fileRef(f))).length;
  return n === 0 ? 'none' : n === g.files.length ? 'all' : 'some';
};
const toggleGroup = (g: Group) => {
  const next = new Set(selected.value);
  const all = groupState(g) === 'all';
  for (const f of g.files) { if (all) next.delete(fileRef(f)); else next.add(fileRef(f)); }
  selected.value = next;
};
const toggleCollapsed = (key: string) => {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  collapsed.value = next;
};

// --- Actions ----------------------------------------------------------------------

const restore = (backup: Backup) => {
  store.restoreBackupFile = fileRef(backup);
  store.showRestoreModal = true;
};

const reveal = (backup: Backup) => ipcRenderer.invoke('show-item-in-folder', fileRef(backup));

const exportCopy = async (backup: Backup) => {
  try {
    const result = await ipcRenderer.invoke('download-backup', fileRef(backup));
    if (result?.success) addToast(t('backup.downloaded'), 'success');
  } catch (error) {
    addToast(t('toasts.backupDownloadError'), 'error', { detail: getErrorMessage(error) });
  }
};

const remove = (backup: Backup) => {
  showConfirm({
    title: t('backups.deleteTitle'),
    message: t('backups.deleteConfirm', { name: backup.filename }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('delete-backup', fileRef(backup));
        await load();
        addToast(t('toasts.backupDeleted'), 'success');
      } catch (error) {
        addToast(t('toasts.backupDeleteError'), 'error', { detail: getErrorMessage(error) });
      }
    },
  });
};

const removeSelected = () => {
  const count = selected.value.size;
  if (!count) return;
  showConfirm({
    title: t('backups.deleteManyTitle'),
    message: t('backup.deleteSelectedConfirm', { count }),
    confirmText: t('modal.deleteButton'),
    type: 'danger',
    onConfirm: async () => {
      isDeleting.value = true;
      try {
        for (const file of [...selected.value]) await ipcRenderer.invoke('delete-backup', file);
        selected.value = new Set();
        await load();
        addToast(t('backup.deleteSelectedSuccess', { count }), 'success');
      } catch (error) {
        addToast(t('toasts.backupsDeleteError'), 'error', { detail: getErrorMessage(error) });
        await load();
      } finally {
        isDeleting.value = false;
      }
    },
  });
};

const backupNow = async (g: Group) => {
  if (g.running) return;
  const info = dbInfo.value[g.databaseId];
  if (info) info.running = true;
  try {
    await ipcRenderer.invoke('backup-now', g.databaseId);
  } catch (error) {
    addToast(t('toasts.backupStartError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    load();
  }
};

// --- Refresh ----------------------------------------------------------------------

const unsubscribers: Array<() => void> = [];
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const refreshSoon = () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 300);
};

onMounted(() => {
  load();
  for (const channel of ['backup-started', 'backup-complete', 'scheduled-backup-completed']) {
    const off = ipcRenderer.on(channel, refreshSoon) as unknown;
    if (typeof off === 'function') unsubscribers.push(off as () => void);
  }
});
onUnmounted(() => {
  unsubscribers.forEach(off => off());
  if (refreshTimer) clearTimeout(refreshTimer);
});

const iconButton = 'p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors';
const checkbox = 'w-3.5 h-3.5 rounded border-gray-300 dark:border-zinc-600 accent-emerald-600 cursor-pointer';
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-start justify-between gap-4 mb-4 shrink-0">
      <div>
        <h2 class="text-lg font-bold tracking-tight">{{ t('nav.backups') }}</h2>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 tabular-nums">
          {{ t('backupsPage.summary', { count: shownFiles.length.toLocaleString(currentLanguage), size: formatBytes(totalSize, currentLanguage) }) }}
        </p>
      </div>
      <select
        v-model="filter"
        :aria-label="t('logs.filterDatabase')"
        class="h-8 max-w-[220px] bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg px-2 text-[12.5px] text-gray-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
      >
        <option value="all">{{ t('common.allDatabases') }}</option>
        <option v-for="o in filterOptions" :key="o.id" :value="o.id">{{ o.name }}</option>
      </select>
    </div>

    <!-- Selection -->
    <div
      v-if="selected.size"
      class="mb-3 shrink-0 flex items-center gap-3 px-3.5 py-2 rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm"
    >
      <span class="text-[12.5px] font-medium">{{ t('backupsPage.selected', { count: selected.size, size: formatBytes(selectedSize, currentLanguage) }) }}</span>
      <div class="ml-auto flex items-center gap-2">
        <button type="button" class="h-8 px-3 rounded-lg text-[12.5px] font-medium text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800" @click="selected = new Set()">{{ t('backup.clearSelection') }}</button>
        <button
          type="button"
          class="h-8 px-3 rounded-lg text-[12.5px] font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
          :disabled="isDeleting"
          @click="removeSelected"
        >{{ isDeleting ? t('backupsPage.deleting') : t('backup.deleteSelected') }}</button>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto space-y-3 pb-6">
      <div v-if="isLoading" class="py-16 text-center text-[12.5px] text-gray-400">{{ t('logs.loading') }}</div>

      <div v-else-if="!groups.length" class="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-12 text-center">
        <p class="text-[14px] font-medium text-gray-700 dark:text-zinc-200">{{ t('backup.noBackups') }}</p>
        <p class="mt-1 text-[12.5px] text-gray-500 dark:text-zinc-400">{{ t('backupsPage.emptyHint') }}</p>
      </div>

      <section
        v-for="g in groups"
        :key="g.key"
        class="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
      >
        <!-- Database -->
        <header class="flex items-center gap-3 px-3.5 py-2.5" :class="!collapsed.has(g.key) ? 'border-b border-gray-100 dark:border-zinc-800' : ''">
          <input
            type="checkbox"
            :class="checkbox"
            :checked="groupState(g) === 'all'"
            :indeterminate="groupState(g) === 'some'"
            :aria-label="t('backupsPage.selectGroup', { name: g.name })"
            @change="toggleGroup(g)"
          />
          <button type="button" class="flex items-center gap-2 min-w-0 flex-1 text-left" :aria-expanded="!collapsed.has(g.key)" @click="toggleCollapsed(g.key)">
            <svg class="w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform" :class="collapsed.has(g.key) ? '-rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            <span class="text-[14px] font-semibold truncate" :class="!g.known ? 'text-gray-500 dark:text-zinc-400' : ''">{{ g.known ? g.name : t('backupsPage.removedDatabase', { id: g.name }) }}</span>
            <span class="shrink-0 font-mono text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums">{{ g.files.length }} · {{ formatBytes(g.size, currentLanguage) }}</span>
          </button>
          <span v-if="g.known" class="hidden md:inline text-[11.5px] text-gray-400 dark:text-zinc-500 whitespace-nowrap">
            {{ g.retentionCount === 1 ? t('tasks.keepsOne') : g.retentionCount ? t('tasks.keeps', { count: g.retentionCount }) : t('tasks.keepsAll') }}
          </span>
          <button v-if="g.known" type="button" :class="btnSecondary" class="h-7! text-[12px]!" :disabled="g.running" @click="backupNow(g)">
            {{ g.running ? t('tasks.running') : t('backupsPage.backupNow') }}
          </button>
        </header>

        <!-- Files -->
        <ul v-if="!collapsed.has(g.key)">
          <li
            v-for="(b, i) in g.files"
            :key="fileRef(b)"
            class="group grid grid-cols-[auto_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1.4fr)_auto] items-center gap-3 px-3.5 py-2"
            :class="[
              i ? 'border-t border-gray-50 dark:border-zinc-800/60' : '',
              selected.has(fileRef(b)) ? 'bg-emerald-50/60 dark:bg-emerald-950/20' : 'hover:bg-gray-50 dark:hover:bg-zinc-800/30',
            ]"
          >
            <input type="checkbox" :class="checkbox" :checked="selected.has(fileRef(b))" :aria-label="b.filename" @change="toggleOne(b)" />

            <!-- When -->
            <div class="min-w-0">
              <div class="text-[13px] text-gray-800 dark:text-zinc-100 truncate">
                {{ dayAndTime(time(b), now, currentLanguage, t) }}
                <span v-if="i === 0" class="ml-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">{{ t('backupsPage.latest') }}</span>
              </div>
              <div class="text-[11.5px] text-gray-400 dark:text-zinc-500">{{ relative(time(b), now, currentLanguage, t) }}</div>
            </div>

            <!-- Size -->
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-[12.5px] tabular-nums text-gray-700 dark:text-zinc-300">
                {{ formatBytes(b.size, currentLanguage) }}
                <span v-if="b.encrypted" class="text-[10px] px-1 py-px rounded border border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-zinc-400" :title="t('backupsPage.encryptedHint')">{{ t('tasks.encrypted') }}</span>
              </div>
              <div class="mt-1 h-1 rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden" aria-hidden="true">
                <div class="h-full rounded-full bg-gray-300 dark:bg-zinc-600" :style="{ width: `${Math.max(4, (b.size / g.biggest) * 100)}%` }" />
              </div>
            </div>

            <!-- File -->
            <div class="min-w-0 font-mono text-[11px] text-gray-400 dark:text-zinc-500 truncate [direction:rtl] text-left" :title="fileRef(b)"><bdi dir="ltr">{{ b.filename }}</bdi></div>

            <!-- Actions -->
            <div class="flex items-center gap-0.5">
              <button
                type="button"
                class="h-7 px-2.5 rounded-md text-[12px] font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                @click="restore(b)"
              >{{ t('backup.restore') }}</button>
              <button type="button" :class="iconButton" :title="isMac ? t('about.showInFinder') : t('about.showInFolder')" :aria-label="isMac ? t('about.showInFinder') : t('about.showInFolder')" @click="reveal(b)">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
              </button>
              <button type="button" :class="iconButton" :title="t('backupsPage.export')" :aria-label="t('backupsPage.export')" @click="exportCopy(b)">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              <button type="button" :class="iconButton" class="hover:text-red-600! dark:hover:text-red-400!" :title="t('backup.delete')" :aria-label="t('backup.delete')" @click="remove(b)">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

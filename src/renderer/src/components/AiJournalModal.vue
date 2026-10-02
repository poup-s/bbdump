<script setup lang="ts">
/**
 * Changes made by AI clients (MCP) on a database, newest first, and their undo:
 * rows inserted are deleted, rows updated or deleted get their previous state back.
 */
import { ref, computed, onMounted } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { ipcRenderer } from '../electron';
import { getErrorMessage } from '../utils';
import AppModal from './ui/AppModal.vue';
import { btnDanger, btnGhost, panelClass } from './ui/classes';

interface Entry {
  id: string;
  createdAt: string;
  client?: string;
  tool: string;
  sql: string;
  description: string;
  rowsAffected: number | null;
  undo: { available: boolean; reason?: string; rows: number; tables: string[] };
  undoneAt?: string;
}
interface TablePreview {
  table: string;
  primaryKey: string[];
  toDelete: number;
  toRestore: number;
  toRevert: number;
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}
interface Conflict { table: string; kind: 'changed' | 'missing' | 'reappeared'; row: Record<string, unknown> }

const ICON_HISTORY = 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z';

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

const db = computed(() => store.aiJournalDb);
const entries = ref<Entry[]>([]);
const isLoading = ref(false);
const selected = ref<Entry | null>(null);
const preview = ref<{ tables: TablePreview[]; conflicts: Conflict[] } | null>(null);
const previewError = ref('');
const isUndoing = ref(false);

const load = async () => {
  if (!db.value) return;
  isLoading.value = true;
  try {
    entries.value = await ipcRenderer.invoke('ai-journal-list', db.value.id);
  } catch (error) {
    addToast(t('aiJournal.loadError'), 'error', { detail: getErrorMessage(error) });
  } finally {
    isLoading.value = false;
  }
};

const open = async (entry: Entry) => {
  selected.value = entry;
  preview.value = null;
  previewError.value = '';
  if (!entry.undo.available || entry.undoneAt) return;
  const result = await ipcRenderer.invoke('ai-journal-preview', entry.id);
  if (result.success) preview.value = { tables: result.tables, conflicts: result.conflicts };
  else previewError.value = result.error;
};

const kind = (tool: string) => (tool.includes('insert') ? 'INSERT' : tool.includes('update') ? 'UPDATE' : tool.includes('delete') ? 'DELETE' : 'SQL');
const kindClass = (tool: string) => (tool.includes('insert')
  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  : tool.includes('delete') ? 'bg-red-500/10 text-red-700 dark:text-red-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400');

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** Columns shown in the before/after samples: the key first, at most 6 */
const columnsOf = (p: TablePreview) => {
  const all = Array.from(new Set([...p.before, ...p.after].flatMap(row => Object.keys(row))));
  return [...p.primaryKey, ...all.filter(c => !p.primaryKey.includes(c))].slice(0, 6);
};
const cell = (value: unknown) => {
  if (value === null || value === undefined) return '∅';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

const undo = () => {
  const entry = selected.value;
  if (!entry) return;
  showConfirm({
    title: t('aiJournal.undoTitle'),
    message: t('aiJournal.undoMessage', { rows: entry.undo.rows, description: entry.description }),
    confirmText: t('aiJournal.undo'),
    type: 'danger',
    onConfirm: async () => {
      isUndoing.value = true;
      try {
        const result = await ipcRenderer.invoke('ai-journal-undo', entry.id);
        if (result.success) {
          addToast(t('aiJournal.undone'), 'success');
          await load();
          selected.value = entries.value.find(e => e.id === entry.id) ?? null;
          preview.value = null;
        } else if (result.conflicts?.length) {
          preview.value = { tables: preview.value?.tables ?? [], conflicts: result.conflicts };
          addToast(t('aiJournal.conflictToast'), 'error');
        } else {
          addToast(t('aiJournal.undoFailed'), 'error', { detail: result.error });
        }
      } finally {
        isUndoing.value = false;
      }
    },
  });
};

const close = () => {
  if (isUndoing.value) return;
  store.aiJournalDb = null;
};

onMounted(load);
</script>

<template>
  <AppModal
    :title="t('aiJournal.title')"
    :icon="ICON_HISTORY"
    :meta="db?.displayName || db?.name"
    width="lg"
    :busy="isUndoing"
    :close-label="t('common.close')"
    @close="close"
  >
    <!-- One change -->
    <div v-if="selected">
      <button type="button" class="mb-4 inline-flex items-center gap-1 text-[12px] text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-zinc-100" @click="selected = null">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
        {{ t('aiJournal.back') }}
      </button>
      <div class="flex items-center gap-2 flex-wrap mb-1">
        <span class="px-1.5 py-px rounded text-[10px] font-mono font-medium" :class="kindClass(selected.tool)">{{ kind(selected.tool) }}</span>
        <span class="text-[12px] text-gray-500 dark:text-zinc-400">{{ when(selected.createdAt) }}<template v-if="selected.client"> · {{ selected.client }}</template></span>
      </div>
      <h3 class="text-[15px] font-semibold text-gray-900 dark:text-zinc-50 mb-3">{{ selected.description }}</h3>
      <pre class="mb-4 rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-950 px-3.5 py-2.5 text-[11px] font-mono text-gray-700 dark:text-zinc-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{{ selected.sql }}</pre>

      <p v-if="selected.undoneAt" :class="panelClass" class="px-3.5 py-2.5 text-[12px] text-gray-600 dark:text-zinc-400">{{ t('aiJournal.undoneOn', { date: when(selected.undoneAt) }) }}</p>
      <p v-else-if="!selected.undo.available" class="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 px-3.5 py-2.5 text-[12px] text-amber-800 dark:text-amber-300">
        {{ t('aiJournal.noUndo', { reason: selected.undo.reason || '—' }) }}
      </p>
      <p v-else-if="previewError" class="text-[12px] text-red-600 dark:text-red-400">{{ previewError }}</p>
      <div v-else-if="!preview" class="py-6 flex justify-center"><span class="w-5 h-5 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" /></div>
      <template v-else>
        <div v-if="preview.conflicts.length" class="mb-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 px-3.5 py-2.5" role="alert">
          <div class="text-[12px] font-medium text-red-700 dark:text-red-400 mb-1">{{ t('aiJournal.conflicts', { count: preview.conflicts.length }) }}</div>
          <ul class="space-y-0.5">
            <li v-for="(c, i) in preview.conflicts.slice(0, 5)" :key="i" class="text-[11px] font-mono text-red-700/90 dark:text-red-300/90 overflow-hidden text-ellipsis whitespace-nowrap">
              {{ c.table }} · {{ t(`aiJournal.conflict.${c.kind}`) }} · {{ JSON.stringify(c.row).slice(0, 90) }}
            </li>
          </ul>
        </div>
        <p class="text-[12px] font-medium text-gray-700 dark:text-zinc-200 mb-2">{{ t('aiJournal.whatUndoes') }}</p>
        <div v-for="p in preview.tables" :key="p.table" class="mb-3 rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden">
          <div class="flex items-center gap-2 flex-wrap px-3.5 py-2 bg-gray-50/70 dark:bg-zinc-800/30 border-b border-gray-100 dark:border-zinc-800">
            <span class="font-mono text-[12px] text-gray-900 dark:text-zinc-100">{{ p.table }}</span>
            <span class="flex-1" />
            <span v-if="p.toRevert" class="text-[11px] text-amber-700 dark:text-amber-400">{{ t('aiJournal.revert', { count: p.toRevert }) }}</span>
            <span v-if="p.toRestore" class="text-[11px] text-emerald-700 dark:text-emerald-400">{{ t('aiJournal.restore', { count: p.toRestore }) }}</span>
            <span v-if="p.toDelete" class="text-[11px] text-red-700 dark:text-red-400">{{ t('aiJournal.remove', { count: p.toDelete }) }}</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-[11px] font-mono">
              <thead>
                <tr class="text-left text-gray-400 dark:text-zinc-500">
                  <th class="px-3 py-1.5 font-normal w-16" />
                  <th v-for="c in columnsOf(p)" :key="c" class="px-3 py-1.5 font-normal">{{ c }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in p.before.slice(0, 3)" :key="'b' + i" class="border-t border-gray-100 dark:border-zinc-800">
                  <td class="px-3 py-1 text-emerald-700 dark:text-emerald-400">{{ t('aiJournal.beforeLabel') }}</td>
                  <td v-for="c in columnsOf(p)" :key="c" class="px-3 py-1 text-gray-700 dark:text-zinc-300 whitespace-nowrap">{{ cell(row[c]) }}</td>
                </tr>
                <tr v-for="(row, i) in p.after.slice(0, 3)" :key="'a' + i" class="border-t border-gray-100 dark:border-zinc-800">
                  <td class="px-3 py-1 text-gray-400 dark:text-zinc-500">{{ t('aiJournal.afterLabel') }}</td>
                  <td v-for="c in columnsOf(p)" :key="c" class="px-3 py-1 text-gray-500 dark:text-zinc-500 whitespace-nowrap">{{ cell(row[c]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>

    <!-- List -->
    <template v-else>
      <div v-if="isLoading && !entries.length" class="py-16 flex justify-center"><span class="w-6 h-6 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" /></div>
      <div v-else-if="!entries.length" class="py-14 text-center">
        <p class="text-[14px] font-medium text-gray-900 dark:text-zinc-100">{{ t('aiJournal.emptyTitle') }}</p>
        <p class="mt-1 text-[12px] text-gray-500 dark:text-zinc-400 max-w-sm mx-auto">{{ t('aiJournal.emptyBody') }}</p>
      </div>
      <ul v-else class="rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800 overflow-hidden">
        <li v-for="entry in entries" :key="entry.id">
          <button type="button" class="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-zinc-800/40 transition-colors" @click="open(entry)">
            <span class="mt-0.5 px-1.5 py-px rounded text-[10px] font-mono font-medium shrink-0" :class="kindClass(entry.tool)">{{ kind(entry.tool) }}</span>
            <span class="flex-1 min-w-0">
              <span class="block text-[13px] text-gray-900 dark:text-zinc-100 overflow-hidden text-ellipsis whitespace-nowrap" :class="entry.undoneAt ? 'line-through text-gray-400 dark:text-zinc-500' : ''">{{ entry.description }}</span>
              <span class="block text-[11px] text-gray-500 dark:text-zinc-400">{{ when(entry.createdAt) }}<template v-if="entry.client"> · {{ entry.client }}</template></span>
            </span>
            <span v-if="entry.undoneAt" class="shrink-0 px-1.5 py-px rounded-full text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400">{{ t('aiJournal.undoneBadge') }}</span>
            <span v-else-if="entry.undo.available" class="shrink-0 px-1.5 py-px rounded-full text-[10px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{{ t('aiJournal.undoable') }}</span>
            <span v-else class="shrink-0 px-1.5 py-px rounded-full text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400" :title="entry.undo.reason">{{ t('aiJournal.noUndoBadge') }}</span>
          </button>
        </li>
      </ul>
    </template>

    <template #footer>
      <span v-if="!selected" class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('aiJournal.footer') }}</span>
      <span class="flex-1" />
      <button type="button" :class="btnGhost" :disabled="isUndoing" @click="close">{{ t('common.close') }}</button>
      <button
        v-if="selected && selected.undo.available && !selected.undoneAt && preview"
        type="button"
        :class="btnDanger"
        :disabled="isUndoing || preview.conflicts.length > 0"
        @click="undo"
      >
        <span v-if="isUndoing" class="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
        {{ t('aiJournal.undo') }}
      </button>
    </template>
  </AppModal>
</template>

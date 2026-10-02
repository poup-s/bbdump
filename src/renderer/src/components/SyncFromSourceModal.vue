<script setup lang="ts">
/**
 * Update a local database from another saved one (e.g. prod): Analysis → Choices →
 * Preview → Apply. The source is only read; the local database is backed up first.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { store } from '../store';
import { useI18n } from '../composables/useI18n';
import { useToast } from '../composables/useToast';
import { ipcRenderer } from '../electron';
import { getErrorMessage } from '../utils';
import AppModal from './ui/AppModal.vue';
import { btnGhost, btnPrimary, selectClass } from './ui/classes';

interface SchemaChange { id: string; kind: string; object: string; sql: string[]; destructive: boolean; defaultSelected: boolean; note?: string; noteCode?: string; noteParams?: Record<string, string> }
interface TablePlan {
  key: string; newTable: boolean; primaryKey: string[] | null; sourceRows: number; localRows: number;
  missing: number | null; missingExact: boolean; timeColumn?: string; defaultSelected: boolean; reason?: string;
}
interface Candidate { table: string; column: string; kind: string }
interface Analysis {
  source: { id: string; name: string; host: string; version: number };
  target: { id: string; name: string; host: string; version: number };
  schema: SchemaChange[]; tables: TablePlan[]; anonymize: Candidate[];
}
interface SyncResult {
  success: boolean; error?: string;
  schema: { applied: number; failed: Array<{ id: string; error: string }> };
  tables: Array<{ key: string; copied: number; skipped: number; error?: string }>;
}
type Progress =
  | { stage: 'backup' } | { stage: 'schema'; done: number; total: number; current?: string }
  | { stage: 'data'; table: string; index: number; total: number; copied: number; skipped: number } | { stage: 'done' };

const ICON_SYNC = 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15';

const { t } = useI18n();
const { addToast } = useToast();

const target = computed(() => store.syncTargetDb);
/** Sources: the other databases of the target's project */
const project = computed(() => store.projects.find(p => target.value && p.databaseIds?.includes(target.value.id)) ?? null);
const sources = computed(() => store.databases.filter(d => d.id !== target.value?.id && !!project.value?.databaseIds?.includes(d.id)));
const sourceId = ref('');
const step = ref(0);
const analysis = ref<Analysis | null>(null);
const analyzing = ref(false);
const analyzeError = ref('');

const selectedChanges = ref(new Set<string>());
const selectedTables = ref(new Map<string, number | undefined>());
const anonymizeOn = ref(true);
const selectedAnon = ref(new Set<string>());
const backup = ref(true);

const applying = ref(false);
const progress = ref({ backupDone: false, schema: { done: 0, total: 0 }, copied: {} as Record<string, number> });
const result = ref<SyncResult | null>(null);

const steps = computed(() => [t('sync.steps.analysis'), t('sync.steps.choices'), t('sync.steps.preview'), t('sync.steps.apply')]);
const fmt = (n: number) => n.toLocaleString();
const anonKey = (c: Candidate) => `${c.table}.${c.column}`;

/** Source by default: the one used last time, else a non-local database of the same project */
const defaultSource = () => {
  const t0 = target.value;
  if (!t0) return '';
  if (t0.syncSourceId && sources.value.some(d => d.id === t0.syncSourceId)) return t0.syncSourceId;
  return (sources.value.find(d => !d.isLocalBbdump) ?? sources.value[0])?.id ?? '';
};

const analyze = async () => {
  if (!target.value || !sourceId.value) return;
  analyzing.value = true;
  analyzeError.value = '';
  analysis.value = null;
  try {
    const r = await ipcRenderer.invoke('sync-analyze', target.value.id, sourceId.value);
    if (!r.success) { analyzeError.value = r.error; return; }
    const a: Analysis = r.analysis;
    analysis.value = a;
    selectedChanges.value = new Set(a.schema.filter(c => c.defaultSelected).map(c => c.id));
    selectedTables.value = new Map(a.tables.filter(tb => tb.defaultSelected).map(tb => [tb.key, undefined]));
    selectedAnon.value = new Set(a.anonymize.map(anonKey));
  } catch (error) {
    analyzeError.value = getErrorMessage(error);
  } finally {
    analyzing.value = false;
  }
};

const additions = computed(() => analysis.value?.schema.filter(c => !c.destructive) ?? []);
const destructive = computed(() => analysis.value?.schema.filter(c => c.destructive) ?? []);
const missingTables = computed(() => (analysis.value?.tables ?? []).filter(tb => tb.primaryKey && tb.missing));
/** Tables that can be copied: a primary key, and not checked as up to date */
const copyable = (tb: TablePlan) => !!tb.primaryKey && !(tb.missingExact && !tb.missing);
const missingAll = computed(() => missingTables.value.reduce((n, tb) => n + (tb.missing ?? 0), 0));
const missingSelected = computed(() => missingTables.value.filter(tb => selectedTables.value.has(tb.key)).reduce((n, tb) => n + (tb.missing ?? 0), 0));
const upToDate = computed(() => !!analysis.value && additions.value.length === 0 && missingTables.value.length === 0);

const toggled = <T,>(set: Set<T>, value: T) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };
const toggleTable = (tb: TablePlan) => {
  if (!copyable(tb)) return;
  const next = new Map(selectedTables.value);
  if (next.has(tb.key)) next.delete(tb.key); else next.set(tb.key, undefined);
  selectedTables.value = next;
};
const setRecent = (key: string, value: string) => {
  const next = new Map(selectedTables.value);
  next.set(key, value ? Number(value) : undefined);
  selectedTables.value = next;
};
const tableNote = (tb: TablePlan) => {
  if (!tb.primaryKey) return t('sync.reason.no_primary_key');
  if (!copyable(tb)) return t('sync.reason.up_to_date');
  if (tb.reason === 'too_large' && !selectedTables.value.has(tb.key)) return t('sync.reason.too_large');
  return '';
};

const previewSql = computed(() => {
  const lines = (analysis.value?.schema ?? []).filter(c => selectedChanges.value.has(c.id)).flatMap(c => c.sql.map(s => `${s};`));
  return lines.length ? lines.join('\n') : `-- ${t('sync.noSchemaChange')}`;
});

const apply = async () => {
  if (!analysis.value || !target.value) return;
  step.value = 3;
  applying.value = true;
  result.value = null;
  progress.value = { backupDone: !backup.value, schema: { done: 0, total: selectedChanges.value.size }, copied: {} };
  const choices = {
    changes: [...selectedChanges.value],
    tables: [...selectedTables.value.entries()].map(([key, recentDays]) => ({ key, recentDays })),
    anonymize: anonymizeOn.value ? analysis.value.anonymize.filter(c => selectedAnon.value.has(anonKey(c))) : [],
    backup: backup.value,
  };
  try {
    result.value = await ipcRenderer.invoke('sync-apply', target.value.id, sourceId.value, JSON.parse(JSON.stringify(choices)));
    if (result.value?.success) addToast(t('sync.doneToast', { name: analysis.value.target.name }), 'success');
  } catch (error) {
    result.value = { success: false, error: getErrorMessage(error), schema: { applied: 0, failed: [] }, tables: [] };
  } finally {
    applying.value = false;
  }
};

const onProgress = (_e: unknown, p: Progress) => {
  if (p.stage === 'schema') { progress.value.backupDone = true; progress.value.schema = { done: p.done, total: p.total }; }
  if (p.stage === 'data') { progress.value.backupDone = true; progress.value.copied[p.table] = p.copied; }
};
const tableResult = (key: string) => result.value?.tables.find(r => r.key === key);
const tableWidth = (key: string) => {
  if (tableResult(key)) return 100;
  const expected = analysis.value?.tables.find(tb => tb.key === key)?.missing ?? 1;
  return Math.min(95, (100 * (progress.value.copied[key] ?? 0)) / Math.max(1, expected));
};

const next = () => {
  if (step.value === 0 && analysis.value && !upToDate.value) step.value = 1;
  else if (step.value === 1) step.value = 2;
  else if (step.value === 2) apply();
  else if (step.value === 3 && !applying.value) close();
};
const back = () => { if (step.value > 0 && step.value < 3) step.value--; };

const close = () => {
  if (applying.value) return;
  store.syncTargetDb = null;
};

watch(sourceId, (id) => { if (id) { step.value = 0; analyze(); } });
onMounted(() => {
  ipcRenderer.on('sync-progress', onProgress);
  sourceId.value = defaultSource();
});
onUnmounted(() => ipcRenderer.removeListener('sync-progress', onProgress));
</script>

<template>
  <AppModal
    :title="t('sync.title')"
    :icon="ICON_SYNC"
    :meta="analysis ? `${analysis.target.name} ← ${analysis.source.name}` : target?.displayName || target?.name"
    width="lg"
    :steps="steps"
    :step="step"
    :busy="applying"
    :close-label="t('common.close')"
    @close="close"
    @submit="next"
  >
    <!-- 0 · Analysis -->
    <div v-if="step === 0">
      <label class="block text-[12px] text-gray-500 dark:text-zinc-400 mb-1.5" for="sync-source">{{ t('sync.sourceLabel', { project: project?.name ?? '' }) }}</label>
      <select id="sync-source" v-model="sourceId" :class="selectClass" class="mb-4" :disabled="analyzing">
        <option v-for="d in sources" :key="d.id" :value="d.id">{{ d.displayName || d.name }} — {{ d.host }}:{{ d.port }}{{ d.isLocalBbdump ? ` (${t('sync.local')})` : '' }}</option>
      </select>

      <div v-if="analyzing" class="py-12 flex flex-col items-center gap-3" role="status">
        <span class="w-6 h-6 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
        <span class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('sync.analyzing') }}</span>
      </div>
      <p v-else-if="analyzeError" class="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 px-3.5 py-2.5 text-[12px] text-red-700 dark:text-red-400" role="alert">{{ analyzeError }}</p>
      <template v-else-if="analysis">
        <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-1.5">{{ t('sync.analysisDone') }}</div>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-zinc-50">{{ upToDate ? t('sync.upToDate') : t('sync.behind') }}</h3>
        <p class="text-[13px] text-gray-500 dark:text-zinc-400 mb-4">{{ t('sync.readOnlyNote') }}</p>
        <div class="flex items-center gap-3 rounded-xl border border-gray-200 dark:border-zinc-800 px-3.5 py-2.5 mb-4">
          <div class="flex-1 min-w-0">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('sync.sourceReadOnly') }}</div>
            <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100 truncate">{{ analysis.source.name }}</div>
            <div class="font-mono text-[11px] text-gray-400 dark:text-zinc-500 truncate">{{ analysis.source.host }} · PG {{ Math.floor(analysis.source.version / 10000) }}</div>
          </div>
          <svg class="w-4 h-4 shrink-0 text-gray-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
          <div class="flex-1 min-w-0 text-right">
            <div class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('sync.target') }}</div>
            <div class="text-[13px] font-medium text-emerald-700 dark:text-emerald-400 truncate">{{ analysis.target.name }}</div>
            <div class="font-mono text-[11px] text-gray-400 dark:text-zinc-500 truncate">{{ analysis.target.host }} · PG {{ Math.floor(analysis.target.version / 10000) }}</div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl bg-gray-50 dark:bg-zinc-800/40 px-4 py-3">
            <div class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('sync.schema') }}</div>
            <div class="text-xl font-semibold text-gray-900 dark:text-zinc-50">{{ t('sync.additions', { count: additions.length }) }}</div>
            <div v-if="destructive.length" class="text-[12px] text-amber-700 dark:text-amber-400">{{ t('sync.notApplied', { count: destructive.length }) }}</div>
          </div>
          <div class="rounded-xl bg-gray-50 dark:bg-zinc-800/40 px-4 py-3">
            <div class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('sync.data') }}</div>
            <div class="text-xl font-semibold text-gray-900 dark:text-zinc-50">{{ t('sync.rows', { count: fmt(missingAll) }) }}</div>
            <div class="text-[12px] text-gray-500 dark:text-zinc-400">{{ t('sync.inTables', { count: missingTables.length }) }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 1 · Choices -->
    <div v-else-if="step === 1 && analysis">
      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-2">{{ t('sync.schema') }}</div>
      <p v-if="!analysis.schema.length" class="mb-4 text-[12px] text-gray-500 dark:text-zinc-400">{{ t('sync.schemaSame') }}</p>
      <ul v-else class="mb-5 rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800 overflow-hidden">
        <li v-for="c in [...additions, ...destructive]" :key="c.id">
          <label class="flex items-start gap-3 px-3.5 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/40">
            <input type="checkbox" class="mt-0.5 accent-emerald-600" :checked="selectedChanges.has(c.id)" @change="selectedChanges = toggled(selectedChanges, c.id)" />
            <span class="flex-1 min-w-0">
              <span class="text-[11px] text-gray-500 dark:text-zinc-400 mr-1.5">{{ t(`sync.kinds.${c.kind}`) }}</span>
              <span class="font-mono text-[12px] break-all" :class="c.destructive ? 'text-amber-700 dark:text-amber-400' : 'text-gray-900 dark:text-zinc-100'">{{ c.object }}</span>
              <span v-if="c.noteCode || c.note" class="block text-[11px] text-gray-400 dark:text-zinc-500">{{ c.noteCode ? t(`sync.notes.${c.noteCode}`, c.noteParams ?? {}) : c.note }}</span>
            </span>
          </label>
        </li>
      </ul>

      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-2">{{ t('sync.dataTitle') }}</div>
      <ul class="mb-4 rounded-xl border border-gray-200 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800 overflow-hidden">
        <li v-for="tb in analysis.tables" :key="tb.key" class="flex items-center gap-3 px-3.5 py-2" :class="copyable(tb) ? '' : 'opacity-60'">
          <input type="checkbox" class="accent-emerald-600" :checked="selectedTables.has(tb.key)" :disabled="!copyable(tb)" :aria-label="tb.key" @change="toggleTable(tb)" />
          <span class="flex-1 min-w-0 font-mono text-[12px] text-gray-900 dark:text-zinc-100 truncate">{{ tb.key }}</span>
          <select
            v-if="tb.timeColumn && selectedTables.has(tb.key)"
            class="h-7 rounded-md border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[11px] px-1.5"
            :value="selectedTables.get(tb.key) ?? ''"
            :aria-label="t('sync.filter')"
            @change="setRecent(tb.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('sync.allRows') }}</option>
            <option value="30">{{ t('sync.lastDays', { days: 30 }) }}</option>
            <option value="7">{{ t('sync.lastDays', { days: 7 }) }}</option>
          </select>
          <span v-if="tableNote(tb)" class="text-[11px]" :class="tb.reason === 'too_large' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-400 dark:text-zinc-500'">{{ tableNote(tb) }}</span>
          <span v-if="copyable(tb)" class="shrink-0 px-2 py-px rounded-full text-[11px] tabular-nums" :class="selectedTables.has(tb.key) ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'">{{ tb.missingExact ? '' : '~' }}{{ fmt(tb.missing ?? 0) }}</span>
        </li>
      </ul>

      <div v-if="analysis.anonymize.length" class="rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden">
        <label class="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer">
          <input v-model="anonymizeOn" type="checkbox" class="accent-emerald-600" />
          <span class="flex-1">
            <span class="block text-[13px] text-gray-900 dark:text-zinc-100">{{ t('sync.anonymize') }}</span>
            <span class="block text-[11px] text-gray-500 dark:text-zinc-400">{{ t('sync.anonymizeHint') }}</span>
          </span>
        </label>
        <div v-if="anonymizeOn" class="flex flex-wrap gap-1.5 px-3.5 pb-3">
          <button
            v-for="c in analysis.anonymize"
            :key="anonKey(c)"
            type="button"
            class="px-2 py-0.5 rounded-full border text-[11px] font-mono transition-colors"
            :class="selectedAnon.has(anonKey(c)) ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-gray-200 dark:border-zinc-700 text-gray-400 dark:text-zinc-500 line-through'"
            :aria-pressed="selectedAnon.has(anonKey(c))"
            @click="selectedAnon = toggled(selectedAnon, anonKey(c))"
          >{{ c.table.replace(/^public\./, '') }}.{{ c.column }}</button>
        </div>
      </div>
    </div>

    <!-- 2 · Preview -->
    <div v-else-if="step === 2 && analysis">
      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-gray-400 dark:text-zinc-500 mb-2">{{ t('sync.previewTitle', { name: analysis.target.name }) }}</div>
      <pre class="mb-3 max-h-64 overflow-auto rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-950 px-3.5 py-2.5 text-[11px] leading-relaxed font-mono text-gray-700 dark:text-zinc-300 whitespace-pre-wrap">{{ previewSql }}</pre>
      <p class="mb-3 text-[12px] text-gray-600 dark:text-zinc-400">
        {{ t('sync.previewData', { rows: fmt(missingSelected), tables: selectedTables.size }) }}
        <template v-if="anonymizeOn && selectedAnon.size"> · {{ t('sync.previewAnon', { count: selectedAnon.size }) }}</template>
      </p>
      <label class="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-zinc-800 px-3.5 py-2.5 cursor-pointer mb-2">
        <input v-model="backup" type="checkbox" class="mt-0.5 accent-emerald-600" />
        <span>
          <span class="block text-[13px] text-gray-900 dark:text-zinc-100">{{ t('sync.backupFirst', { name: analysis.target.name }) }}</span>
          <span class="block text-[11px] text-gray-500 dark:text-zinc-400">{{ t('sync.backupHint') }}</span>
        </span>
      </label>
      <p class="text-[11px] text-gray-500 dark:text-zinc-400">{{ t('sync.keepLocal') }}</p>
    </div>

    <!-- 3 · Apply -->
    <div v-else-if="step === 3 && analysis" aria-live="polite">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-zinc-50 mb-4">
        {{ applying ? t('sync.applying') : result?.success ? t('sync.done', { name: analysis.target.name }) : t('sync.failed') }}
      </h3>
      <p v-if="result?.error" class="mb-3 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/20 px-3.5 py-2.5 text-[12px] text-red-700 dark:text-red-400" role="alert">{{ result.error }}</p>
      <ul class="space-y-3">
        <li v-if="backup">
          <div class="flex text-[13px] mb-1"><span class="flex-1">{{ t('sync.stepBackup') }}</span><span class="text-[11px] text-gray-400">{{ progress.backupDone || result ? t('sync.finished') : t('sync.running') }}</span></div>
          <div class="h-[3px] rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden"><div class="h-full bg-emerald-500 transition-all" :style="{ width: progress.backupDone || result ? '100%' : '35%' }" /></div>
        </li>
        <li v-if="selectedChanges.size">
          <div class="flex text-[13px] mb-1"><span class="flex-1">{{ t('sync.stepSchema', { count: selectedChanges.size }) }}</span><span class="text-[11px] text-gray-400 tabular-nums">{{ result ? `${result.schema.applied}/${selectedChanges.size}` : `${progress.schema.done}/${progress.schema.total}` }}</span></div>
          <div class="h-[3px] rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden"><div class="h-full bg-emerald-500 transition-all" :style="{ width: `${result ? 100 : progress.schema.total ? (100 * progress.schema.done) / progress.schema.total : 0}%` }" /></div>
          <ul v-if="result?.schema.failed.length" class="mt-1.5 space-y-0.5">
            <li v-for="f in result.schema.failed" :key="f.id" class="text-[11px] text-red-700 dark:text-red-400 font-mono truncate" :title="f.error">{{ f.id }} — {{ f.error }}</li>
          </ul>
        </li>
        <li v-for="[key] in selectedTables" :key="key">
          <div class="flex text-[13px] mb-1">
            <span class="flex-1 font-mono text-[12px]">{{ key }}</span>
            <span class="text-[11px] text-gray-400 tabular-nums">{{ fmt(tableResult(key)?.copied ?? progress.copied[key] ?? 0) }}</span>
          </div>
          <div class="h-[3px] rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden">
            <div class="h-full transition-all" :class="tableResult(key)?.error ? 'bg-red-500' : 'bg-emerald-500'" :style="{ width: `${tableWidth(key)}%` }" />
          </div>
          <p v-if="tableResult(key)?.error" class="mt-1 text-[11px] text-red-700 dark:text-red-400">{{ tableResult(key)?.error }}</p>
          <p v-else-if="tableResult(key)?.skipped" class="mt-1 text-[11px] text-amber-700 dark:text-amber-400">{{ t('sync.skipped', { count: fmt(tableResult(key)?.skipped ?? 0) }) }}</p>
        </li>
      </ul>
    </div>

    <template #footer>
      <button v-if="step > 0 && step < 3" type="button" :class="btnGhost" @click="back">{{ t('database.wizard.previous') }}</button>
      <button v-else-if="step === 0" type="button" :class="btnGhost" :disabled="analyzing || !sourceId" @click="analyze">{{ t('sync.reanalyze') }}</button>
      <span class="flex-1" />
      <button
        type="button"
        :class="btnPrimary"
        :disabled="analyzing || applying || (step === 0 && (!analysis || upToDate)) || (step === 1 && !selectedChanges.size && !selectedTables.size)"
        @click="next"
      >
        <span v-if="applying" class="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
        {{ step === 0 ? t('sync.next.choose') : step === 1 ? t('sync.next.preview') : step === 2 ? t('sync.next.apply') : t('common.close') }}
      </button>
    </template>
  </AppModal>
</template>

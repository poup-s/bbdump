<script setup lang="ts">
/**
 * What a duplicate replaces: per table, the columns turned into fakes and whether its rows
 * are copied at all. Columns tied by foreign keys move together (the copy stays consistent).
 * mode "ai": the same choice of columns, masked in what AI clients read through MCP (saved here).
 */
import { ref, computed, onMounted } from 'vue';
import { getErrorMessage } from '../utils';
import { useI18n } from '../composables/useI18n';
import { ipcRenderer } from '../electron';
import AppModal from './ui/AppModal.vue';
import SwitchRow from './ui/SwitchRow.vue';
import { store } from '../store';
import { useToast } from '../composables/useToast';
import { btnGhost, btnPrimary, inputClass } from './ui/classes';
import type { AnonymizeChoices, AnonymizeKind } from '../anonymize';

interface PlanColumn { name: string; type: string; kinds: AnonymizeKind[]; detected?: AnonymizeKind; linked: string[]; locked?: 'key' | 'type' }
interface PlanTable { key: string; rows: number; referencedBy: string[]; suggestEmpty: boolean; columns: PlanColumn[] }

const ICON_MASK = 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21';

const props = withDefaults(defineProps<{ sourceId: string; sourceLabel: string; initial: AnonymizeChoices | null; mode?: 'duplicate' | 'ai' }>(), { mode: 'duplicate' });
const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm', choices: AnonymizeChoices): void }>();

const { t } = useI18n();
const { addToast } = useToast();
const isAi = props.mode === 'ai';
/** mode "ai": masking on or off for this database */
const enabled = ref(false);
const saving = ref(false);
const loading = ref(true);
const error = ref('');
const tables = ref<PlanTable[]>([]);
/** Kinds chosen by the user, by "schema.table.column" (linked columns follow, see `effective`) */
const chosen = ref(new Map<string, AnonymizeKind>());
const emptyChosen = ref(new Set<string>());
const search = ref('');
const showAll = ref(false);
const open = ref(new Set<string>());

const key = (table: string, column: string) => `${table}.${column}`;
const tableOf = (k: string) => k.slice(0, k.lastIndexOf('.'));
const shortName = (k: string) => k.replace(/^public\./, '');
const fmt = (n: number) => n.toLocaleString();
const toggled = <T,>(set: Set<T>, value: T) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };

// Partly starred by default: the value keeps its shape (****234@email.fr), so checks and validations still pass
const defaultKind = (c: PlanColumn): AnonymizeKind => (c.kinds.includes('partial') ? 'partial' : c.detected!);

const columnsByKey = computed(() => new Map(tables.value.flatMap(tb => tb.columns.map(c => [key(tb.key, c.name), c] as const))));

onMounted(async () => {
  try {
    const result = await ipcRenderer.invoke('duplicate-anonymize-plan', props.sourceId);
    if (!result?.success) throw new Error(result?.error || 'Unknown error');
    tables.value = result.plan.tables;
    const saved = isAi ? await ipcRenderer.invoke('ai-masking-get', props.sourceId) : null;
    if (saved) enabled.value = saved.enabled === true;
    if (saved?.columns?.length) {
      chosen.value = new Map(saved.columns.map((c: { table: string; column: string; kind: AnonymizeKind }) => [key(c.table, c.column), c.kind]));
    } else if (props.initial) {
      chosen.value = new Map(props.initial.columns.map(c => [key(c.table, c.column), c.kind]));
      emptyChosen.value = new Set(props.initial.emptyTables);
    } else {
      // Masked by default (XXXX…); a fake email, phone… stays one option away
      chosen.value = new Map(tables.value.flatMap(tb => tb.columns.filter(c => c.detected).map(c => [key(tb.key, c.name), defaultKind(c)] as const)));
      if (!isAi) emptyChosen.value = new Set(tables.value.filter(tb => tb.suggestEmpty).map(tb => tb.key));
    }
  } catch (e) {
    error.value = getErrorMessage(e);
  } finally {
    loading.value = false;
  }
});

/** Every column replaced, the ones following a linked column included, with who decides */
const effective = computed(() => {
  const out = new Map<string, { kind: AnonymizeKind; via?: string }>();
  for (const [k, kind] of chosen.value) out.set(k, { kind });
  for (const [k, kind] of chosen.value) {
    for (const linked of columnsByKey.value.get(k)?.linked ?? []) if (!out.has(linked)) out.set(linked, { kind, via: k });
  }
  return out;
});

/** Kinds a column can take: also valid for every column tied to it */
const allowedKinds = (k: string): AnonymizeKind[] => {
  const column = columnsByKey.value.get(k);
  if (!column) return [];
  return column.kinds.filter(kind => column.linked.every(l => columnsByKey.value.get(l)?.kinds.includes(kind)));
};

const setKind = (k: string, value: string) => {
  const next = new Map(chosen.value);
  // One choice per group of linked columns
  for (const linked of columnsByKey.value.get(k)?.linked ?? []) next.delete(linked);
  if (value) next.set(k, value as AnonymizeKind); else next.delete(k);
  chosen.value = next;
};

/** Emptied tables: the chosen ones, then every table pointing to one (value: the table it follows) */
const emptied = computed(() => {
  const byKey = new Map(tables.value.map(tb => [tb.key, tb]));
  const out = new Map<string, string | undefined>();
  const queue: Array<[string, string | undefined]> = [...emptyChosen.value].map(k => [k, undefined]);
  while (queue.length) {
    const [k, via] = queue.shift()!;
    if (out.has(k) || !byKey.has(k)) continue;
    out.set(k, via);
    for (const child of byKey.get(k)!.referencedBy) queue.push([child, k]);
  }
  return out;
});

const anonymizedIn = (tb: PlanTable) => tb.columns.filter(c => effective.value.has(key(tb.key, c.name))).length;
const hasPersonalData = (tb: PlanTable) => (!isAi && tb.suggestEmpty) || emptied.value.has(tb.key) || tb.columns.some(c => c.detected || effective.value.has(key(tb.key, c.name)));

const visibleTables = computed(() => {
  const q = search.value.trim().toLowerCase();
  return tables.value.filter(tb => {
    if (q) return tb.key.toLowerCase().includes(q) || tb.columns.some(c => c.name.toLowerCase().includes(q));
    return showAll.value || hasPersonalData(tb);
  });
});
const visibleColumns = (tb: PlanTable) => {
  const q = search.value.trim().toLowerCase();
  if (!q || tb.key.toLowerCase().includes(q)) return tb.columns;
  return tb.columns.filter(c => c.name.toLowerCase().includes(q));
};
const isOpen = (tb: PlanTable) => open.value.has(tb.key) || !!search.value.trim();

const summary = computed(() => ({
  columns: [...effective.value.keys()].filter(k => !emptied.value.has(tableOf(k))).length,
  tables: emptied.value.size,
}));

/** mode "ai": every replaced column is saved, the ones following a linked column included */
const saveAi = async () => {
  saving.value = true;
  try {
    const columns = [...effective.value].map(([k, { kind }]) => ({ table: tableOf(k), column: k.slice(k.lastIndexOf('.') + 1), kind }));
    await ipcRenderer.invoke('ai-masking-set', props.sourceId, { enabled: enabled.value, columns });
    store.aiMaskedIds = await ipcRenderer.invoke('ai-masking-list');
    addToast(enabled.value ? t('aiMasking.savedOn', { count: columns.length }) : t('aiMasking.savedOff'), 'success');
    emit('close');
  } catch (e) {
    addToast(t('aiMasking.saveError'), 'error', { detail: getErrorMessage(e) });
  } finally {
    saving.value = false;
  }
};

const confirm = () => {
  if (loading.value || error.value || saving.value) return;
  if (isAi) {
    saveAi();
    return;
  }
  emit('confirm', {
    columns: [...chosen.value].map(([k, kind]) => ({ table: tableOf(k), column: k.slice(k.lastIndexOf('.') + 1), kind })),
    emptyTables: [...emptyChosen.value],
  });
};
</script>

<template>
  <AppModal :title="t(isAi ? 'aiMasking.title' : 'anonymize.title')" :icon="ICON_MASK" :meta="sourceLabel" width="lg" layer="top" :close-label="t('common.cancel')" @close="emit('close')" @submit="confirm">
    <div v-if="loading" class="py-10 text-center text-[13px] text-gray-500 dark:text-zinc-400" role="status">{{ t('anonymize.loading') }}</div>
    <div v-else-if="error" class="py-6" role="alert">
      <p class="text-[13px] text-gray-900 dark:text-zinc-100">{{ t('anonymize.loadError') }}</p>
      <p class="mt-1 font-mono text-[11px] text-gray-500 dark:text-zinc-400 break-words">{{ error }}</p>
    </div>

    <template v-else>
      <SwitchRow v-if="isAi" v-model="enabled" class="mb-3" :title="t('aiMasking.switch')" :description="t('aiMasking.switchHint')" />
      <!-- What it is not: a change to the data -->
      <div v-if="isAi" class="mb-3 flex items-start gap-2.5 rounded-xl border border-sky-200 dark:border-sky-900/60 bg-sky-50/70 dark:bg-sky-950/20 px-3.5 py-2.5">
        <svg class="w-4 h-4 mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <p class="text-[12px] leading-relaxed text-sky-900 dark:text-sky-200">{{ t('aiMasking.safe') }}</p>
      </div>
      <p class="mb-3 text-[12px] leading-relaxed text-gray-600 dark:text-zinc-400">{{ t(isAi ? 'aiMasking.intro' : 'anonymize.intro') }}</p>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <input v-model="search" type="search" data-own-enter :class="inputClass" class="flex-1 min-w-[12rem]" :placeholder="t('anonymize.search')" :aria-label="t('anonymize.search')" />
        <div class="flex rounded-lg border border-gray-200 dark:border-zinc-700 p-0.5 text-[12px]" role="group">
          <button type="button" class="px-2.5 py-1 rounded-md" :class="!showAll ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100' : 'text-gray-500 dark:text-zinc-400'" :aria-pressed="!showAll" @click="showAll = false">{{ t('anonymize.personalOnly') }}</button>
          <button type="button" class="px-2.5 py-1 rounded-md" :class="showAll ? 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100' : 'text-gray-500 dark:text-zinc-400'" :aria-pressed="showAll" @click="showAll = true">{{ t('anonymize.allTables', { count: tables.length }) }}</button>
        </div>
      </div>

      <p v-if="!visibleTables.length" class="py-6 text-center text-[12px] text-gray-500 dark:text-zinc-400">{{ search ? t('anonymize.noMatch') : t('anonymize.nothingDetected') }}</p>

      <ul class="space-y-2" :class="isAi && !enabled ? 'opacity-50' : ''">
        <li v-for="tb in visibleTables" :key="tb.key" class="rounded-xl border border-gray-200 dark:border-zinc-800 overflow-hidden">
          <div class="flex items-center gap-3 px-3.5 py-2.5">
            <button type="button" class="flex-1 min-w-0 flex items-center gap-2 text-left" :aria-expanded="isOpen(tb)" @click="open = toggled(open, tb.key)">
              <svg class="w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform" :class="isOpen(tb) ? 'rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
              <span class="font-mono text-[13px] truncate" :class="emptied.has(tb.key) ? 'line-through text-gray-400 dark:text-zinc-500' : 'text-gray-900 dark:text-zinc-100'">{{ shortName(tb.key) }}</span>
              <span class="shrink-0 text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums">{{ t('anonymize.rows', { count: fmt(tb.rows) }) }}</span>
              <span v-if="anonymizedIn(tb) && !emptied.has(tb.key)" class="shrink-0 px-2 py-px rounded-full text-[11px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">{{ t(isAi ? 'aiMasking.columnsCount' : 'anonymize.columnsCount', { count: anonymizedIn(tb) }) }}</span>
            </button>
            <label v-if="!isAi" class="shrink-0 flex items-center gap-1.5 text-[12px] text-gray-600 dark:text-zinc-400" :class="emptied.get(tb.key) ? 'cursor-not-allowed' : 'cursor-pointer'" :title="t('anonymize.copyRowsHint')">
              <input type="checkbox" class="accent-emerald-600" :checked="!emptied.has(tb.key)" :disabled="!!emptied.get(tb.key)" @change="emptyChosen = toggled(emptyChosen, tb.key)" />
              {{ t('anonymize.copyRows') }}
            </label>
          </div>
          <p v-if="emptied.get(tb.key)" class="px-3.5 -mt-1 pb-2 text-[11px] text-amber-700 dark:text-amber-400">{{ t('anonymize.emptiedVia', { table: shortName(emptied.get(tb.key)!) }) }}</p>
          <p v-else-if="emptied.has(tb.key) && tb.referencedBy.length" class="px-3.5 -mt-1 pb-2 text-[11px] text-amber-700 dark:text-amber-400">{{ t('anonymize.emptiesToo', { tables: tb.referencedBy.map(shortName).join(', ') }) }}</p>
          <p v-else-if="emptied.has(tb.key) && tb.suggestEmpty && !props.initial" class="px-3.5 -mt-1 pb-2 text-[11px] text-gray-500 dark:text-zinc-400">{{ t('anonymize.suggestedEmpty') }}</p>

          <ul v-if="isOpen(tb) && !emptied.has(tb.key)" class="border-t border-gray-100 dark:border-zinc-800 divide-y divide-gray-100 dark:divide-zinc-800/70">
            <li v-for="c in visibleColumns(tb)" :key="c.name" class="flex items-center gap-3 px-3.5 py-1.5">
              <span class="min-w-0 flex-1">
                <span class="font-mono text-[12px] text-gray-800 dark:text-zinc-200">{{ c.name }}</span>
                <span class="ml-2 font-mono text-[11px] text-gray-400 dark:text-zinc-500">{{ c.type }}</span>
                <span v-if="c.detected" class="ml-2 text-[11px] text-gray-500 dark:text-zinc-400">{{ t('anonymize.detected', { kind: t(`anonymize.detectedKinds.${c.detected}`) }) }}</span>
                <span v-if="effective.get(key(tb.key, c.name))?.via" class="block text-[11px] text-gray-500 dark:text-zinc-400">{{ t('anonymize.follows', { column: shortName(effective.get(key(tb.key, c.name))!.via!) }) }}</span>
                <span v-else-if="chosen.has(key(tb.key, c.name)) && c.linked.length" class="block text-[11px] text-gray-500 dark:text-zinc-400">{{ t('anonymize.alsoApplied', { columns: c.linked.map(shortName).join(', ') }) }}</span>
              </span>
              <span v-if="c.locked" class="shrink-0 text-[11px] text-gray-400 dark:text-zinc-500">{{ t(`anonymize.locked.${c.locked}`) }}</span>
              <select
                v-else
                class="shrink-0 w-44 rounded-lg border px-2 py-1 text-[12px] bg-white dark:bg-zinc-900 disabled:opacity-60"
                :class="effective.has(key(tb.key, c.name)) ? 'border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300' : 'border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-300'"
                :value="effective.get(key(tb.key, c.name))?.kind ?? ''"
                :disabled="!!effective.get(key(tb.key, c.name))?.via"
                :aria-label="t('anonymize.kindFor', { column: c.name })"
                @change="setKind(key(tb.key, c.name), ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ t('anonymize.keep') }}</option>
                <option v-for="kind in allowedKinds(key(tb.key, c.name))" :key="kind" :value="kind">{{ t(`anonymize.kinds.${kind}`) }}</option>
              </select>
            </li>
          </ul>
        </li>
      </ul>
    </template>

    <template #footer>
      <button type="button" :class="btnGhost" @click="emit('close')">{{ t('common.cancel') }}</button>
      <span class="flex-1 text-[12px] text-gray-500 dark:text-zinc-400 tabular-nums">
        <template v-if="!loading && !error">{{ isAi ? (enabled ? t('aiMasking.summary', { columns: summary.columns }) : t('aiMasking.summaryOff')) : t('anonymize.summary', { columns: summary.columns, tables: summary.tables }) }}</template>
      </span>
      <button type="button" :class="btnPrimary" :disabled="loading || !!error || saving" @click="confirm">{{ t(isAi ? 'aiMasking.save' : 'anonymize.confirm') }}</button>
    </template>
  </AppModal>
</template>

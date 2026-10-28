<script setup lang="ts">
/**
 * One dashboard: its blocks (OpenUI, data read live, read only: 'execute-sql' for PostgreSQL,
 * 'dashboards-aggregate' for MongoDB), a
 * toolbar (name, refresh, automatic refresh, more) and the AI editor on the right. Each block
 * has its own menu (type, width, order, title, SQL, CSV…); filters bind {{from}}, {{to}} and
 * {{name}} as SQL parameters. Opening runs every query; "Refresh" runs them again and keeps the
 * data on screen meanwhile.
 */
import { computed, h, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { Renderer, type OpenUIError, type ParseResult } from '@openuidev/vue-lang';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { useFeatures } from '../../composables/useFeatures';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { ipcRenderer, shell } from '../../electron';
import { CHAT_TOOLS, chatSettings } from '../../chat/chatSettings';
import type { ChatProviderId } from '../../chat/chatEvents';
import { DASHBOARD_CONTEXT, dashboardLibrary, type BlockInfo, type BlockLayout } from '../../dashboards/dashboardLibrary';
import { bindFilters, bindMongoFilters, bindSqlParams, dashboardFamily, mongoDashboardQuery, periodRange, toMongoQueryResult, toQueryResult, type QueryResult } from '../../dashboards/dashboardProgram';
import { engineOf } from '../../../../shared/engines/features';
import {
  blockLabels, blockQueries, blockTitle, blockType, changeType, duplicateBlock, kpiItems, moveBlock, moveBlockTo, parseStatements, splitKpis, querySql, removeBlock, setBlockTitle, setQuerySql, typeChoices,
} from '../../dashboards/programEdit';
import { toTsv, toXlsx, type Sheet } from '../../dashboards/spreadsheet';
import { formatValue, toCsv } from '../../dashboards/valueFormat';
import { REFRESH_CHOICES, useDashboards, type DashboardSession, type DashboardTheme } from '../../dashboards/useDashboards';
import ChatMessages from '../chat/ChatMessages.vue';
import AiChatSettingsModal from '../chat/AiChatSettingsModal.vue';
import ActionMenu, { type ActionMenuItem } from '../ActionMenu.vue';
import AppModal from '../ui/AppModal.vue';
import FormField from '../ui/FormField.vue';
import { btnGhost, btnPrimary, btnSecondary, inputClass, selectClass } from '../ui/classes';

const props = defineProps<{ databaseId: string; dashboardId: string }>();
const emit = defineEmits<{ close: [] }>();

const { t, currentLanguage } = useI18n();
const { isEnabled } = useFeatures();
const { addToast } = useToast();
const { showConfirm } = useConfirm();
const { open, ask, stop, undo, update, setProgram, saveFilters: saveDashboardFilters, copyTo, resetChat, remove } = useDashboards();

const db = computed(() => store.databases.find(d => d.id === props.databaseId));
const dbName = computed(() => db.value?.displayName || db.value?.name || '');
const dbShown = computed(() => (db.value?.masked ? '••••••••' : dbName.value));
const labelOf = (id: string) => {
  const d = store.databases.find(x => x.id === id);
  return d ? (d.masked ? '••••••••' : d.displayName || d.name) : '';
};

const session = ref<DashboardSession | null>(null);
const failed = ref(false);
/** Ready to render: the dashboard, and its kept results when the user asked for them */
const ready = ref(false);
const dashboard = computed(() => session.value?.dashboard ?? null);
const chat = computed(() => session.value?.chat ?? null);
const program = computed(() => dashboard.value?.program ?? '');
const busy = computed(() => !!chat.value?.busy);

// --- Filters: {{from}}, {{to}} and {{name}} bound as parameters --------------------------------
const defaultPeriod = computed(() => /PeriodFilter\(\s*"(\w+)"/.exec(program.value)?.[1] ?? '30d');
const period = ref<{ preset: string; from?: string; to?: string }>({ preset: '30d' });
const filterValues = ref<Record<string, string | null>>({});
const filterLabels = ref<Record<string, string>>({});
const boundValues = () => {
  const range = periodRange(period.value.preset, new Date(), period.value);
  return { ...filterValues.value, from: range.from, to: range.to };
};
/** The filters as chosen (a period, not its timestamps): results are kept by it */
const filterKey = () => JSON.stringify({ period: period.value, values: filterValues.value });
/** Filters are saved apart, a moment after the last change: the dashboard itself is not rewritten */
let filtersTimer: ReturnType<typeof setTimeout> | undefined;
const saveFilters = () => {
  clearTimeout(filtersTimer);
  filtersTimer = setTimeout(() => {
    if (session.value) void saveDashboardFilters(session.value, { period: { ...period.value }, values: { ...filterValues.value }, labels: { ...filterLabels.value } });
  }, 600);
};
onUnmounted(() => clearTimeout(filtersTimer));

// --- Data: every Query runs read only, on the database's engine -------------------------------
const engine = computed(() => engineOf(db.value));
/** One block's query with the filters bound as values (never pasted into SQL) */
const runQuery = async (query: string): Promise<QueryResult> => {
  if (engine.value === 'mongodb') {
    const { collection, pipeline } = mongoDashboardQuery(bindMongoFilters(query, boundValues()));
    return toMongoQueryResult(await ipcRenderer.invoke('dashboards-aggregate', { db: { id: props.databaseId }, query: { collection, pipeline, limit: 1000 } }));
  }
  // MySQL, MariaDB, SQLite: ? parameters; PostgreSQL: $n with their types
  const { text, params } = engine.value === 'postgresql' ? bindFilters(query, boundValues()) : bindSqlParams(query, boundValues());
  return toQueryResult(await ipcRenderer.invoke('execute-sql', { db: { id: props.databaseId }, sql: text, params, maxRows: 1000, timeoutMs: 30000 }));
};
const inflight = ref(0);
const refreshedAt = ref<number | null>(null);
/** Queries that failed, by SQL text (cleared when one runs again without error) */
const failures = ref(new Map<string, string>());
/** Time each query took (by SQL text), and its last result (CSV, kept results) */
const durations = ref(new Map<string, number>());
const results = new Map<string, QueryResult>();
/** Results kept from the last time (shown at once, then refreshed) */
let cached: Record<string, QueryResult> | null = null;

const runTool = async (args: Record<string, unknown>) => {
  const query = String(args?.query ?? '').trim();
  const key = `${query}\u0000${filterKey()}`;
  if (cached?.[key]) {
    const hit = cached[key];
    delete cached[key];
    return hit;
  }
  inflight.value++;
  const startedAt = Date.now();
  try {
    const result = await runQuery(query);
    if (failures.value.has(query)) {
      const next = new Map(failures.value);
      next.delete(query);
      failures.value = next;
    }
    // The latest result per query and filters, at most 200 (the oldest go first)
    results.delete(key);
    results.set(key, result);
    while (results.size > 200) results.delete(results.keys().next().value!);
    return result;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    failures.value = new Map(failures.value).set(query, message);
    throw error;
  } finally {
    durations.value = new Map(durations.value).set(query, Date.now() - startedAt);
    inflight.value--;
    refreshedAt.value = Date.now();
  }
};
/** Query("sql", …) on PostgreSQL, Query("mongo", …) on MongoDB: the same runner */
const tools = { sql: runTool, mongo: runTool, mysql: runTool, sqlite: runTool };

/** Blocks the renderer could not build (wrong arguments, unknown component…) */
const renderErrors = ref<OpenUIError[]>([]);
const onErrors = (errors: OpenUIError[]) => {
  renderErrors.value = errors.filter(e => e.source !== 'query' && e.source !== 'mutation');
  if (renderErrors.value.length) console.warn('Dashboard program errors', JSON.stringify(renderErrors.value));
};

/** The failures of queries still in the program, then the blocks that could not be built */
const shownFailures = computed(() => [
  ...[...failures.value.entries()]
    .filter(([sql]) => program.value.includes(JSON.stringify(sql).slice(1, -1)))
    .map(([sql, message]) => ({ sql, message })),
  ...renderErrors.value.map(e => ({ sql: [e.statementId, e.component, e.path].filter(Boolean).join(' · '), message: e.hint ? `${e.message} (${e.hint})` : e.message })),
]);
const showFailures = ref(false);

const tick = ref(0);
const queryIds = ref<string[]>([]);
const onParse = (result: ParseResult | null) => {
  queryIds.value = (result?.queryStatements ?? []).map(q => q.statementId);
};
/**
 * Runs every query again. A query still running is fetched again once it ends, so a filter
 * changed meanwhile is never lost; only the automatic refresh waits for a quiet moment.
 */
const refresh = (whenIdle = false) => {
  if (!program.value || (whenIdle && inflight.value)) return;
  tick.value++;
};
/** A thin bar while queries run (the renderer's own loader) */
const queryLoader = h('div', { class: 'dash-loader absolute inset-x-0 -top-2 h-0.5 overflow-hidden rounded-full' }, h('div', { class: 'dash-loader-bar h-full w-1/3', style: { background: 'var(--dash-c1)' } }));

const refreshedLabel = computed(() => {
  if (inflight.value) return t('dashboards.refreshing');
  if (!refreshedAt.value) return '';
  const time = new Date(refreshedAt.value).toLocaleTimeString(currentLanguage.value, { hour: '2-digit', minute: '2-digit' });
  return t('dashboards.refreshedAt', { time });
});

// Automatic refresh while the dashboard is shown (not while the window is hidden)
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => dashboard.value?.refreshSeconds, seconds => {
  clearInterval(timer);
  if (seconds) timer = setInterval(() => { if (!document.hidden) refresh(true); }, seconds * 1000);
}, { immediate: true });
onUnmounted(() => clearInterval(timer));

const setRefresh = async (seconds: number) => {
  if (!session.value) return;
  if (!(await update(session.value, { refreshSeconds: seconds }))) addToast(t('dashboards.saveError'), 'error');
};

// Kept results: saved a moment after the queries settle, only those of the current program
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
watch(inflight, count => {
  if (count || !dashboard.value?.cacheResults) return;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    // Only the results of the program as it is, with the filters as they are
    const kept: Record<string, QueryResult> = {};
    const current = filterKey();
    for (const [key, result] of results) {
      const [sql, filters] = key.split('\u0000');
      if (filters === current && program.value.includes(JSON.stringify(sql).slice(1, -1))) kept[key] = result;
    }
    void ipcRenderer.invoke('dashboards-cache-set', props.databaseId, props.dashboardId, JSON.parse(JSON.stringify(kept)));
  }, 1000);
});
onUnmounted(() => clearTimeout(cacheTimer));

// --- Theme --------------------------------------------------------------------------------------
const PALETTES: Record<string, string[]> = {
  emerald: ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#ec4899', '#64748b'],
  blue: ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#64748b'],
  violet: ['#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ec4899', '#3b82f6', '#ef4444', '#64748b'],
  amber: ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899', '#64748b'],
  rose: ['#f43f5e', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#a855f7', '#64748b'],
  slate: ['#475569', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#94a3b8'],
};
const theme = computed<DashboardTheme>(() => dashboard.value?.theme ?? { accent: 'emerald', density: 'comfortable' });
const canvasStyle = computed(() => {
  const palette = PALETTES[theme.value.accent] ?? PALETTES.emerald;
  const compact = theme.value.density === 'compact';
  return {
    ...Object.fromEntries(palette.map((c, i) => [`--dash-c${i + 1}`, c])),
    '--dash-gap': compact ? '8px' : '16px',
    '--dash-pad': compact ? '8px 10px' : '12px 14px',
    '--dash-chart-h': compact ? '6rem' : '8rem',
    '--dash-table-h': compact ? '14rem' : '20rem',
  };
});

// --- Blocks -----------------------------------------------------------------------------------
const showHidden = ref(false);
const layoutOf = (id: string): BlockLayout => dashboard.value?.layout?.[id] ?? {};
const hiddenCount = computed(() => Object.entries(dashboard.value?.layout ?? {})
  .filter(([id, l]) => l.hidden && new RegExp(`(^|\\n)${id} = `).test(program.value)).length);

const SLOW_MS = 3000;
const blockInfo = (id: string): BlockInfo => {
  const queries = blockQueries(program.value, id);
  const sqls = queries.map(q => querySql(program.value, q) ?? '');
  const slowest = Math.max(0, ...sqls.map(sql => durations.value.get(sql) ?? 0));
  return {
    title: blockTitle(program.value, id),
    types: typeChoices(program.value, id),
    queries: queries.length,
    slowMs: slowest >= SLOW_MS ? slowest : null,
    failed: sqls.some(sql => failures.value.has(sql)),
    splittable: kpiItems(program.value, id).length > 1,
  };
};

const withLayout = (id: string, change: BlockLayout | null): Record<string, BlockLayout> => {
  const layout = { ...(dashboard.value?.layout ?? {}) };
  if (change === null) delete layout[id];
  else {
    const next = { ...layout[id], ...change };
    if (!next.hidden) delete next.hidden;
    if (next.span === undefined) delete next.span;
    if (next.height === undefined) delete next.height;
    if (Object.keys(next).length) layout[id] = next; else delete layout[id];
  }
  return layout;
};

const applyProgram = async (next: string, layout?: Record<string, BlockLayout>) => {
  if (!session.value) return;
  if (!(await setProgram(session.value, next, layout))) addToast(t('dashboards.saveError'), 'error');
};

/** The last result of a query of the program */
const resultOf = (query: string): QueryResult | undefined => {
  const sql = querySql(program.value, query);
  return sql ? [...results.entries()].reverse().find(([key]) => key.startsWith(`${sql}\u0000`))?.[1] : undefined;
};

/** A block's data as a sheet: its first query, with the headers the block shows */
const sheetOf = (id: string, query = blockQueries(program.value, id)[0]): Sheet | null => {
  const result = query ? resultOf(query) : undefined;
  if (!result) return null;
  const labels = blockLabels(program.value, id);
  return {
    // A block without a title: named after what it is (key figures), not its internal name
    name: blockTitle(program.value, id) || (blockType(program.value, id) === 'Kpis' ? t('dashboards.sheetFigures') : id),
    columns: result.columns,
    rows: result.rows,
    ...(labels && labels.length === result.columns.length ? { labels } : {}),
  };
};

const DATA_BLOCKS = new Set(['Table', 'Record', 'Kpis', 'Progress', 'BarChart', 'LineChart', 'AreaChart', 'DonutChart', 'MultiLineChart', 'MultiBarChart', 'StackedBarChart', 'Heatmap']);
/** Every query of the dashboard once, named after the first block that shows it */
const allSheets = (): Sheet[] => {
  const seen = new Set<string>();
  const sheets: Sheet[] = [];
  for (const s of parseStatements(program.value)) {
    if (!DATA_BLOCKS.has(blockType(program.value, s.name) ?? '')) continue;
    for (const query of blockQueries(program.value, s.name)) {
      if (seen.has(query)) continue;
      seen.add(query);
      const sheet = sheetOf(s.name, query);
      if (sheet) sheets.push(sheet);
    }
  }
  return sheets;
};

const saveXlsx = async (sheets: Sheet[], name: string) => {
  if (!sheets.length) return;
  const saved = await ipcRenderer.invoke('dashboards-save-xlsx', name, toXlsx(sheets));
  if (saved?.success) addToast(t('dashboards.xlsxSaved'), 'success', { action: { label: t('dashboards.showFile'), run: () => shell.showItemInFolder(saved.path) } });
  else if (saved && !saved.success) addToast(t('dashboards.saveError'), 'error', { detail: saved.error });
};

const copyBlock = async (id: string) => {
  const sheet = sheetOf(id);
  if (!sheet) return;
  try {
    await navigator.clipboard.writeText(toTsv(sheet, currentLanguage.value));
    addToast(t('dashboards.copiedRows', { count: sheet.rows.length }), 'success');
  } catch (error) {
    addToast(t('dashboards.saveError'), 'error', { detail: error instanceof Error ? error.message : String(error) });
  }
};

const saveCsv = async (id: string) => {
  // The same headers as on screen and in Excel
  const sheet = sheetOf(id);
  if (!sheet) return;
  const name = `${dashboard.value?.title || 'dashboard'} - ${sheet.name}`;
  const saved = await ipcRenderer.invoke('dashboards-save-csv', name, toCsv(sheet.columns, sheet.rows, currentLanguage.value, sheet.labels));
  if (saved?.success) addToast(t('dashboards.csvSaved'), 'success', { action: { label: t('dashboards.showFile'), run: () => shell.showItemInFolder(saved.path) } });
  else if (saved && !saved.success) addToast(t('dashboards.saveError'), 'error', { detail: saved.error });
};

const blockAction = (id: string, key: string, payload?: unknown) => {
  const current = program.value;
  switch (key) {
    case 'ai':
      focus.value = id;
      editorOpen.value = true;
      void nextTick(() => input.value?.focus());
      break;
    case 'explain':
      if (session.value && toolReady.value && !busy.value) {
        editorOpen.value = true;
        void ask(session.value, t('dashboards.explainRequest', { name: blockTitle(current, id) || id }), id);
      } else if (!toolReady.value) {
        editorOpen.value = true;
      }
      break;
    case 'xlsx': {
      const sheet = sheetOf(id);
      if (sheet) void saveXlsx([sheet], `${dashboard.value?.title || 'dashboard'} - ${sheet.name}`);
      break;
    }
    case 'copy':
      void copyBlock(id);
      break;
    case 'rename':
      renaming.value = { id, title: blockTitle(current, id) ?? '' };
      break;
    case 'sql':
      openSql(id);
      break;
    case 'type':
      void applyProgram(changeType(current, id, String(payload)));
      break;
    case 'span':
      void applyProgram(current, withLayout(id, { span: Number(payload) === 12 && !layoutOf(id).span ? undefined : Number(payload) }));
      break;
    case 'split':
      void applyProgram(splitKpis(current, id).program);
      break;
    case 'moveTo': {
      const { target, side } = payload as { target: string; side: 'before' | 'after' };
      void applyProgram(moveBlockTo(current, id, target, side));
      break;
    }
    case 'resize': {
      const size = payload as { span?: number; height?: number; reset?: boolean };
      void applyProgram(current, withLayout(id, size.reset ? { span: undefined, height: undefined } : { span: size.span, height: size.height }));
      break;
    }
    case 'up':
    case 'down':
      void applyProgram(moveBlock(current, id, key === 'up' ? -1 : 1));
      break;
    case 'csv':
      void saveCsv(id);
      break;
    case 'duplicate': {
      const copy = duplicateBlock(current, id);
      void applyProgram(copy.program, layoutOf(id).span ? withLayout(copy.id, { span: layoutOf(id).span }) : undefined);
      break;
    }
    case 'hide':
    case 'show':
      void applyProgram(current, withLayout(id, { hidden: key === 'hide' }));
      break;
    case 'delete':
      showConfirm({
        title: t('dashboards.block.deleteTitle'),
        message: t('dashboards.block.deleteMessage', { name: blockTitle(current, id) || id }),
        confirmText: t('dashboards.delete'),
        type: 'danger',
        onConfirm: () => applyProgram(removeBlock(program.value, id), withLayout(id, null)),
      });
      break;
  }
};

provide(DASHBOARD_CONTEXT, {
  tick,
  queryIds: () => queryIds.value,
  layout: layoutOf,
  showHidden,
  editable: ref(true),
  dragging: ref<string | null>(null),
  dropHint: ref(null),
  info: blockInfo,
  action: blockAction,
  filters: {
    period,
    values: filterValues,
    labels: filterLabels,
    setPeriod: next => { period.value = next; saveFilters(); refresh(); },
    setValue: (name, value, label) => {
      filterValues.value = { ...filterValues.value, [name]: value };
      const labels = { ...filterLabels.value };
      if (value !== null && label) labels[name] = label; else delete labels[name];
      filterLabels.value = labels;
      saveFilters();
      refresh();
    },
  },
});

// Rename a block
const renaming = ref<{ id: string; title: string } | null>(null);
const saveRename = async () => {
  const r = renaming.value;
  renaming.value = null;
  if (r) await applyProgram(setBlockTitle(program.value, r.id, r.title.trim()));
};

// The SQL of a block, by hand: tried before it is saved
interface SqlDraft { name: string; sql: string; original: string; test: { busy: boolean; ok?: boolean; text?: string; columns?: string[]; rows?: Array<Record<string, unknown>> } }
const sqlBlock = ref<string | null>(null);
const sqlDrafts = ref<SqlDraft[]>([]);
/** A MongoDB query is kept on one line in the program, shown laid out to be edited */
const reshape = (text: string, indent?: number) => {
  if (engine.value !== 'mongodb') return text;
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    return text;
  }
};
const openSql = (id: string) => {
  sqlBlock.value = id;
  sqlDrafts.value = blockQueries(program.value, id).map(name => {
    const sql = reshape(querySql(program.value, name) ?? '', 2);
    return { name, sql, original: sql, test: { busy: false } };
  });
};
const testSql = async (draft: SqlDraft) => {
  draft.test = { busy: true };
  const startedAt = Date.now();
  try {
    const result = await runQuery(draft.sql.trim());
    draft.test = { busy: false, ok: true, text: t('dashboards.sqlOk', { count: result.rows.length, ms: Date.now() - startedAt }), columns: result.columns, rows: result.rows.slice(0, 5) };
  } catch (error) {
    draft.test = { busy: false, ok: false, text: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
};
const saveSql = async () => {
  let next = program.value;
  for (const d of sqlDrafts.value) if (d.sql.trim() && d.sql !== d.original) next = setQuerySql(next, d.name, reshape(d.sql));
  sqlBlock.value = null;
  await applyProgram(next);
};

// --- Name ---------------------------------------------------------------------------------
const editingTitle = ref(false);
const titleDraft = ref('');
const titleInput = ref<HTMLInputElement | null>(null);
const startRename = async () => {
  titleDraft.value = dashboard.value?.title ?? '';
  editingTitle.value = true;
  await nextTick();
  titleInput.value?.select();
};
const saveTitle = async () => {
  if (!editingTitle.value || !session.value) return;
  editingTitle.value = false;
  const title = titleDraft.value.trim();
  if (!title || title === session.value.dashboard.title) return;
  if (!(await update(session.value, { title }))) addToast(t('dashboards.saveError'), 'error');
};

// --- AI editor ----------------------------------------------------------------------------
const editorOpen = ref(false);
const draft = ref('');
/** The block the next request is about */
const focus = ref<string | null>(null);
const focusLabel = computed(() => (focus.value ? blockTitle(program.value, focus.value) || focus.value : ''));
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const installed = ref<Record<ChatProviderId, boolean> | null>(null);
const showSettings = ref(false);
const providerLabel = (id: ChatProviderId) => CHAT_TOOLS.find(p => p.id === id)?.label ?? id;
const toolReady = computed(() => !!installed.value?.[chatSettings.provider]);
const modelLabel = computed(() => chatSettings.models[chatSettings.provider] || t('chat.settings.defaultShort'));

const scrollDown = () => nextTick(() => {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
});
watch(() => (chat.value ? JSON.stringify(chat.value.messages).length : 0), () => void scrollDown());

const submit = async (text = draft.value) => {
  if (!session.value || !text.trim() || busy.value) return;
  draft.value = '';
  editorOpen.value = true;
  const aimed = focus.value;
  focus.value = null;
  void scrollDown();
  await ask(session.value, text, aimed);
};
const onEnter = (event: KeyboardEvent) => {
  if (event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void submit();
};
const autoGrow = () => {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
};
watch(draft, () => nextTick(autoGrow));
const suggestions = computed(() => [t('dashboards.suggestChart'), t('dashboards.suggestKpi'), t('dashboards.suggestFilter')]);

/** The failing blocks, sent to the AI to fix */
const fixRequest = () => t('dashboards.fixRequest', { errors: shownFailures.value.map(f => `- ${f.message}\n  ${f.sql}`).join('\n') });
const fixWithAi = () => {
  showFailures.value = false;
  void submit(fixRequest());
};

// After an AI change: once its queries have run, failing ones go back to the AI, once
let checkTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => session.value?.justChanged, changed => {
  if (!changed) return;
  clearTimeout(checkTimer);
  checkTimer = setTimeout(function check() {
    const s = session.value;
    if (!s || s.chat.busy) return;
    if (inflight.value) { checkTimer = setTimeout(check, 400); return; }
    if (shownFailures.value.length && s.repairs < 1 && toolReady.value) {
      s.repairs++;
      editorOpen.value = true;
      void ask(s, `${t('dashboards.autoRepair')}\n${fixRequest()}`, null, true);
    }
  }, 600);
});
onUnmounted(() => clearTimeout(checkTimer));

// --- More ---------------------------------------------------------------------------------
const showCode = ref(false);
const showAppearance = ref(false);
const copying = ref<{ databaseId: string } | null>(null);
// A dashboard can be copied to another database whose engine has dashboards
// Same engine only: the queries are SQL or MongoDB aggregations
const otherDatabases = computed(() => store.databases.filter(d => d.id !== props.databaseId && isEnabled(d, 'dashboards') && dashboardFamily(engineOf(d)) === dashboardFamily(engine.value)));
const menuItems = computed<ActionMenuItem[]>(() => [
  ...(dashboard.value?.versions.length ? [{ key: 'undo', label: t('dashboards.menu.undo'), icon: 'M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3' }] : []),
  { key: 'appearance', label: t('dashboards.menu.appearance'), icon: 'M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z' },
  ...(hiddenCount.value ? [{ key: 'hidden', label: showHidden.value ? t('dashboards.menu.hideHidden') : t('dashboards.menu.showHidden', { count: hiddenCount.value }), icon: 'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z' }] : []),
  { key: 'pin', label: dashboard.value?.pinned ? t('dashboards.menu.unpin') : t('dashboards.menu.pin'), icon: 'M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4 1-3z' },
  { key: 'cache', label: dashboard.value?.cacheResults ? t('dashboards.menu.cacheOff') : t('dashboards.menu.cache'), icon: 'M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375' },
  ...(program.value ? [
    { key: 'pdf', label: t('dashboards.menu.pdf'), icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z', separated: true },
    { key: 'xlsx', label: t('dashboards.menu.xlsx'), icon: 'M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M20.625 12c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5M12 14.625v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 14.625c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m0 1.5v-1.5m0 0c0-.621.504-1.125 1.125-1.125m0 0h7.5' },
    { key: 'file', label: t('dashboards.menu.file'), icon: 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3' },
    ...(otherDatabases.value.length ? [{ key: 'copy', label: t('dashboards.menu.copy'), icon: 'M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75' }] : []),
    { key: 'code', label: t('dashboards.menu.code'), icon: 'M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5' },
  ] : []),
  ...(chat.value?.messages.length ? [{ key: 'new-chat', label: t('dashboards.menu.newChat'), icon: 'M12 4v16m8-8H4' }] : []),
  { key: 'delete', label: t('dashboards.menu.delete'), icon: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16', tone: 'danger', separated: true },
]);

/** The dashboard alone, printed to PDF: a copy of it is shown on its own while printing */
const canvas = ref<HTMLElement | null>(null);
const exportPdf = async () => {
  if (!canvas.value) return;
  const sheet = document.createElement('div');
  sheet.className = 'dash-print-root';
  const heading = document.createElement('div');
  heading.className = 'dash-print-title';
  heading.textContent = `${dashboard.value?.title ?? ''} · ${dbShown.value} · ${new Date().toLocaleString(currentLanguage.value)}`;
  sheet.append(heading, canvas.value.cloneNode(true));
  document.body.appendChild(sheet);
  // Printed light, as on paper
  const dark = document.documentElement.classList.contains('dark');
  document.documentElement.classList.remove('dark');
  try {
    const saved = await ipcRenderer.invoke('dashboards-export-pdf', dashboard.value?.title);
    if (saved?.success) addToast(t('dashboards.pdfSaved'), 'success', { action: { label: t('dashboards.showFile'), run: () => shell.showItemInFolder(saved.path) } });
    else if (saved && !saved.success) addToast(t('dashboards.saveError'), 'error', { detail: saved.error });
  } finally {
    sheet.remove();
    if (dark) document.documentElement.classList.add('dark');
  }
};

const onMenu = async (key: string) => {
  const s = session.value;
  if (!s) return;
  if (key === 'undo') {
    if (await undo(s)) addToast(t('dashboards.undone'), 'success');
  } else if (key === 'appearance') {
    showAppearance.value = true;
  } else if (key === 'hidden') {
    showHidden.value = !showHidden.value;
  } else if (key === 'pin') {
    const pinned = !s.dashboard.pinned;
    if (await update(s, { pinned })) addToast(pinned ? t('dashboards.pinned') : t('dashboards.unpinned'), 'success');
  } else if (key === 'cache') {
    const on = !s.dashboard.cacheResults;
    await update(s, { cacheResults: on });
    if (!on) void ipcRenderer.invoke('dashboards-cache-set', props.databaseId, props.dashboardId, null);
    addToast(on ? t('dashboards.cacheOn') : t('dashboards.cacheOffDone'), 'success');
  } else if (key === 'pdf') {
    await exportPdf();
  } else if (key === 'xlsx') {
    await saveXlsx(allSheets(), dashboard.value?.title || 'dashboard');
  } else if (key === 'file') {
    const saved = await ipcRenderer.invoke('dashboards-export-file', props.databaseId, props.dashboardId);
    if (saved?.success) addToast(t('dashboards.fileSaved'), 'success', { action: { label: t('dashboards.showFile'), run: () => shell.showItemInFolder(saved.path) } });
    else if (saved && !saved.success) addToast(t('dashboards.saveError'), 'error', { detail: saved.error });
  } else if (key === 'copy') {
    copying.value = { databaseId: otherDatabases.value[0]?.id ?? '' };
  } else if (key === 'code') {
    showCode.value = true;
  } else if (key === 'new-chat') {
    await resetChat(s);
  } else if (key === 'delete') {
    showConfirm({
      title: t('dashboards.deleteTitle'),
      message: t('dashboards.deleteMessage', { title: s.dashboard.title || t('dashboards.untitled') }),
      confirmText: t('dashboards.delete'),
      type: 'danger',
      onConfirm: async () => {
        await remove(s.dashboard.databaseId, s.dashboard.id);
        addToast(t('dashboards.deleted'), 'success');
        emit('close');
      },
    });
  }
};

const setTheme = (patch: Partial<DashboardTheme>) => {
  if (session.value) void update(session.value, { theme: { ...theme.value, ...patch } });
};

const confirmCopy = async () => {
  const target = copying.value?.databaseId;
  copying.value = null;
  if (!session.value || !target) return;
  const copy = await copyTo(session.value, target, labelOf(target));
  if (!copy) {
    addToast(t('dashboards.createError'), 'error');
    return;
  }
  addToast(t('dashboards.copied', { name: labelOf(target) }), 'success');
  store.openDashboard = { databaseId: copy.dashboard.databaseId, id: copy.dashboard.id };
};

const onKey = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  if (showSettings.value || showCode.value || editingTitle.value || renaming.value || sqlBlock.value || showAppearance.value || copying.value) return;
  if (editorOpen.value) editorOpen.value = false;
};

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  session.value = await open(props.databaseId, props.dashboardId, dbName.value);
  if (!session.value) {
    failed.value = true;
    addToast(t('dashboards.openFailed'), 'error');
    return;
  }
  const saved = session.value.dashboard.filters;
  period.value = saved?.period ?? { preset: defaultPeriod.value };
  // A dashboard being built: its period comes with the AI's program (unless the user chose one)
  watch(defaultPeriod, preset => {
    if (!session.value?.dashboard.filters?.period && period.value.preset !== preset) {
      period.value = { preset };
      refresh();
    }
  });
  filterValues.value = { ...(saved?.values ?? {}) };
  filterLabels.value = { ...(saved?.labels ?? {}) };
  if (session.value.dashboard.cacheResults) {
    try {
      cached = await ipcRenderer.invoke('dashboards-cache-get', props.databaseId, props.dashboardId);
    } catch {
      cached = null;
    }
  }
  ready.value = true;
  // Kept results shown first: fresh ones right after
  if (cached && Object.keys(cached).length) {
    setTimeout(() => { cached = null; refresh(); }, 300);
  }
  // Empty or being built: the editor is where things happen
  editorOpen.value = !program.value || busy.value;
  void scrollDown();
  try {
    const list: Array<{ id: ChatProviderId; installed: boolean }> = await ipcRenderer.invoke('ai-chat-providers');
    installed.value = Object.fromEntries(list.map(p => [p.id, p.installed])) as Record<ChatProviderId, boolean>;
  } catch {
    installed.value = { claude: false, codex: false, opencode: false, ollama: false, lmstudio: false };
  }
});
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="dash-view h-full flex flex-col min-h-0">
    <!-- Toolbar -->
    <div class="shrink-0 flex items-center gap-2 mb-4">
      <button type="button" :class="btnGhost" class="!px-2 -ml-2" :title="t('dashboards.back')" @click="emit('close')">
        <svg class="dash-back w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>
        <span class="text-[13px]">{{ t('dashboards.back') }}</span>
      </button>
      <span class="text-gray-300 dark:text-zinc-700">/</span>
      <div class="flex-1 min-w-0 flex items-baseline gap-2">
        <input
          v-if="editingTitle"
          ref="titleInput"
          v-model="titleDraft"
          maxlength="120"
          class="min-w-0 flex-1 bg-transparent outline-none border-b border-emerald-500 text-[17px] font-bold tracking-tight"
          @keydown.enter.prevent="saveTitle"
          @keydown.esc.prevent="editingTitle = false"
          @blur="saveTitle"
        />
        <button v-else type="button" class="min-w-0 truncate text-left text-[17px] font-bold tracking-tight hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors" :title="t('dashboards.rename')" @click="startRename">
          {{ dashboard?.title || t('dashboards.untitled') }}
        </button>
        <span class="shrink-0 text-[12px] text-gray-400 dark:text-zinc-500 truncate">{{ dbShown }}</span>
        <svg v-if="dashboard?.pinned" class="shrink-0 w-3 h-3 text-gray-400 self-center" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4 1-3z" /></svg>
      </div>

      <template v-if="dashboard">
        <span class="hidden md:inline text-[11px] text-gray-400 dark:text-zinc-500 tabular-nums whitespace-nowrap" aria-live="polite">{{ refreshedLabel }}</span>
        <button type="button" :class="btnSecondary" :disabled="!program || inflight > 0" :title="t('dashboards.refresh')" @click="refresh()">
          <svg class="w-4 h-4" :class="{ 'animate-spin': inflight > 0 }" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          <span class="hidden lg:inline">{{ t('dashboards.refresh') }}</span>
        </button>
        <select
          :value="dashboard.refreshSeconds"
          class="h-9 pl-2.5 pr-7 rounded-lg text-[12px] border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-gray-700 dark:text-zinc-200 cursor-pointer outline-none focus:border-emerald-500"
          :title="t('dashboards.auto.label')"
          :aria-label="t('dashboards.auto.label')"
          @change="setRefresh(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="s in REFRESH_CHOICES" :key="s" :value="s">{{ s ? t(`dashboards.auto.s${s}`) : t('dashboards.auto.off') }}</option>
        </select>
        <button
          type="button"
          class="dash-ai-button h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
          :class="editorOpen ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'"
          :aria-pressed="editorOpen"
          @click="editorOpen = !editorOpen"
        >
          <svg class="dash-sparkle w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" /></svg>
          <span class="hidden sm:inline">{{ t('dashboards.edit') }}</span>
          <span v-if="busy" class="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
        </button>
        <ActionMenu :items="menuItems" :label="t('dashboards.menu.label')" @select="onMenu" />
      </template>
    </div>

    <p v-if="failed" class="text-[13px] text-gray-500 dark:text-zinc-400">{{ t('dashboards.openFailed') }}</p>

    <div v-else-if="dashboard && chat" class="flex-1 min-h-0 flex gap-4">
      <!-- The dashboard -->
      <div class="relative flex-1 min-w-0 overflow-y-auto pb-6 pr-3">
        <!-- Blocks that failed to load: why, and a way to get them fixed -->
        <div v-if="shownFailures.length" class="mb-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 text-[12px] text-amber-800 dark:text-amber-300">
          <div class="flex items-center gap-2 px-3.5 py-2.5">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
            <button type="button" class="flex-1 text-left hover:underline underline-offset-2" :aria-expanded="showFailures" @click="showFailures = !showFailures">{{ t('dashboards.queryErrors', { count: shownFailures.length }) }}</button>
            <button type="button" class="shrink-0 h-7 px-2.5 rounded-md font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50" :disabled="busy || !toolReady" @click="fixWithAi">{{ t('dashboards.fix') }}</button>
          </div>
          <ul v-if="showFailures" class="px-3.5 pb-3 space-y-2">
            <li v-for="f in shownFailures" :key="f.sql">
              <div>{{ f.message }}</div>
              <pre class="mt-1 rounded-md bg-white/70 dark:bg-zinc-950/60 px-2 py-1.5 font-mono text-[10.5px] text-gray-600 dark:text-zinc-400 whitespace-pre-wrap break-words">{{ f.sql }}</pre>
            </li>
          </ul>
        </div>

        <div v-if="program && ready" ref="canvas" class="dash-canvas relative" :style="canvasStyle">
          <Renderer
            :response="program"
            :library="dashboardLibrary"
            :tool-provider="tools"
            :query-loader="queryLoader"
            :on-parse-result="onParse"
            :on-error="onErrors"
          />
        </div>

        <!-- Being built: blocks taking shape -->
        <div v-else-if="busy" class="h-full min-h-[320px] flex flex-col">
          <div class="flex items-center gap-2 mb-4 text-[13px] text-gray-600 dark:text-zinc-300">
            <span class="w-4 h-4 rounded-full border-2 border-emerald-500/30 border-t-emerald-500 animate-spin" />
            <span class="font-medium">{{ t('dashboards.building') }}</span>
            <span class="text-gray-400 dark:text-zinc-500">· {{ t('dashboards.buildingDesc') }}</span>
          </div>
          <div class="grid grid-cols-4 gap-3 mb-4">
            <div v-for="i in 4" :key="i" class="dash-skeleton h-20 rounded-xl" :style="{ animationDelay: `${i * 120}ms` }" />
          </div>
          <div class="grid grid-cols-2 gap-3 mb-4">
            <div class="dash-skeleton h-44 rounded-xl" style="animation-delay: 300ms" />
            <div class="dash-skeleton h-44 rounded-xl" style="animation-delay: 420ms" />
          </div>
          <div class="dash-skeleton h-40 rounded-xl" style="animation-delay: 540ms" />
        </div>

        <div v-else-if="!program" class="h-full min-h-[320px] flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-gray-200 dark:border-zinc-800">
          <div class="text-[14px] font-medium text-gray-700 dark:text-zinc-200">{{ t('dashboards.emptyCanvas') }}</div>
          <p class="mt-1 text-[12px] text-gray-500 dark:text-zinc-400">{{ t('dashboards.emptyCanvasDesc') }}</p>
        </div>
      </div>

      <!-- The AI editor -->
      <Transition name="dash-editor">
        <aside v-if="editorOpen" class="dash-editor w-[380px] max-w-[45%] shrink-0 flex flex-col min-h-0 rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <header class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
            <span class="flex-1 min-w-0 truncate text-[13px] font-semibold text-gray-900 dark:text-zinc-100">{{ t('dashboards.edit') }}</span>
            <button
              type="button"
              class="shrink-0 h-7 px-2 rounded-lg inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800"
              :title="t('dashboards.tool')"
              :disabled="!installed"
              @click="showSettings = true"
            >
              {{ providerLabel(chatSettings.provider) }}<span class="text-gray-400 dark:text-zinc-500">· {{ modelLabel }}</span>
            </button>
            <button type="button" class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-800 dark:hover:text-zinc-100 hover:bg-gray-100 dark:hover:bg-zinc-800" :title="t('dashboards.editClose')" :aria-label="t('dashboards.editClose')" @click="editorOpen = false">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </header>

          <div ref="scroller" class="flex-1 min-h-0 overflow-y-auto">
            <!-- No AI tool on this computer -->
            <div v-if="installed && !Object.values(installed).some(Boolean)" class="px-5 py-8 text-center">
              <div class="text-[13px] font-medium text-gray-900 dark:text-zinc-100">{{ t('chat.noToolTitle') }}</div>
              <p class="mt-2 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('chat.noToolDesc') }}</p>
              <div class="mt-4 flex flex-wrap justify-center gap-1.5">
                <button v-for="p in CHAT_TOOLS" :key="p.id" type="button" :class="btnGhost" class="!h-7 !text-[11px] border border-gray-200 dark:border-zinc-700" @click="shell.openExternal(p.url)">{{ p.label }} ↗</button>
              </div>
            </div>
            <div v-else-if="!chat.messages.length" class="px-5 py-6">
              <p class="text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('dashboards.editIntro') }}</p>
              <div class="mt-4 space-y-2">
                <button
                  v-for="(s, i) in suggestions"
                  :key="s"
                  type="button"
                  class="dash-suggestion group w-full flex items-center gap-2 text-left rounded-xl border border-gray-200 dark:border-zinc-800 px-3 py-2.5 text-[12px] text-gray-700 dark:text-zinc-300 hover:border-emerald-300 dark:hover:border-emerald-800 disabled:opacity-50"
                  :style="{ animationDelay: `${i * 60}ms` }"
                  :disabled="!toolReady || !program"
                  @click="submit(s)"
                >
                  <span class="flex-1">{{ s }}</span>
                  <svg class="dash-arrow w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-zinc-600 group-hover:text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                </button>
              </div>
            </div>
            <ChatMessages v-else :chat="chat" :provider-label="providerLabel(chat.provider)" mode="dashboard" class="px-4 py-4" @choose="submit" />
          </div>

          <footer class="shrink-0 px-3 pt-2 pb-3">
            <!-- The block the request is about -->
            <div v-if="focus" class="mb-1.5 inline-flex items-center gap-1.5 max-w-full rounded-md bg-emerald-500/10 pl-2 pr-1 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
              <span class="truncate">{{ t('dashboards.focus', { name: focusLabel }) }}</span>
              <button type="button" class="w-4 h-4 rounded flex items-center justify-center hover:bg-emerald-500/20" :aria-label="t('dashboards.focusClear')" :title="t('dashboards.focusClear')" @click="focus = null">×</button>
            </div>
            <div class="flex items-end gap-2 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50/60 dark:bg-zinc-800/40 focus-within:border-emerald-500 focus-within:bg-white dark:focus-within:bg-zinc-900 transition-colors px-2.5 py-1.5">
              <textarea
                ref="input"
                v-model="draft"
                rows="1"
                class="flex-1 self-center resize-none bg-transparent outline-none py-1 text-[13px] leading-relaxed text-gray-900 dark:text-zinc-100 placeholder:text-gray-400 dark:placeholder:text-zinc-500"
                :placeholder="focus ? t('dashboards.placeholderBlock') : t('dashboards.placeholder')"
                :aria-label="t('dashboards.placeholder')"
                :disabled="!toolReady"
                @keydown.enter="onEnter"
              />
              <button
                v-if="busy"
                type="button"
                class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
                :title="t('chat.stop')"
                :aria-label="t('chat.stop')"
                @click="session && stop(session)"
              >
                <span class="w-2.5 h-2.5 rounded-sm bg-current" />
              </button>
              <button
                v-else
                type="button"
                class="group shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:bg-emerald-600 dark:hover:bg-emerald-400 disabled:opacity-30 transition-colors"
                :title="t('chat.send')"
                :aria-label="t('chat.send')"
                :disabled="!draft.trim() || !toolReady"
                @click="submit()"
              >
                <svg class="dash-arrow w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-6-6l6 6-6 6" /></svg>
              </button>
            </div>
          </footer>
        </aside>
      </Transition>
    </div>

    <!-- Rename a block -->
    <AppModal v-if="renaming" :title="t('dashboards.block.renameTitle')" icon="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" width="sm" @close="renaming = null" @submit="saveRename">
      <FormField :label="t('dashboards.block.renameLabel')">
        <input v-model="renaming.title" type="text" maxlength="120" :class="inputClass" />
      </FormField>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnSecondary" @click="renaming = null">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" @click="saveRename">{{ t('dashboards.save') }}</button>
      </template>
    </AppModal>

    <!-- The SQL of a block, tried before it is saved -->
    <AppModal v-if="sqlBlock" :title="t('dashboards.sqlTitle')" icon="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" width="lg" @close="sqlBlock = null" @submit="saveSql">
      <p class="mb-3 text-[12px] text-gray-500 dark:text-zinc-400">{{ engine === 'mongodb' ? t('dashboards.mongoHint') : t('dashboards.sqlHint') }}</p>
      <div class="space-y-4">
        <div v-for="d in sqlDrafts" :key="d.name">
          <div class="mb-1 font-mono text-[11px] text-gray-500 dark:text-zinc-400">{{ d.name }}</div>
          <textarea v-model="d.sql" rows="6" spellcheck="false" :class="inputClass" class="!h-auto py-2 font-mono text-[12px] leading-relaxed resize-y" data-own-enter />
          <div class="mt-1.5 flex items-center gap-2">
            <button type="button" :class="btnSecondary" class="!h-7 !text-[12px]" :disabled="d.test.busy || !d.sql.trim()" @click="testSql(d)">{{ d.test.busy ? t('dashboards.sqlTesting') : t('dashboards.sqlTest') }}</button>
            <span v-if="d.test.text" class="text-[11px]" :class="d.test.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'">{{ d.test.text }}</span>
          </div>
          <div v-if="d.test.ok && d.test.columns?.length" class="mt-2 max-h-40 overflow-auto rounded-lg border border-gray-200 dark:border-zinc-800">
            <table class="w-full text-[11px]">
              <thead class="bg-gray-50 dark:bg-zinc-800"><tr><th v-for="c in d.test.columns" :key="c" class="px-2 py-1 text-left font-medium text-gray-500 dark:text-zinc-400 whitespace-nowrap">{{ c }}</th></tr></thead>
              <tbody><tr v-for="(r, i) in d.test.rows" :key="i" class="border-t border-gray-100 dark:border-zinc-800"><td v-for="c in d.test.columns" :key="c" class="px-2 py-1 whitespace-nowrap">{{ formatValue(r[c], undefined, currentLanguage) }}</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnSecondary" @click="sqlBlock = null">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" @click="saveSql">{{ t('dashboards.save') }}</button>
      </template>
    </AppModal>

    <!-- Appearance -->
    <AppModal v-if="showAppearance" :title="t('dashboards.appearance.title')" icon="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072" width="sm" @close="showAppearance = false" @submit="showAppearance = false">
      <div class="space-y-5">
        <FormField :label="t('dashboards.appearance.accent')">
          <div class="flex gap-2">
            <button
              v-for="(palette, name) in PALETTES"
              :key="name"
              type="button"
              class="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110"
              :class="theme.accent === name ? 'border-gray-900 dark:border-zinc-100' : 'border-transparent'"
              :style="{ background: palette[0] }"
              :title="t(`dashboards.appearance.${name}`)"
              :aria-label="t(`dashboards.appearance.${name}`)"
              :aria-pressed="theme.accent === name"
              @click="setTheme({ accent: name })"
            />
          </div>
        </FormField>
        <FormField :label="t('dashboards.appearance.density')">
          <select :value="theme.density" :class="selectClass" @change="setTheme({ density: ($event.target as HTMLSelectElement).value as DashboardTheme['density'] })">
            <option value="comfortable">{{ t('dashboards.appearance.comfortable') }}</option>
            <option value="compact">{{ t('dashboards.appearance.compact') }}</option>
          </select>
        </FormField>
      </div>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnPrimary" @click="showAppearance = false">{{ t('dashboards.done') }}</button>
      </template>
    </AppModal>

    <!-- Copy to another database -->
    <AppModal v-if="copying" :title="t('dashboards.copyTitle')" icon="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75" width="sm" @close="copying = null" @submit="confirmCopy">
      <p class="mb-3 text-[12px] leading-relaxed text-gray-500 dark:text-zinc-400">{{ t('dashboards.copyHint') }}</p>
      <FormField :label="t('dashboards.modal.database')">
        <select v-model="copying.databaseId" :class="selectClass">
          <option v-for="d in otherDatabases" :key="d.id" :value="d.id">{{ labelOf(d.id) }}</option>
        </select>
      </FormField>
      <template #footer>
        <span class="flex-1" />
        <button type="button" :class="btnSecondary" @click="copying = null">{{ t('common.cancel') }}</button>
        <button type="button" :class="btnPrimary" :disabled="!copying.databaseId" @click="confirmCopy">{{ t('dashboards.copyConfirm') }}</button>
      </template>
    </AppModal>

    <AppModal v-if="showCode" :title="t('dashboards.codeTitle')" icon="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" width="lg" @close="showCode = false" @submit="showCode = false">
      <p class="mb-3 text-[12px] text-gray-500 dark:text-zinc-400">{{ t('dashboards.codeHint') }}</p>
      <pre class="max-h-[60vh] overflow-auto rounded-lg bg-gray-50 dark:bg-zinc-950 border border-gray-200 dark:border-zinc-800 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-gray-700 dark:text-zinc-300 whitespace-pre-wrap break-words select-text">{{ program }}</pre>
    </AppModal>
    <AiChatSettingsModal v-if="showSettings && installed" :providers="CHAT_TOOLS" :installed="installed" @close="showSettings = false" @saved="showSettings = false" />
  </div>
</template>

<style scoped>
.dash-back { transition: transform 0.2s ease-out; }
button:hover > .dash-back { transform: translateX(-2px); }
.dash-sparkle { transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
.dash-ai-button:hover .dash-sparkle { transform: rotate(15deg) scale(1.12); }
.dash-arrow { transition: transform 0.2s ease-out; }
.group:hover .dash-arrow { transform: translateX(2px); }
.dash-suggestion { animation: dash-rise 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) both; transition: border-color 0.2s, transform 0.2s ease-out; }
.dash-suggestion:hover:not(:disabled) { transform: translateX(2px); }
@keyframes dash-rise { from { opacity: 0; transform: translateY(6px); } }

/* Blocks taking shape while the AI builds the dashboard */
.dash-skeleton {
  background: linear-gradient(90deg, rgb(16 185 129 / 0.06) 0%, rgb(16 185 129 / 0.16) 50%, rgb(16 185 129 / 0.06) 100%);
  background-size: 200% 100%;
  animation: dash-shimmer 1.6s ease-in-out infinite, dash-rise 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes dash-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* The editor slides in from the right */
.dash-editor-enter-active { transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); }
.dash-editor-leave-active { transition: opacity 0.15s ease, transform 0.18s ease-in; }
.dash-editor-enter-from, .dash-editor-leave-to { opacity: 0; transform: translateX(24px); }

@media (prefers-reduced-motion: reduce) {
  .dash-suggestion, .dash-skeleton { animation: none; }
  .dash-editor-enter-active, .dash-editor-leave-active { transition: none; }
}
</style>

<!-- Not scoped: OpenUI renders the blocks outside this component's scope, and the PDF copy sits on the body -->
<style>
.dash-canvas { container-type: inline-size; }
@container (max-width: 640px) {
  .dash-canvas .dash-block { grid-column: 1 / -1 !important; }
}
.dash-view .dash-loader-bar { animation: dash-loading 1.1s ease-in-out infinite; }
@keyframes dash-loading { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.dash-canvas .chat-bar { transform-origin: left center; animation: dash-bar-grow 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@keyframes dash-bar-grow { from { transform: scaleX(0); } }
.dash-canvas .dash-column { transform-origin: bottom; animation: dash-column-grow 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@keyframes dash-column-grow { from { transform: scaleY(0); } }
.dash-canvas .chat-line { clip-path: inset(0 100% 0 0); animation: dash-line-draw 0.9s ease-out 0.1s forwards; }
@keyframes dash-line-draw { to { clip-path: inset(0 0 0 0); } }
.dash-canvas .dash-stat { animation: dash-stat-rise 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.dash-canvas .dash-progress { transition: width 0.6s cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes dash-stat-rise { from { opacity: 0; transform: translateY(6px); } }
.dash-canvas .dash-block { transition: opacity 0.2s; }
.dash-print-root .dash-resize, .dash-print-root .dash-drop { display: none !important; }
/* On paper, a table shows all the rows of its page, without its search field */
.dash-print-root .dash-table-scroll { max-height: none !important; overflow: visible !important; }
.dash-print-root input[type="search"] { display: none !important; }
/* A block given a height: its card fills it */
.dash-canvas .dash-sized > .dash-card-box, .dash-canvas .dash-sized > .dash-stat, .dash-canvas .dash-sized > div:first-child { height: 100%; overflow: hidden; }
.dash-canvas .dash-previewing { outline: 2px dashed var(--dash-c1); outline-offset: 3px; border-radius: 12px; }
body.dash-resizing, body.dash-resizing * { cursor: nwse-resize !important; user-select: none !important; }
/* The row picked in a table (it filters the dashboard) */
.dash-canvas tr.dash-picked { background: color-mix(in srgb, var(--dash-c1) 12%, transparent); box-shadow: inset 3px 0 0 var(--dash-c1); }
@media (prefers-reduced-motion: reduce) {
  .dash-view .dash-loader-bar, .dash-canvas .chat-bar, .dash-canvas .dash-column, .dash-canvas .dash-stat { animation: none; }
  .dash-canvas .chat-line { animation: none; clip-path: none; }
}

/* PDF: only the copy of the dashboard is printed */
.dash-print-root { display: none; }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(.dash-print-root) { display: none !important; }
  .dash-print-root { display: block; padding: 8px; color: #111; }
  .dash-print-title { margin-bottom: 12px; font: 600 13px/1.4 system-ui, sans-serif; }
  .dash-print-root .dash-tools, .dash-print-root .dash-loader { display: none !important; }
  .dash-print-root .dash-block { break-inside: avoid; }
  .dash-print-root * { animation: none !important; }
  .dash-print-root .chat-line { clip-path: none !important; }
}
</style>

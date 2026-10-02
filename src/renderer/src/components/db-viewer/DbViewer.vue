<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { getErrorMessage } from '../../utils';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { useConfirm } from '../../composables/useConfirm';
import { ipcRenderer } from '../../electron';
import { buildDbConfig, type ViewerTable } from '../../types';
import TableSidebar from './TableSidebar.vue';
import TableData from './TableData.vue';
import TableRelations from './TableRelations.vue';
import TableSchema from './TableSchema.vue';
import TableSchemaVisualizer from './TableSchemaVisualizer.vue';
import PerformanceTab from './PerformanceTab.vue';
import SqlQueryBuilder from './SqlQueryBuilder.vue';
import { DEFAULT_SCHEMA, displayTableName } from './schemaNames';
import {
  closeTab as closeTabIn, loadTabSession, openTab, pinTab, saveTabSession, tabKey,
  type ViewerSubTab, type ViewerTab, type ViewerTabState,
} from './viewerTabs';

const emit = defineEmits(['close']);
const { t } = useI18n();
const { showConfirm, state: confirmState } = useConfirm();

const tables = ref<ViewerTable[]>([]);
const schemas = ref<{ name: string; table_count: number }[]>([]);
const selectedSchema = ref<string>(DEFAULT_SCHEMA);
const viewMode = ref('visualizer'); // explorer, visualizer, performance, query
const loading = ref(false);
const error = ref<string | null>(null);

// --- Table tabs ---------------------------------------------------------------
// Each tab keeps its grid alive (KeepAlive), so its search, page, sort and pending
// edits survive switching tables; the session is remembered per database.
const tabs = ref<ViewerTab[]>([]);
const activeKey = ref<string | null>(null);
const dirtyKeys = ref(new Set<string>());

const activeTab = computed(() => tabs.value.find(tab => tab.key === activeKey.value) ?? null);
/** Highlighted in the sidebar when the active tab belongs to the listed schema */
const selectedTable = computed(() =>
  viewMode.value === 'explorer' && activeTab.value?.schema === selectedSchema.value ? activeTab.value.table : null);
const showTabLabelSchema = computed(() => new Set(tabs.value.map(tab => tab.schema)).size > 1);

const persistTabs = () => {
  if (store.viewerDb?.id) saveTabSession(store.viewerDb.id, { tabs: tabs.value, active: activeKey.value });
};

const restoreTabs = () => {
  const session = store.viewerDb?.id ? loadTabSession(store.viewerDb.id) : { tabs: [], active: null };
  tabs.value = session.tabs;
  activeKey.value = session.active;
  dirtyKeys.value = new Set();
  if (session.active) viewMode.value = 'explorer';
};

watch([tabs, activeKey], persistTabs, { deep: true });

const switchSidebarSchema = (schemaName: string) => {
  if (schemaName === selectedSchema.value) return;
  selectedSchema.value = schemaName;
  loadTables();
};

const activateTab = (key: string) => {
  const tab = tabs.value.find(item => item.key === key);
  if (!tab) return;
  activeKey.value = key;
  viewMode.value = 'explorer';
  switchSidebarSchema(tab.schema);
};

/** preview: single click / navigation (reuses the preview tab); otherwise the tab stays. */
const openTable = (schemaName: string, tableName: string, view?: ViewerSubTab, preview = true) => {
  const result = openTab(tabs.value, schemaName, tableName, activeKey.value, { preview });
  for (const key of [...dirtyKeys.value]) {
    if (!result.tabs.some(tab => tab.key === key)) dirtyKeys.value.delete(key);
  }
  tabs.value = result.tabs;
  activeKey.value = result.key;
  if (view) {
    const tab = tabs.value.find(item => item.key === result.key);
    if (tab) tab.view = view;
  }
  viewMode.value = 'explorer';
};

const closeTab = (key: string) => {
  if (confirmState.show) return;
  const close = () => {
    const next = closeTabIn(tabs.value, key, activeKey.value);
    tabs.value = next.tabs;
    activeKey.value = next.active;
    const dirty = new Set(dirtyKeys.value);
    dirty.delete(key);
    dirtyKeys.value = dirty;
    if (next.active) activateTab(next.active);
  };
  if (dirtyKeys.value.has(key)) {
    showConfirm({
      title: t('viewer.unsavedChanges'),
      message: t('viewer.unsavedTabClose'),
      confirmText: t('viewer.closeTab'),
      type: 'warning',
      onConfirm: close,
    });
  } else {
    close();
  }
};

const pin = (key: string) => {
  tabs.value = pinTab(tabs.value, key);
};

/** Searching, sorting or paging a preview tab means the user works there: it stays. */
const onTabState = (state: ViewerTabState, origin: { schema: string; table: string }) => {
  const key = tabKey(origin.schema, origin.table);
  pin(key);
  const tab = tabs.value.find(item => item.key === key);
  if (tab) tab.state = state;
};

const onTabDirty = (dirty: boolean, origin: { schema: string; table: string }) => {
  const key = tabKey(origin.schema, origin.table);
  if (dirty) pin(key);
  const next = new Set(dirtyKeys.value);
  if (dirty) next.add(key); else next.delete(key);
  dirtyKeys.value = next;
};

// The strip scrolls with the mouse wheel and always shows the active tab
const tabStrip = ref<HTMLElement | null>(null);
const onTabStripWheel = (event: WheelEvent) => {
  const strip = tabStrip.value;
  if (!strip || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  if (strip.scrollWidth <= strip.clientWidth) return;
  event.preventDefault();
  strip.scrollLeft += event.deltaY;
};
watch([activeKey, () => tabs.value.length], () => {
  nextTick(() => {
    const active = [...(tabStrip.value?.querySelectorAll<HTMLElement>('[data-tab-key]') ?? [])]
      .find(element => element.dataset.tabKey === activeKey.value);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
});

const tabLabel = (tab: ViewerTab) =>
  showTabLabelSchema.value ? `${tab.schema}.${tab.table}` : displayTableName(tab.schema, tab.table, tab.schema);

// --- Data -----------------------------------------------------------------------

const pickDefaultSchema = (list: { name: string }[]): string => {
  if (list.some(s => s.name === DEFAULT_SCHEMA)) return DEFAULT_SCHEMA;
  return list[0]?.name ?? DEFAULT_SCHEMA;
};

const loadSchemas = async () => {
  if (!store.viewerDb) return;
  try {
    const result = await ipcRenderer.invoke('get-db-schemas', { db: buildDbConfig(store.viewerDb) });
    schemas.value = result.schemas || [];
  } catch (err) {
    // Listing schemas is best effort: fall back to the default schema
    console.error('Error loading schemas:', err);
    schemas.value = [];
  }
  if (!schemas.value.some(s => s.name === selectedSchema.value)) {
    selectedSchema.value = pickDefaultSchema(schemas.value);
  }
};

const loadTables = async () => {
  if (!store.viewerDb) return;

  loading.value = true;
  error.value = null;
  try {
    const result = await ipcRenderer.invoke('get-db-tables', {
      db: buildDbConfig(store.viewerDb),
      schema: selectedSchema.value
    });
    tables.value = result.tables;
  } catch (err) {
    console.error('Error loading tables:', err);
    error.value = getErrorMessage(err) || t('viewer.connectError');
  } finally {
    loading.value = false;
  }
};

const handleTableSelect = (tableName: string) => {
  openTable(selectedSchema.value, tableName);
};

const handleTableOpen = (tableName: string) => {
  openTable(selectedSchema.value, tableName, undefined, false);
};

const handleNavigateToTable = (target: string | { schema?: string; table: string }) => {
  const tableName = typeof target === 'string' ? target : target.table;
  const schemaName = (typeof target === 'string' ? undefined : target.schema) || selectedSchema.value;
  switchSidebarSchema(schemaName);
  openTable(schemaName, tableName, 'data');
};

/** The sidebar lists another schema; open tabs stay as they are. */
const handleSchemaChange = (schemaName: string) => {
  switchSidebarSchema(schemaName);
};

// Keep the sidebar count in sync with the exact total shown by the data grid
const handleRowCount = (payload: { schema: string; table: string; count: number }) => {
  if (payload.schema !== selectedSchema.value) return;
  const entry = tables.value.find(t => t.name === payload.table);
  if (entry) {
    entry.row_count = payload.count;
    entry.row_count_estimated = false;
  }
};

const loadAll = async () => {
  await loadSchemas();
  // Reopen on the schema of the restored tab
  const restored = activeTab.value;
  if (restored && schemas.value.some(s => s.name === restored.schema)) {
    selectedSchema.value = restored.schema;
  }
  await loadTables();
};

const handleVisualizeClick = () => { viewMode.value = 'visualizer'; };
const handlePerformanceClick = () => { viewMode.value = 'performance'; };
const handleQueryClick = () => { viewMode.value = 'query'; };

const handleSubTabSwitch = (view: ViewerSubTab) => {
  if (activeTab.value) activeTab.value.view = view;
};

const handleClose = () => {
  if (confirmState.show) return;
  if (dirtyKeys.value.size > 0) {
    showConfirm({
      title: t('viewer.unsavedChanges'),
      message: t('viewer.unsavedChangesConfirm'),
      confirmText: t('viewer.discard'),
      type: 'warning',
      onConfirm: () => emit('close'),
    });
  } else {
    emit('close');
  }
};

onMounted(() => {
  restoreTabs();
  loadAll();
});

watch(() => store.viewerDb, (newDb, oldDb) => {
  if (newDb && newDb !== oldDb) {
    viewMode.value = 'visualizer';
    error.value = null;
    schemas.value = [];
    selectedSchema.value = DEFAULT_SCHEMA;
    restoreTabs();
    loadAll();
  }
});
</script>

<template>
  <div class="fixed inset-0 z-200 flex animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 w-full h-full flex flex-col overflow-hidden">
      <!-- Header (drag region with traffic light clearance) -->
      <div class="px-4 pt-7 pb-1.5 border-b border-gray-200 dark:border-zinc-800 flex items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl drag-region">
        <!-- Left spacer (matches close button size for centering) -->
        <div class="w-8 shrink-0"></div>
        <!-- Centered db info -->
        <div class="flex-1 flex flex-col items-center justify-center no-drag min-w-0">
          <div class="flex items-center gap-2">
            <div class="w-5 h-5 rounded bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            </div>
            <h3 class="text-xs font-bold text-gray-900 dark:text-white leading-tight">
              {{ store.viewerDb?.displayName || store.viewerDb?.name }}
            </h3>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
            <span class="font-mono">{{ store.viewerDb?.host }}:{{ store.viewerDb?.port }}</span>
            <span>•</span>
            <span>{{ t('viewer.tablesCount', { count: tables.length }) }}</span>
          </div>
        </div>
        <!-- Close button -->
        <button
          @click="handleClose"
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200 no-drag shrink-0"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Sidebar -->
        <TableSidebar
          :tables="tables"
          :schemas="schemas"
          :selected-schema="selectedSchema"
          :selected-table="selectedTable"
          :loading="loading"
          :view-mode="viewMode"
          :is-local-bbdump="store.viewerDb?.isLocalBbdump"
          @select="handleTableSelect"
          @open="handleTableOpen"
          @select-schema="handleSchemaChange"
          @visualize="handleVisualizeClick"
          @performance="handlePerformanceClick"
          @query="handleQueryClick"
        />

        <!-- Main Content -->
        <div class="flex-1 flex flex-col overflow-hidden bg-white dark:bg-surface/50 backdrop-blur-md relative">
          <!-- Table tabs -->
          <div
            v-if="tabs.length"
            ref="tabStrip"
            class="tab-strip shrink-0 flex items-end gap-0.5 px-2 pt-1.5 overflow-x-auto overflow-y-hidden border-b border-gray-200 dark:border-white/10 bg-gray-50/80 dark:bg-zinc-900/60"
            role="tablist"
            @wheel="onTabStripWheel"
          >
            <div
              v-for="tab in tabs"
              :key="tab.key"
              role="tab"
              :data-tab-key="tab.key"
              :aria-selected="viewMode === 'explorer' && tab.key === activeKey"
              :title="tab.preview ? `${tab.schema}.${tab.table} · ${t('viewer.previewTabHint')}` : `${tab.schema}.${tab.table}`"
              class="group shrink-0 max-w-[200px] flex items-center gap-1.5 pl-3 pr-1.5 h-7 rounded-t-md border border-b-0 text-xs cursor-pointer select-none transition-colors"
              :class="viewMode === 'explorer' && tab.key === activeKey
                ? 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-white/10 text-gray-900 dark:text-white -mb-px'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'"
              @click="activateTab(tab.key)"
              @dblclick="pin(tab.key)"
              @mousedown.middle.prevent="closeTab(tab.key)"
            >
              <span v-if="dirtyKeys.has(tab.key)" class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" :class="{ italic: tab.preview }">{{ tabLabel(tab) }}</span>
              <span v-if="tab.state?.search" class="shrink-0 text-blue-500" aria-hidden="true">
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                </svg>
              </span>
              <button
                type="button"
                class="shrink-0 w-4 h-4 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10 transition-opacity"
                :class="tab.key === activeKey ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'"
                :aria-label="t('viewer.closeTab')"
                :title="t('viewer.closeTab')"
                @click.stop="closeTab(tab.key)"
              >
                <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Visualizer View -->
          <TableSchemaVisualizer
            v-if="viewMode === 'visualizer'"
            :db="store.viewerDb"
            :schema="selectedSchema"
            @select-table="handleNavigateToTable"
          />

          <!-- Performance View -->
          <PerformanceTab
            v-else-if="viewMode === 'performance'"
            :db="store.viewerDb"
          />

          <!-- Query Builder View -->
          <SqlQueryBuilder
            v-else-if="viewMode === 'query'"
            :db="store.viewerDb"
            :schema="selectedSchema"
          />

          <!-- Explorer View -->
          <template v-else>
            <!-- Loading State (first load of the table list) -->
            <div v-if="loading && !activeTab" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-white/80 dark:bg-surface/80 backdrop-blur-sm">
              <div class="mb-6">
                <div class="relative w-16 h-16 mx-auto">
                  <div class="absolute inset-0 border-4 border-blue-500/30 rounded-full"></div>
                  <div class="absolute inset-0 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              </div>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-foreground mb-2">{{ t('viewer.loadingDb') }}</h3>
              <p class="text-sm text-gray-500">{{ t('viewer.fetchingInfo') }}</p>
            </div>

            <!-- Error State -->
            <div v-else-if="error" class="absolute inset-0 z-10 flex flex-col items-center justify-center p-8 text-center bg-white/80 dark:bg-surface/80 backdrop-blur-sm">
              <div class="mb-6 p-6 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-2xl max-w-md">
                <div class="w-12 h-12 bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h3 class="text-lg font-bold text-red-700 dark:text-red-500 mb-2">{{ t('viewer.connectionFailed') }}</h3>
                <p class="text-sm text-red-600 dark:text-red-400 mb-4">{{ error }}</p>
                <button
                  @click="loadAll"
                  class="px-4 py-2 bg-red-600 dark:bg-red-500 hover:bg-red-700 dark:hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-red-500/20"
                >
                  {{ t('viewer.retry') }}
                </button>
              </div>
            </div>

            <!-- Success State -->
            <div v-else-if="activeTab" class="flex flex-col flex-1 min-h-0">
              <!-- Sub-views of the table -->
              <div class="border-b border-gray-200 dark:border-white/10 px-4 bg-white dark:bg-surface/30 backdrop-blur-sm">
                <nav class="-mb-px flex space-x-4">
                  <button
                    v-for="view in (['data', 'relations', 'schema'] as const)"
                    :key="view"
                    @click="handleSubTabSwitch(view)"
                    :class="[
                      activeTab.view === view
                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600',
                      'whitespace-nowrap py-2 px-1 border-b-2 font-medium text-xs transition-colors duration-200 capitalize'
                    ]"
                  >
                    {{ t(`viewer.${view}`) }}
                  </button>
                </nav>
              </div>

              <!-- Content -->
              <div class="flex-1 overflow-hidden p-2">
                <div class="h-full overflow-hidden flex flex-col">
                  <!-- One grid per tab, kept alive: search, page, sort and edits survive switching -->
                  <KeepAlive :max="10">
                    <TableData
                      v-if="activeTab.view === 'data'"
                      :key="activeTab.key"
                      :db="store.viewerDb"
                      :schema="activeTab.schema"
                      :table="activeTab.table"
                      :initial-state="activeTab.state"
                      class="flex-1 overflow-hidden"
                      @navigate-to-table="handleNavigateToTable"
                      @row-count="handleRowCount"
                      @state-change="onTabState"
                      @dirty="onTabDirty"
                    />
                  </KeepAlive>
                  <TableRelations
                    v-if="activeTab.view === 'relations'"
                    :key="`relations-${activeTab.key}`"
                    :db="store.viewerDb"
                    :schema="activeTab.schema"
                    :table="activeTab.table"
                  />
                  <TableSchema
                    v-if="activeTab.view === 'schema'"
                    :key="`schema-${activeTab.key}`"
                    :db="store.viewerDb"
                    :schema="activeTab.schema"
                    :table="activeTab.table"
                  />
                </div>
              </div>
            </div>

            <!-- Empty State -->
            <div v-else-if="!loading" class="flex-1 flex flex-col items-center justify-center p-8 text-center bg-gray-50/30 dark:bg-transparent">
              <div class="w-20 h-20 bg-gray-100 dark:bg-surface rounded-full flex items-center justify-center mb-6 text-gray-400 shadow-inner border border-gray-200 dark:border-white/10">
                <svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M3 14h18m-9-4v8m-7-6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z" />
                </svg>
              </div>
              <h3 class="text-xl font-bold text-gray-900 dark:text-white mb-2">{{ t('viewer.readyTitle') }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs mx-auto mb-6">{{ t('viewer.selectPrompt') }}</p>
              <button
                @click="handleVisualizeClick"
                class="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-all shadow-lg shadow-blue-500/25 flex items-center gap-2"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
                {{ t('viewer.openSchemaVisualizer') }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-strip::-webkit-scrollbar {
  height: 3px;
}
.tab-strip::-webkit-scrollbar-track {
  background: transparent;
}
.tab-strip::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: rgb(156 163 175 / 0.35);
}
</style>

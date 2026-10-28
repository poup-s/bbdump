<script setup lang="ts">
/**
 * Explorer of a MongoDB database: collections, their documents (JSON filter, sort, pages, table
 * or JSON; add, edit and delete one at a time), read-only aggregations, and the fields deduced
 * from a random sample with the indexes. Same frame as the PostgreSQL explorer.
 */
import { ref, computed, onMounted, watch } from 'vue';
import { getErrorMessage } from '../../utils';
import { store } from '../../store';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { useFeatures } from '../../composables/useFeatures';
import { ipcRenderer } from '../../electron';
import {
  documentColumns, formatDocumentValue,
  type AggregateResult, type CollectionDescription, type CollectionInfo, type DocumentPage,
} from '../../../../shared/engines/documents';

const emit = defineEmits(['close']);
const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();
const features = useFeatures();

const PAGE_SIZES = [20, 50, 100, 200];
const dbRef = () => ({ id: store.viewerDb!.id });
const cleanError = (error: unknown) => getErrorMessage(error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const formatCount = (count: number) => count.toLocaleString();
/** A plain copy for IPC (a reactive proxy cannot be sent), field order kept */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sameId = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a._id) === JSON.stringify(b._id);

// --- Collections ---------------------------------------------------------------------------

const collections = ref<CollectionInfo[]>([]);
const loadingCollections = ref(false);
const connectionError = ref<string | null>(null);
const collectionSearch = ref('');
const selected = ref<string | null>(null);
const shownCollections = computed(() => {
  const search = collectionSearch.value.trim().toLowerCase();
  return search ? collections.value.filter(c => c.name.toLowerCase().includes(search)) : collections.value;
});

const loadCollections = async () => {
  if (!store.viewerDb) return;
  loadingCollections.value = true;
  connectionError.value = null;
  try {
    collections.value = await ipcRenderer.invoke('documents-collections', { db: dbRef() });
  } catch (error) {
    connectionError.value = cleanError(error);
  } finally {
    loadingCollections.value = false;
  }
};

// --- Documents --------------------------------------------------------------------------------

const selectedInfo = computed(() => collections.value.find(c => c.name === selected.value));
const isView = computed(() => selectedInfo.value?.type === 'view');
const canEdit = computed(() => !!store.viewerDb && features.isEnabled(store.viewerDb, 'explorer.editDocuments') && !isView.value);
const canAggregate = computed(() => !!store.viewerDb && features.isEnabled(store.viewerDb, 'explorer.aggregate'));
const tabs = computed(() => (canAggregate.value ? ['documents', 'aggregate', 'schema'] as const : ['documents', 'schema'] as const));
const tabLabel = (item: string) => (item === 'documents' ? t('mongoViewer.documentsTab') : item === 'aggregate' ? t('mongoViewer.aggregateTab') : t('mongoViewer.schemaTab'));

const tab = ref<'documents' | 'aggregate' | 'schema'>('documents');
const layout = ref<'table' | 'json'>('table');
const filterText = ref('');
const appliedFilter = ref('');
const sortField = ref('');
const sortDirection = ref<1 | -1>(1);
const pageSize = ref(50);
const skip = ref(0);
const page = ref<DocumentPage | null>(null);
const loadingDocuments = ref(false);
const documentsError = ref<string | null>(null);
const opened = ref<Record<string, unknown> | null>(null);
const copied = ref(false);

const columns = computed(() => documentColumns(page.value?.documents ?? []));
/** Sort choices: the fields seen on this page and in the sampled schema */
const sortableFields = computed(() => {
  const fields = new Set(columns.value);
  for (const field of description.value?.fields ?? []) if (!field.path.includes('[]')) fields.add(field.path);
  return [...fields];
});

const loadDocuments = async () => {
  if (!selected.value) return;
  loadingDocuments.value = true;
  documentsError.value = null;
  try {
    page.value = await ipcRenderer.invoke('documents-find', {
      db: dbRef(),
      query: {
        collection: selected.value,
        filter: appliedFilter.value,
        sort: sortField.value ? { field: sortField.value, direction: sortDirection.value } : undefined,
        skip: skip.value,
        limit: pageSize.value,
      },
    });
  } catch (error) {
    documentsError.value = cleanError(error);
  } finally {
    loadingDocuments.value = false;
  }
};

const applyFilter = () => {
  appliedFilter.value = filterText.value.trim();
  skip.value = 0;
  loadDocuments();
};
const clearFilter = () => {
  filterText.value = '';
  if (appliedFilter.value) applyFilter();
};
const changeSort = () => {
  skip.value = 0;
  loadDocuments();
};
const toggleDirection = () => {
  sortDirection.value = sortDirection.value === 1 ? -1 : 1;
  if (sortField.value) changeSort();
};
const goTo = (nextSkip: number) => {
  skip.value = Math.max(0, nextSkip);
  loadDocuments();
};
watch(pageSize, () => goTo(0));

const rangeLabel = computed(() => {
  const current = page.value;
  if (!current || !current.documents.length) return '';
  const from = current.skip + 1;
  const to = current.skip + current.documents.length;
  if (current.total === null) return t('mongoViewer.rangeUnknown', { from: formatCount(from), to: formatCount(to) });
  const total = current.totalIsEstimate ? t('mongoViewer.estimated', { count: formatCount(current.total) }) : formatCount(current.total);
  return t('mongoViewer.range', { from: formatCount(from), to: formatCount(to), total });
});

const prettyJson = (document: unknown) => JSON.stringify(document, null, 2);
const copyOpened = async () => {
  if (!opened.value) return;
  try {
    await navigator.clipboard.writeText(prettyJson(opened.value));
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { /* clipboard refused: nothing to say */ }
};

// --- Editing one document -------------------------------------------------------------------

/** 'edit': the opened document; 'new': a document to add */
const editing = ref<'edit' | 'new' | null>(null);
const draft = ref('');
const saving = ref(false);
const editError = ref<string | null>(null);

const startEdit = () => {
  if (!opened.value) return;
  draft.value = prettyJson(opened.value);
  editError.value = null;
  editing.value = 'edit';
};
const startNew = () => {
  opened.value = null;
  draft.value = '{\n  \n}';
  editError.value = null;
  editing.value = 'new';
};
const cancelEdit = () => {
  editing.value = null;
  editError.value = null;
};
// Another document opened: what was being edited is left
watch(opened, document => {
  if (document) cancelEdit();
});

const saveDraft = async () => {
  if (!selected.value || saving.value || !editing.value) return;
  saving.value = true;
  editError.value = null;
  try {
    if (editing.value === 'new') {
      await ipcRenderer.invoke('documents-insert', { db: dbRef(), collection: selected.value, document: draft.value });
      addToast(t('mongoViewer.documentAdded'), 'success');
      editing.value = null;
      await loadDocuments();
    } else if (opened.value) {
      const { document } = await ipcRenderer.invoke('documents-replace', {
        db: dbRef(),
        edit: { collection: selected.value, original: plain(opened.value), next: draft.value },
      });
      addToast(t('mongoViewer.documentSaved'), 'success');
      editing.value = null;
      await loadDocuments();
      opened.value = page.value?.documents.find(d => sameId(d, document)) ?? document;
    }
  } catch (error) {
    editError.value = cleanError(error);
  } finally {
    saving.value = false;
  }
};

const deleteOpened = () => {
  if (!opened.value || !selected.value) return;
  const original = plain(opened.value);
  const collection = selected.value;
  showConfirm({
    title: t('mongoViewer.deleteTitle'),
    message: t('mongoViewer.deleteMessage', { collection }),
    confirmText: t('mongoViewer.delete'),
    type: 'danger',
    onConfirm: async () => {
      try {
        await ipcRenderer.invoke('documents-delete', { db: dbRef(), edit: { collection, original } });
        addToast(t('mongoViewer.documentDeleted'), 'success');
        opened.value = null;
        await loadDocuments();
      } catch (error) {
        addToast(t('mongoViewer.deleteError'), 'error', { detail: cleanError(error) });
      }
    },
  });
};

// --- Aggregation ------------------------------------------------------------------------------

const DEFAULT_PIPELINE = '[\n  { "$match": {} },\n  { "$limit": 20 }\n]';
const pipelineText = ref(DEFAULT_PIPELINE);
const aggregateResult = ref<AggregateResult | null>(null);
const aggregating = ref(false);
const aggregateError = ref<string | null>(null);
const aggregateColumns = computed(() => documentColumns(aggregateResult.value?.documents ?? []));

const runAggregate = async () => {
  if (!selected.value || aggregating.value) return;
  aggregating.value = true;
  aggregateError.value = null;
  try {
    aggregateResult.value = await ipcRenderer.invoke('documents-aggregate', {
      db: dbRef(),
      query: { collection: selected.value, pipeline: pipelineText.value },
    });
  } catch (error) {
    aggregateError.value = cleanError(error);
  } finally {
    aggregating.value = false;
  }
};

// --- Schema and indexes ------------------------------------------------------------------------

const description = ref<CollectionDescription | null>(null);
const loadingDescription = ref(false);
const descriptionError = ref<string | null>(null);

const loadDescription = async () => {
  if (!selected.value) return;
  loadingDescription.value = true;
  descriptionError.value = null;
  try {
    description.value = await ipcRenderer.invoke('documents-describe', { db: dbRef(), collection: selected.value });
  } catch (error) {
    descriptionError.value = cleanError(error);
  } finally {
    loadingDescription.value = false;
  }
};

const depthOf = (path: string) => path.split('.').length - 1;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const sampleInfo = computed(() => {
  const current = description.value;
  if (!current) return '';
  if (current.total !== null && current.sampled >= current.total) return t('mongoViewer.sampleInfoAll', { sampled: formatCount(current.sampled) });
  return t('mongoViewer.sampleInfo', { sampled: formatCount(current.sampled), total: current.total === null ? '?' : t('mongoViewer.estimated', { count: formatCount(current.total) }) });
});

// --- Selection ---------------------------------------------------------------------------------

const selectCollection = (name: string) => {
  if (selected.value === name) return;
  selected.value = name;
  opened.value = null;
  cancelEdit();
  pipelineText.value = DEFAULT_PIPELINE;
  aggregateResult.value = null;
  aggregateError.value = null;
  if (tab.value === 'aggregate' && !canAggregate.value) tab.value = 'documents';
  page.value = null;
  description.value = null;
  filterText.value = '';
  appliedFilter.value = '';
  sortField.value = '';
  sortDirection.value = 1;
  skip.value = 0;
  loadDocuments();
  // The sampled schema also feeds the sort choices
  loadDescription();
};

onMounted(loadCollections);
watch(() => store.viewerDb, (db, previous) => {
  if (db && db !== previous) {
    selected.value = null;
    page.value = null;
    description.value = null;
    loadCollections();
  }
});
</script>

<template>
  <div class="fixed inset-0 z-200 flex animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 w-full h-full flex flex-col overflow-hidden">
      <!-- Header (drag region with traffic light clearance) -->
      <div class="px-4 pt-7 pb-1.5 border-b border-gray-200 dark:border-zinc-800 flex items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl drag-region">
        <div class="w-8 shrink-0"></div>
        <div class="flex-1 flex flex-col items-center justify-center no-drag min-w-0">
          <div class="flex items-center gap-2">
            <div class="w-5 h-5 rounded bg-green-500/10 text-green-600 flex items-center justify-center shrink-0">
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21c-4-3-6-7.5-6-11.5C6 6 8.7 3 12 3s6 3 6 6.5C18 13.5 16 18 12 21zm0 0V8" />
              </svg>
            </div>
            <h3 class="text-xs font-bold text-gray-900 dark:text-white leading-tight">{{ store.viewerDb?.displayName || store.viewerDb?.name }}</h3>
            <span v-if="features.feature(store.viewerDb, 'explorer.documents').beta" class="text-[9px] px-1 py-0.5 rounded font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">{{ t('common.beta') }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
            <span class="font-mono">{{ store.viewerDb?.host }}:{{ store.viewerDb?.port }}</span>
            <span>•</span>
            <span>{{ t('mongoViewer.collectionsCount', { count: collections.length }) }}</span>
          </div>
        </div>
        <button
          class="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200 no-drag shrink-0"
          :aria-label="t('mongoViewer.close')"
          @click="emit('close')"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <!-- Collections -->
        <aside class="w-60 shrink-0 border-r border-gray-200 dark:border-white/10 flex flex-col bg-gray-50/40 dark:bg-zinc-900/40">
          <div class="p-2">
            <input
              v-model="collectionSearch"
              type="search"
              :placeholder="t('mongoViewer.searchCollections')"
              class="w-full h-8 px-2.5 rounded-md text-xs bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 outline-none focus:border-green-500"
            />
          </div>
          <div class="flex-1 overflow-y-auto px-1 pb-2">
            <p v-if="loadingCollections" class="px-3 py-2 text-xs text-gray-400">{{ t('viewer.loadingDb') }}</p>
            <p v-else-if="!connectionError && !collections.length" class="px-3 py-2 text-xs text-gray-400">{{ t('mongoViewer.noCollections') }}</p>
            <button
              v-for="collection in shownCollections"
              :key="collection.name"
              type="button"
              class="w-full flex items-center gap-2 px-2.5 h-8 rounded-md text-left text-xs transition-colors"
              :class="selected === collection.name
                ? 'bg-green-500/10 text-green-700 dark:text-green-400 font-medium'
                : 'text-gray-700 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-white/5'"
              @click="selectCollection(collection.name)"
            >
              <span class="flex-1 min-w-0 truncate font-mono">{{ collection.name }}</span>
              <span v-if="collection.type !== 'collection'" class="text-[9px] px-1 rounded bg-gray-200 dark:bg-zinc-700 text-gray-500 dark:text-zinc-400">{{ collection.type === 'view' ? t('mongoViewer.view') : collection.type }}</span>
              <span v-if="collection.documents !== null" class="text-[10px] tabular-nums text-gray-400">{{ formatCount(collection.documents) }}</span>
            </button>
          </div>
        </aside>

        <!-- Main -->
        <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
          <!-- Connection error -->
          <div v-if="connectionError" class="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div class="p-6 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-2xl max-w-md">
              <h3 class="text-base font-bold text-red-700 dark:text-red-500 mb-2">{{ t('viewer.connectionFailed') }}</h3>
              <p class="text-sm text-red-600 dark:text-red-400 mb-4 break-words">{{ connectionError }}</p>
              <button class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium" @click="loadCollections">{{ t('viewer.retry') }}</button>
            </div>
          </div>

          <!-- Nothing picked -->
          <div v-else-if="!selected" class="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <h3 class="text-lg font-bold text-gray-900 dark:text-white mb-1">{{ t('mongoViewer.pickCollection') }}</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 max-w-xs">{{ t('mongoViewer.pickCollectionHint') }}</p>
          </div>

          <template v-else>
            <!-- Collection header and tabs -->
            <div class="px-4 pt-3 border-b border-gray-200 dark:border-white/10">
              <div class="flex items-baseline gap-2">
                <h2 class="text-sm font-semibold font-mono text-gray-900 dark:text-white truncate">{{ selected }}</h2>
                <span v-if="rangeLabel" class="text-[11px] text-gray-500 dark:text-gray-400">{{ rangeLabel }}</span>
              </div>
              <nav class="-mb-px flex gap-4 mt-2">
                <button
                  v-for="item in tabs"
                  :key="item"
                  type="button"
                  class="py-2 px-1 border-b-2 font-medium text-xs transition-colors"
                  :class="tab === item ? 'border-green-500 text-green-700 dark:text-green-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'"
                  @click="tab = item"
                >{{ tabLabel(item) }}</button>
              </nav>
            </div>

            <!-- Documents -->
            <div v-if="tab === 'documents'" class="flex-1 min-h-0 flex">
              <div class="flex-1 min-w-0 flex flex-col">
                <!-- Toolbar -->
                <div class="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-white/5">
                  <label class="sr-only" for="mongo-filter">{{ t('mongoViewer.filterLabel') }}</label>
                  <input
                    id="mongo-filter"
                    v-model="filterText"
                    type="text"
                    spellcheck="false"
                    :placeholder="t('mongoViewer.filterPlaceholder')"
                    class="flex-1 min-w-[220px] h-8 px-2.5 rounded-md text-xs font-mono bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 outline-none focus:border-green-500"
                    @keydown.enter="applyFilter"
                  />
                  <button type="button" class="h-8 px-3 rounded-md text-xs font-medium bg-green-600 hover:bg-green-700 text-white" @click="applyFilter">{{ t('mongoViewer.apply') }}</button>
                  <button v-if="filterText || appliedFilter" type="button" class="h-8 px-2 rounded-md text-xs text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200" @click="clearFilter">{{ t('mongoViewer.clear') }}</button>
                  <span class="w-px h-5 bg-gray-200 dark:bg-white/10" />
                  <label class="sr-only" for="mongo-sort">{{ t('mongoViewer.sortBy') }}</label>
                  <select id="mongo-sort" v-model="sortField" class="h-8 px-2 rounded-md text-xs bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10" @change="changeSort">
                    <option value="">{{ t('mongoViewer.sortNone') }}</option>
                    <option v-for="field in sortableFields" :key="field" :value="field">{{ field }}</option>
                  </select>
                  <button
                    type="button"
                    class="h-8 px-2 rounded-md text-xs border border-gray-200 dark:border-white/10 disabled:opacity-40"
                    :disabled="!sortField"
                    :title="sortDirection === 1 ? t('mongoViewer.ascending') : t('mongoViewer.descending')"
                    @click="toggleDirection"
                  >{{ sortDirection === 1 ? '↑' : '↓' }}</button>
                  <span class="w-px h-5 bg-gray-200 dark:bg-white/10" />
                  <div class="inline-flex p-0.5 rounded-md bg-gray-100 dark:bg-zinc-800" role="radiogroup">
                    <button
                      v-for="item in (['table', 'json'] as const)"
                      :key="item"
                      type="button"
                      role="radio"
                      :aria-checked="layout === item"
                      class="px-2 h-7 rounded text-[11px] font-medium"
                      :class="layout === item ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500'"
                      @click="layout = item"
                    >{{ item === 'table' ? t('mongoViewer.table') : 'JSON' }}</button>
                  </div>
                  <template v-if="canEdit">
                    <span class="w-px h-5 bg-gray-200 dark:bg-white/10" />
                    <button type="button" class="h-8 px-3 rounded-md text-xs font-medium border border-green-600/40 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10" @click="startNew">{{ t('mongoViewer.addDocument') }}</button>
                  </template>
                  <span v-else-if="isView" class="text-[11px] text-gray-400">{{ t('mongoViewer.viewReadOnly') }}</span>
                </div>

                <p v-if="documentsError" role="alert" class="mx-4 mt-2 px-3 py-2 rounded-md text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 break-words">{{ documentsError }}</p>

                <!-- Table -->
                <div class="flex-1 min-h-0 overflow-auto relative" :class="{ 'opacity-60': loadingDocuments }">
                  <p v-if="page && !page.documents.length && !loadingDocuments" class="p-6 text-center text-sm text-gray-500">{{ t('mongoViewer.noDocuments') }}</p>
                  <table v-else-if="page && layout === 'table'" class="min-w-full text-xs">
                    <thead class="sticky top-0 bg-gray-50 dark:bg-zinc-800 z-10">
                      <tr>
                        <th v-for="column in columns" :key="column" class="px-3 py-1.5 text-left font-mono font-medium text-gray-600 dark:text-zinc-300 whitespace-nowrap border-b border-gray-200 dark:border-white/10">{{ column }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(document, index) in page.documents"
                        :key="index"
                        class="cursor-pointer border-b border-gray-100 dark:border-white/5 hover:bg-green-50/60 dark:hover:bg-green-500/5"
                        :class="{ 'bg-green-50 dark:bg-green-500/10': opened === document }"
                        @click="opened = document"
                      >
                        <td
                          v-for="column in columns"
                          :key="column"
                          class="px-3 py-1.5 font-mono whitespace-nowrap max-w-[320px] overflow-hidden text-ellipsis"
                          :class="column in document ? 'text-gray-800 dark:text-zinc-200' : 'text-gray-300 dark:text-zinc-600'"
                          :title="column in document ? formatDocumentValue(document[column]) : ''"
                        >{{ column in document ? formatDocumentValue(document[column]) : '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else-if="page" class="p-3 space-y-2">
                    <pre
                      v-for="(document, index) in page.documents"
                      :key="index"
                      class="p-3 rounded-md bg-gray-50 dark:bg-zinc-800/60 text-[11px] leading-relaxed font-mono text-gray-800 dark:text-zinc-200 overflow-x-auto cursor-pointer"
                      @click="opened = document"
                    >{{ prettyJson(document) }}</pre>
                  </div>
                </div>

                <!-- Pages -->
                <div class="flex items-center gap-2 px-4 py-2 border-t border-gray-200 dark:border-white/10 text-xs">
                  <span class="text-gray-500 dark:text-gray-400">{{ rangeLabel }}</span>
                  <span class="flex-1" />
                  <select v-model.number="pageSize" class="h-7 px-1.5 rounded-md text-xs bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10" :aria-label="t('mongoViewer.perPage', { count: pageSize })">
                    <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ t('mongoViewer.perPage', { count: size }) }}</option>
                  </select>
                  <button type="button" class="h-7 px-2.5 rounded-md border border-gray-200 dark:border-white/10 disabled:opacity-40" :disabled="!page || page.skip === 0 || loadingDocuments" @click="goTo(skip - pageSize)">{{ t('mongoViewer.previous') }}</button>
                  <button type="button" class="h-7 px-2.5 rounded-md border border-gray-200 dark:border-white/10 disabled:opacity-40" :disabled="!page?.hasMore || loadingDocuments" @click="goTo(skip + pageSize)">{{ t('mongoViewer.next') }}</button>
                </div>
              </div>

              <!-- One document: read, edit, or a new one -->
              <aside v-if="opened || editing === 'new'" class="w-[420px] shrink-0 border-l border-gray-200 dark:border-white/10 flex flex-col bg-gray-50/40 dark:bg-zinc-900/40">
                <div class="flex items-center gap-2 px-3 h-10 border-b border-gray-200 dark:border-white/10">
                  <span class="text-xs font-semibold text-gray-700 dark:text-zinc-200">{{ editing === 'new' ? t('mongoViewer.newDocument') : t('mongoViewer.document') }}</span>
                  <span class="flex-1" />
                  <template v-if="!editing">
                    <button type="button" class="h-7 px-2 rounded-md text-xs border border-gray-200 dark:border-white/10" @click="copyOpened">{{ copied ? t('mongoViewer.copied') : t('mongoViewer.copy') }}</button>
                    <template v-if="canEdit">
                      <button type="button" class="h-7 px-2 rounded-md text-xs border border-gray-200 dark:border-white/10" @click="startEdit">{{ t('mongoViewer.edit') }}</button>
                      <button type="button" class="h-7 px-2 rounded-md text-xs border border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10" @click="deleteOpened">{{ t('mongoViewer.delete') }}</button>
                    </template>
                  </template>
                  <button type="button" class="h-7 w-7 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-zinc-200" :aria-label="t('mongoViewer.close')" @click="editing === 'new' ? cancelEdit() : (opened = null)">✕</button>
                </div>
                <template v-if="editing">
                  <label class="sr-only" for="mongo-draft">{{ editing === 'new' ? t('mongoViewer.newDocument') : t('mongoViewer.document') }}</label>
                  <textarea
                    id="mongo-draft"
                    v-model="draft"
                    spellcheck="false"
                    class="flex-1 min-h-0 p-3 text-[11px] leading-relaxed font-mono bg-white dark:bg-zinc-900 text-gray-800 dark:text-zinc-200 outline-none resize-none"
                    @keydown.meta.enter.prevent="saveDraft"
                    @keydown.ctrl.enter.prevent="saveDraft"
                  />
                  <div class="px-3 py-2 border-t border-gray-200 dark:border-white/10 space-y-2">
                    <p class="text-[10px] text-gray-500 dark:text-gray-400">{{ editing === 'new' ? t('mongoViewer.newHint') : t('mongoViewer.editHint') }}</p>
                    <p v-if="editError" role="alert" class="px-2 py-1.5 rounded-md text-[11px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 break-words">{{ editError }}</p>
                    <div class="flex justify-end gap-2">
                      <button type="button" class="h-7 px-3 rounded-md text-xs border border-gray-200 dark:border-white/10" :disabled="saving" @click="cancelEdit">{{ t('mongoViewer.cancel') }}</button>
                      <button type="button" class="h-7 px-3 rounded-md text-xs font-medium bg-green-600 hover:bg-green-700 text-white disabled:opacity-50" :disabled="saving" @click="saveDraft">{{ t('mongoViewer.save') }}</button>
                    </div>
                  </div>
                </template>
                <pre v-else class="flex-1 overflow-auto p-3 text-[11px] leading-relaxed font-mono text-gray-800 dark:text-zinc-200 select-text">{{ prettyJson(opened) }}</pre>
              </aside>
            </div>

            <!-- Aggregation (read only) -->
            <div v-else-if="tab === 'aggregate'" class="flex-1 min-h-0 flex flex-col">
              <div class="px-4 py-3 border-b border-gray-100 dark:border-white/5 space-y-2">
                <label class="block text-[11px] font-medium text-gray-600 dark:text-zinc-300" for="mongo-pipeline">{{ t('mongoViewer.pipelineLabel') }}</label>
                <textarea
                  id="mongo-pipeline"
                  v-model="pipelineText"
                  spellcheck="false"
                  rows="7"
                  class="w-full p-2.5 rounded-md text-[11px] leading-relaxed font-mono bg-white dark:bg-zinc-800 border border-gray-200 dark:border-white/10 outline-none focus:border-green-500 resize-y"
                  @keydown.meta.enter.prevent="runAggregate"
                  @keydown.ctrl.enter.prevent="runAggregate"
                />
                <div class="flex items-center gap-3">
                  <p class="flex-1 text-[10px] text-gray-500 dark:text-gray-400">{{ t('mongoViewer.aggregateHint') }}</p>
                  <button type="button" class="h-8 px-4 rounded-md text-xs font-medium bg-green-600 hover:bg-green-700 text-white disabled:opacity-50" :disabled="aggregating" @click="runAggregate">{{ t('mongoViewer.run') }}</button>
                </div>
                <p v-if="aggregateError" role="alert" class="px-3 py-2 rounded-md text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 break-words">{{ aggregateError }}</p>
              </div>
              <div v-if="aggregateResult" class="flex items-center gap-3 px-4 py-1.5 text-[11px] text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-white/5">
                <span>{{ t('mongoViewer.aggregateResult', { count: formatCount(aggregateResult.documents.length), ms: aggregateResult.durationMs }) }}</span>
                <span v-if="aggregateResult.truncated" class="text-amber-700 dark:text-amber-400">{{ t('mongoViewer.aggregateTruncated', { limit: aggregateResult.limit }) }}</span>
                <span class="flex-1" />
                <div class="inline-flex p-0.5 rounded-md bg-gray-100 dark:bg-zinc-800" role="radiogroup">
                  <button
                    v-for="item in (['table', 'json'] as const)"
                    :key="item"
                    type="button"
                    role="radio"
                    :aria-checked="layout === item"
                    class="px-2 h-6 rounded text-[11px] font-medium"
                    :class="layout === item ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500'"
                    @click="layout = item"
                  >{{ item === 'table' ? t('mongoViewer.table') : 'JSON' }}</button>
                </div>
              </div>
              <div class="flex-1 min-h-0 overflow-auto" :class="{ 'opacity-60': aggregating }">
                <p v-if="aggregateResult && !aggregateResult.documents.length" class="p-6 text-center text-sm text-gray-500">{{ t('mongoViewer.aggregateEmpty') }}</p>
                <table v-else-if="aggregateResult && layout === 'table'" class="min-w-full text-xs">
                  <thead class="sticky top-0 bg-gray-50 dark:bg-zinc-800 z-10">
                    <tr>
                      <th v-for="column in aggregateColumns" :key="column" class="px-3 py-1.5 text-left font-mono font-medium text-gray-600 dark:text-zinc-300 whitespace-nowrap border-b border-gray-200 dark:border-white/10">{{ column }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(document, index) in aggregateResult.documents" :key="index" class="border-b border-gray-100 dark:border-white/5">
                      <td
                        v-for="column in aggregateColumns"
                        :key="column"
                        class="px-3 py-1.5 font-mono whitespace-nowrap max-w-[320px] overflow-hidden text-ellipsis"
                        :class="column in document ? 'text-gray-800 dark:text-zinc-200' : 'text-gray-300 dark:text-zinc-600'"
                        :title="column in document ? formatDocumentValue(document[column]) : ''"
                      >{{ column in document ? formatDocumentValue(document[column]) : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else-if="aggregateResult" class="p-3 space-y-2">
                  <pre
                    v-for="(document, index) in aggregateResult.documents"
                    :key="index"
                    class="p-3 rounded-md bg-gray-50 dark:bg-zinc-800/60 text-[11px] leading-relaxed font-mono text-gray-800 dark:text-zinc-200 overflow-x-auto select-text"
                  >{{ prettyJson(document) }}</pre>
                </div>
              </div>
            </div>

            <!-- Schema and indexes -->
            <div v-else class="flex-1 min-h-0 overflow-auto p-4 space-y-6">
              <p v-if="loadingDescription" class="text-xs text-gray-400">{{ t('viewer.loadingDb') }}</p>
              <p v-else-if="descriptionError" role="alert" class="px-3 py-2 rounded-md text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 break-words">{{ descriptionError }}</p>
              <template v-else-if="description">
                <section>
                  <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">{{ sampleInfo }}</p>
                  <table class="w-full text-xs">
                    <thead>
                      <tr class="text-left text-gray-500 dark:text-zinc-400 border-b border-gray-200 dark:border-white/10">
                        <th class="py-1.5 pr-3 font-medium">{{ t('mongoViewer.field') }}</th>
                        <th class="py-1.5 pr-3 font-medium w-40">{{ t('mongoViewer.presence') }}</th>
                        <th class="py-1.5 font-medium">{{ t('mongoViewer.types') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="field in description.fields" :key="field.path" class="border-b border-gray-100 dark:border-white/5">
                        <td class="py-1.5 pr-3 font-mono text-gray-800 dark:text-zinc-200" :style="{ paddingLeft: `${depthOf(field.path) * 14}px` }">{{ field.path }}</td>
                        <td class="py-1.5 pr-3">
                          <div class="flex items-center gap-2">
                            <div class="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-zinc-800 overflow-hidden">
                              <div class="h-full bg-green-500" :style="{ width: percent(field.presence) }" />
                            </div>
                            <span class="w-9 text-right tabular-nums text-gray-500">{{ percent(field.presence) }}</span>
                          </div>
                        </td>
                        <td class="py-1.5">
                          <span
                            v-for="type in field.types"
                            :key="type.type"
                            class="inline-block mr-1 mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-zinc-300"
                          >{{ field.types.length > 1 ? `${type.type} ${percent(type.share)}` : type.type }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </section>

                <section>
                  <h3 class="text-xs font-semibold text-gray-700 dark:text-zinc-200 mb-2">{{ t('mongoViewer.indexes') }}</h3>
                  <p v-if="!description.indexes.length" class="text-xs text-gray-400">{{ t('mongoViewer.noIndexes') }}</p>
                  <table v-else class="w-full text-xs">
                    <thead>
                      <tr class="text-left text-gray-500 dark:text-zinc-400 border-b border-gray-200 dark:border-white/10">
                        <th class="py-1.5 pr-3 font-medium">{{ t('mongoViewer.indexName') }}</th>
                        <th class="py-1.5 pr-3 font-medium">{{ t('mongoViewer.indexKeys') }}</th>
                        <th class="py-1.5 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="index in description.indexes" :key="index.name" class="border-b border-gray-100 dark:border-white/5">
                        <td class="py-1.5 pr-3 font-mono text-gray-800 dark:text-zinc-200">{{ index.name }}</td>
                        <td class="py-1.5 pr-3 font-mono text-gray-600 dark:text-zinc-300">{{ JSON.stringify(index.keys) }}</td>
                        <td class="py-1.5 space-x-1">
                          <span v-if="index.unique" class="px-1.5 py-0.5 rounded text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">{{ t('mongoViewer.unique') }}</span>
                          <span v-if="index.sparse" class="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300">{{ t('mongoViewer.sparse') }}</span>
                          <span v-if="index.partial" class="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-300">{{ t('mongoViewer.partial') }}</span>
                          <span v-if="index.ttlSeconds !== undefined" class="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">{{ t('mongoViewer.ttl', { seconds: index.ttlSeconds }) }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </section>
              </template>
            </div>
          </template>
        </main>
      </div>
    </div>
  </div>
</template>

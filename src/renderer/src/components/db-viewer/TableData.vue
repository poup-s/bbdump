<script setup lang="ts">
import { ref, watch, onMounted, computed, onBeforeUnmount } from 'vue';
import { getErrorMessage } from '../../utils';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { ipcRenderer } from '../../electron';
import { Database, buildDbConfig } from '../../types';
import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption, ComboboxButton } from '@headlessui/vue';
import { useDebounceFn } from '@vueuse/core';

const props = defineProps<{
  db: Database | null;
  table: string | null;
}>();

defineEmits(['navigateToTable']);

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm, state: confirmState } = useConfirm();

const rows = ref<any[]>([]);
const columns = ref<any[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const page = ref(1);
const pageSize = ref(50);
const totalRows = ref(0);
const primaryKey = ref<string | null>(null);
const searchQuery = ref('');
const sortBy = ref<string | null>(null);
const sortOrder = ref<'asc' | 'desc'>('asc');

// Slide-over edit state
const slideoverEdits = ref<Record<string, any>>({});
const slideoverSaving = ref(false);

// Add row state
const isAddMode = ref(false);
const addFormData = ref<Record<string, any>>({});
const addSaving = ref(false);
const fkOptions = ref<Record<string, { value: any; label: string; details: { key: string; value: string }[] }[]>>({});
const fkLoading = ref<Record<string, boolean>>({});

// Column resize state
const columnWidths = ref<Map<string, number>>(new Map());
const resizing = ref<{ col: string; startX: number; startWidth: number } | null>(null);

// Copy feedback
const copiedCell = ref<string | null>(null);

// Page jump
const pageJumpInput = ref('');

// Row detail slide-over
const selectedRowIndex = ref<number | null>(null);
const copiedField = ref<string | null>(null);

// FK relation preview
const fkPreview = ref<{
  tableName: string;
  columnName: string;
  value: any;
  row: Record<string, any> | null;
  columns: any[];
  loading: boolean;
  error: string | null;
} | null>(null);

const selectedRowData = computed(() => {
  if (selectedRowIndex.value === null || selectedRowIndex.value >= rows.value.length) return null;
  return rows.value[selectedRowIndex.value];
});

// Slide-over edit computeds
const slideoverChangesCount = computed(() => Object.keys(slideoverEdits.value).length);
const hasUnsavedChanges = computed(() => slideoverChangesCount.value > 0);

// Guard: check for unsaved changes before performing an action
const guardedAction = (action: () => void) => {
  if (confirmState.show) return; // A confirm is already showing
  if (hasUnsavedChanges.value) {
    showConfirm({
      title: t('viewer.unsavedChanges'),
      message: t('viewer.unsavedChangesConfirm'),
      confirmText: t('viewer.discard'),
      type: 'warning',
      onConfirm: () => {
        slideoverEdits.value = {};
        action();
      }
    });
  } else {
    action();
  }
};

const selectRow = (index: number) => {
  const newIndex = selectedRowIndex.value === index ? null : index;
  guardedAction(() => {
    fkPreview.value = null;
    selectedRowIndex.value = newIndex;
  });
};

const closeDetail = () => {
  if (isAddMode.value) {
    cancelAddRow();
    return;
  }
  guardedAction(() => {
    selectedRowIndex.value = null;
    fkPreview.value = null;
  });
};

const closeFkPreview = () => {
  fkPreview.value = null;
};

const prevRow = () => {
  if (selectedRowIndex.value !== null && selectedRowIndex.value > 0) {
    guardedAction(() => {
      fkPreview.value = null;
      selectedRowIndex.value = selectedRowIndex.value! - 1;
    });
  }
};

const nextRow = () => {
  if (selectedRowIndex.value !== null && selectedRowIndex.value < rows.value.length - 1) {
    guardedAction(() => {
      fkPreview.value = null;
      selectedRowIndex.value = selectedRowIndex.value! + 1;
    });
  }
};

const copyFieldValue = async (value: any, colName: string) => {
  const text = value === null ? '' : String(value);
  try {
    await navigator.clipboard.writeText(text);
    copiedField.value = colName;
    setTimeout(() => { copiedField.value = null; }, 1200);
  } catch {
    // Fallback for non-secure contexts
  }
};

const handleKeydown = (e: KeyboardEvent) => {
  if (fkPreview.value) {
    if (e.key === 'Escape') { closeFkPreview(); }
    return;
  }
  if (selectedRowIndex.value === null) return;
  if (e.key === 'Escape') {
    closeDetail();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (selectedRowIndex.value < rows.value.length - 1) {
      guardedAction(() => {
        fkPreview.value = null;
        selectedRowIndex.value = selectedRowIndex.value! + 1;
      });
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (selectedRowIndex.value > 0) {
      guardedAction(() => {
        fkPreview.value = null;
        selectedRowIndex.value = selectedRowIndex.value! - 1;
      });
    }
  }
};

const totalPages = computed(() => Math.max(1, Math.ceil(totalRows.value / pageSize.value)));

const loadData = async () => {
  if (!props.db || !props.table) return;

  loading.value = true;
  error.value = null;

  try {
    const dbConfig = buildDbConfig(props.db);

    // First get columns to identify PK
    const schema = await ipcRenderer.invoke('get-table-schema', {
      db: dbConfig,
      table: props.table
    });
    columns.value = schema.columns;
    const pkCol = schema.columns.find((c: any) => c.is_primary);
    primaryKey.value = pkCol ? pkCol.column_name : null;

    // Get data
    const result = await ipcRenderer.invoke('get-table-data', {
      db: dbConfig,
      table: props.table,
      page: page.value,
      pageSize: pageSize.value,
      search: searchQuery.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value
    });

    rows.value = result.rows;
    totalRows.value = result.total;
  } catch (err) {
    console.error('Error loading data:', err);
    error.value = getErrorMessage(err);
  } finally {
    loading.value = false;
  }
};

const debouncedSearch = useDebounceFn(() => {
  page.value = 1;
  loadData();
}, 300);

const handleSort = (columnName: string) => {
  if (sortBy.value === columnName) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortBy.value = columnName;
    sortOrder.value = 'asc';
  }
  loadData();
};

// Delete current row from slide-over
const deleteCurrentRow = () => {
  if (!primaryKey.value || selectedRowData.value === null) {
    addToast(t('viewer.noPrimaryKey'), 'error');
    return;
  }

  const pkValue = selectedRowData.value[primaryKey.value];
  if (pkValue === null || pkValue === undefined) {
    addToast(t('viewer.pkValueMissing'), 'error');
    return;
  }

  showConfirm({
    title: t('viewer.deleteRow'),
    message: t('viewer.deleteRowConfirm'),
    confirmText: t('viewer.delete'),
    type: 'danger',
    onConfirm: async () => {
      if (!props.db) return;

      try {
        await ipcRenderer.invoke('delete-table-row', {
          db: buildDbConfig(props.db),
          table: props.table,
          primaryKeyColumn: primaryKey.value,
          rowId: pkValue
        });
        addToast(t('viewer.rowDeleted'), 'success');
        slideoverEdits.value = {};
        selectedRowIndex.value = null;
        fkPreview.value = null;
        loadData();
      } catch (err) {
        addToast(t('viewer.deleteErrorDetail', { error: getErrorMessage(err) }), 'error');
      }
    }
  });
};

const prevPage = () => {
  if (page.value > 1) {
    page.value--;
    loadData();
  }
};

const nextPage = () => {
  if (page.value * pageSize.value < totalRows.value) {
    page.value++;
    loadData();
  }
};

// Page jump
const goToPage = () => {
  const target = parseInt(pageJumpInput.value);
  if (!isNaN(target) && target >= 1 && target <= totalPages.value) {
    page.value = target;
    pageJumpInput.value = '';
    loadData();
  }
};

// Page size change
const changePageSize = (newSize: number) => {
  pageSize.value = newSize;
  page.value = 1;
  loadData();
};

// Slide-over edit functions
const getFieldEditValue = (col: any) => {
  const colName = col.column_name;
  if (colName in slideoverEdits.value) {
    return slideoverEdits.value[colName];
  }
  return selectedRowData.value ? selectedRowData.value[colName] : null;
};

const handleFieldChange = (col: any, newValue: any) => {
  const colName = col.column_name;
  const original = selectedRowData.value ? selectedRowData.value[colName] : null;

  const isSame = (() => {
    if (newValue === null && original === null) return true;
    if (newValue === null || original === null) return false;
    if (typeof newValue === 'boolean') return newValue === original;
    // For objects (JSON), compare with stringified version
    if (typeof original === 'object') {
      try { return newValue === JSON.stringify(original, null, 2); } catch { return false; }
    }
    return String(newValue) === String(original);
  })();

  if (isSame) {
    const edits = { ...slideoverEdits.value };
    delete edits[colName];
    slideoverEdits.value = edits;
  } else {
    slideoverEdits.value = { ...slideoverEdits.value, [colName]: newValue };
  }
};

const getFieldInputType = (col: any): string => {
  const dtype = col.data_type?.toLowerCase() || '';
  const udtName = col.udt_name?.toLowerCase() || '';
  if (dtype === 'boolean' || udtName === 'bool') return 'checkbox';
  if (dtype === 'json' || dtype === 'jsonb' || dtype === 'text') return 'textarea';
  if (dtype.includes('timestamp')) return 'datetime-local';
  if (dtype === 'date') return 'date';
  if (dtype === 'time' || dtype === 'time without time zone' || dtype === 'time with time zone') return 'time';
  if (dtype === 'integer' || dtype === 'bigint' || dtype === 'smallint' || dtype === 'numeric' || dtype === 'real' || dtype === 'double precision' || dtype === 'serial' || dtype === 'bigserial') return 'number';
  return 'text';
};

const formatForInput = (value: any, col: any): string => {
  if (value === null || value === undefined) return '';
  const dtype = col.data_type?.toLowerCase() || '';
  const pad = (n: number) => String(n).padStart(2, '0');
  if (dtype.includes('timestamp')) {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    } catch { /* fallback */ }
  }
  if (dtype === 'date') {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      }
    } catch { /* fallback */ }
  }
  if (dtype === 'json' || dtype === 'jsonb') {
    if (typeof value === 'object') {
      try { return JSON.stringify(value, null, 2); } catch { /* fallback */ }
    }
  }
  return String(value);
};

const saveSlideoverChanges = async () => {
  if (!hasUnsavedChanges.value || !primaryKey.value || !selectedRowData.value || !props.db) return;

  slideoverSaving.value = true;
  try {
    const changes = Object.entries(slideoverEdits.value).map(([columnName, newValue]) => ({
      rowId: selectedRowData.value![primaryKey.value!],
      primaryKeyColumn: primaryKey.value!,
      column: columnName,
      oldValue: selectedRowData.value![columnName],
      newValue: newValue
    }));

    await ipcRenderer.invoke('update-table-data', {
      db: buildDbConfig(props.db),
      table: props.table,
      changes
    });

    addToast(t('viewer.saveSuccess', { count: changes.length }), 'success');
    slideoverEdits.value = {};
    loadData();
  } catch (err) {
    console.error('Error saving changes:', err);
    addToast(t('viewer.saveErrorDetail', { error: getErrorMessage(err) }), 'error');
  } finally {
    slideoverSaving.value = false;
  }
};

const discardSlideoverChanges = () => {
  slideoverEdits.value = {};
};

// Add row mode
const editableColumnsForAdd = computed(() => columns.value.filter(col => !col.is_primary));
const isFieldRequired = (col: any) => col.is_nullable === 'NO' && !col.column_default;

const startAddRow = () => {
  // Close row detail if open
  selectedRowIndex.value = null;
  fkPreview.value = null;
  slideoverEdits.value = {};

  isAddMode.value = true;
  addFormData.value = {};
  fkOptions.value = {};
  fkLoading.value = {};

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

  columns.value.forEach(col => {
    if (col.is_primary) return;

    // Auto-fill timestamps
    if (['created_at', 'updated_at', 'timestamp'].includes(col.column_name) &&
        (col.data_type.includes('timestamp') || col.data_type.includes('date'))) {
      addFormData.value[col.column_name] = nowStr;
    } else if (col.column_default) {
      addFormData.value[col.column_name] = null; // Let DB handle defaults
    } else if (col.is_nullable === 'NO') {
      // Required field — initialize with appropriate empty value
      const inputType = getFieldInputType(col);
      addFormData.value[col.column_name] = inputType === 'checkbox' ? false : '';
    } else {
      addFormData.value[col.column_name] = null;
    }

    // Load FK options
    if (col.is_foreign && col.foreign_key) {
      loadFkOptions(col.column_name, col.foreign_key.table, col.foreign_key.column);
    }
  });
};

const cancelAddRow = () => {
  isAddMode.value = false;
  addFormData.value = {};
  fkOptions.value = {};
  fkLoading.value = {};
};

const saveNewRow = async () => {
  if (!props.db || !props.table) return;

  // Validate required fields
  const missingFields = editableColumnsForAdd.value
    .filter(col => isFieldRequired(col))
    .filter(col => {
      const val = addFormData.value[col.column_name];
      return val === null || val === undefined || val === '';
    });

  if (missingFields.length > 0) {
    addToast(t('viewer.addRowRequiredMissing', { fields: missingFields.map(f => f.column_name).join(', ') }), 'error');
    return;
  }

  addSaving.value = true;
  try {
    await ipcRenderer.invoke('insert-table-row', {
      db: buildDbConfig(props.db),
      table: props.table,
      rowData: addFormData.value
    });

    addToast(t('viewer.addRowSuccess'), 'success');
    cancelAddRow();
    loadData();
  } catch (err) {
    console.error('Error adding row:', err);
    addToast(getErrorMessage(err) || 'Error adding row', 'error');
  } finally {
    addSaving.value = false;
  }
};

const loadFkOptions = async (columnName: string, foreignTable: string, foreignColumn: string, search = '') => {
  if (!props.db) return;

  fkLoading.value = { ...fkLoading.value, [columnName]: true };
  try {
    const result = await ipcRenderer.invoke('get-table-data', {
      db: buildDbConfig(props.db),
      table: foreignTable,
      page: 1,
      pageSize: 50,
      search: search,
      sortBy: foreignColumn,
      sortOrder: 'asc'
    });

    fkOptions.value = {
      ...fkOptions.value,
      [columnName]: result.rows.map((row: any) => ({
        value: row[foreignColumn],
        label: formatFkLabel(row, foreignColumn),
        details: buildFkDetails(row, foreignColumn)
      }))
    };
  } catch (err) {
    console.error(`Error loading FK options for ${columnName}:`, err);
  } finally {
    fkLoading.value = { ...fkLoading.value, [columnName]: false };
  }
};

const formatFkLabel = (row: any, idColumn: string): string => {
  const descriptiveKeys = ['name', 'title', 'email', 'username', 'label', 'description', 'slug'];
  const foundKey = descriptiveKeys.find(key => Object.prototype.hasOwnProperty.call(row, key));
  return foundKey ? `${row[foundKey]} (${row[idColumn]})` : String(row[idColumn]);
};

// Build secondary details for FK option (up to 4 non-ID columns)
const buildFkDetails = (row: any, idColumn: string): { key: string; value: string }[] => {
  const skipKeys = new Set([idColumn, 'id', 'created_at', 'updated_at', 'deleted_at']);
  const descriptiveKeys = ['name', 'title', 'email', 'username', 'label', 'description', 'slug'];
  const details: { key: string; value: string }[] = [];
  const allKeys = Object.keys(row).filter(k => !skipKeys.has(k));

  // Prioritize descriptive keys first, then other columns
  const sortedKeys = allKeys.sort((a, b) => {
    const aIdx = descriptiveKeys.indexOf(a);
    const bIdx = descriptiveKeys.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return 0;
  });

  for (const key of sortedKeys) {
    if (details.length >= 4) break;
    const val = row[key];
    if (val === null || val === undefined) continue;
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    // Skip very long values (likely text/json blobs)
    if (str.length > 80) continue;
    details.push({ key, value: str.length > 60 ? str.slice(0, 57) + '...' : str });
  }

  return details;
};

const handleFkSearch = (columnName: string, query: string) => {
  const col = columns.value.find(c => c.column_name === columnName);
  if (col && col.foreign_key) {
    loadFkOptions(columnName, col.foreign_key.table, col.foreign_key.column, query);
  }
};

// Copy cell value to clipboard
const _copyCell = async (value: any, rowIndex: number, colName: string) => {
  const text = value === null ? '' : String(value);
  try {
    await navigator.clipboard.writeText(text);
    copiedCell.value = `${rowIndex}:${colName}`;
    setTimeout(() => { copiedCell.value = null; }, 1200);
  } catch {
    // Fallback for non-secure contexts
  }
};

// Export CSV
const exportCSV = () => {
  if (rows.value.length === 0 || columns.value.length === 0) {
    addToast(t('viewer.exportError'), 'error');
    return;
  }

  const colNames = columns.value.map((c: any) => c.column_name);
  const header = colNames.map(escapeCsvField).join(',');
  const csvRows = rows.value.map(row =>
    colNames.map(col => escapeCsvField(row[col])).join(',')
  );
  const csv = [header, ...csvRows].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.table || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  addToast(t('viewer.exportSuccess', { count: rows.value.length, filename: a.download }), 'success');
};

const escapeCsvField = (value: any): string => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// Open FK relation preview in slide-over
const navigateToFk = async (col: any, value: any) => {
  if (!col.foreign_key || value === null || !props.db) return;

  const targetTable = col.foreign_key.table;
  const targetColumn = col.foreign_key.column;

  fkPreview.value = {
    tableName: targetTable,
    columnName: targetColumn,
    value,
    row: null,
    columns: [],
    loading: true,
    error: null
  };

  try {
    const dbConfig = buildDbConfig(props.db);

    const [schema, data] = await Promise.all([
      ipcRenderer.invoke('get-table-schema', { db: dbConfig, table: targetTable }),
      ipcRenderer.invoke('get-fk-row', {
        db: dbConfig,
        table: targetTable,
        column: targetColumn,
        value
      })
    ]);

    if (fkPreview.value) {
      fkPreview.value.columns = schema.columns;
      fkPreview.value.row = data.row || null;
      fkPreview.value.loading = false;
    }
  } catch (err) {
    if (fkPreview.value) {
      fkPreview.value.error = getErrorMessage(err);
      fkPreview.value.loading = false;
    }
  }
};

// Cell display formatting
const formatCellValue = (value: any, col: any): string => {
  if (value === null) return '';
  const dtype = col.data_type?.toLowerCase() || '';
  const udtName = col.udt_name?.toLowerCase() || '';

  // Boolean
  if (dtype === 'boolean' || udtName === 'bool') {
    return value ? 'true' : 'false';
  }
  // JSON
  if (dtype === 'json' || dtype === 'jsonb') {
    try {
      if (typeof value === 'string') return value;
      return JSON.stringify(value, null, 2);
    } catch { return String(value); }
  }
  // Timestamp/date
  if (dtype.includes('timestamp') || dtype === 'date') {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        if (dtype === 'date') return d.toLocaleDateString();
        return d.toLocaleString();
      }
    } catch { /* fallback */ }
  }
  return String(value);
};

const getCellClass = (value: any, col: any): string => {
  if (value === null) return '';
  const dtype = col.data_type?.toLowerCase() || '';
  const udtName = col.udt_name?.toLowerCase() || '';
  if (dtype === 'boolean' || udtName === 'bool') return value ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400';
  if (dtype === 'json' || dtype === 'jsonb') return 'text-purple-600 dark:text-purple-400';
  if (dtype.includes('timestamp') || dtype === 'date') return 'text-blue-600 dark:text-blue-400';
  if (dtype === 'integer' || dtype === 'bigint' || dtype === 'smallint' || dtype === 'numeric' || dtype === 'real' || dtype === 'double precision') return 'tabular-nums';
  return '';
};

// Column resize
const startResize = (col: string, event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  const currentWidth = columnWidths.value.get(col) || 180;
  resizing.value = { col, startX: event.clientX, startWidth: currentWidth };
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
};

const onResizeMove = (event: MouseEvent) => {
  if (!resizing.value) return;
  const diff = event.clientX - resizing.value.startX;
  const newWidth = Math.max(80, resizing.value.startWidth + diff);
  columnWidths.value.set(resizing.value.col, newWidth);
};

const onResizeEnd = () => {
  resizing.value = null;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
};

onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
  document.removeEventListener('keydown', handleKeydown);
});

const getColStyle = (colName: string) => {
  const w = columnWidths.value.get(colName);
  return w ? { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` } : {};
};

watch(() => props.table, () => {
  page.value = 1;
  searchQuery.value = '';
  sortBy.value = null;
  sortOrder.value = 'asc';
  slideoverEdits.value = {};
  columnWidths.value.clear();
  selectedRowIndex.value = null;
  fkPreview.value = null;
  isAddMode.value = false;
  addFormData.value = {};
  fkOptions.value = {};
  fkLoading.value = {};
  loadData();
});

onMounted(() => {
  loadData();
  document.addEventListener('keydown', handleKeydown);
});

defineExpose({
  hasUnsavedChanges,
  discardChanges: discardSlideoverChanges
});
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Toolbar -->
    <div class="mb-1 flex justify-between items-center gap-2 px-1">
      <div class="flex items-center gap-1">
        <button
          @click="loadData"
          :disabled="loading || slideoverSaving"
          class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
          :title="t('viewer.refresh')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <div class="h-4 w-px bg-white/10"></div>

        <!-- Search Input -->
        <div class="relative w-64">
          <input
            v-model="searchQuery"
            @input="debouncedSearch"
            type="text"
            class="w-full pl-7 pr-2 py-1 bg-surface/50 border border-white/10 rounded-md text-xs focus:ring-1 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder-gray-500 text-foreground"
            :placeholder="t('viewer.searchData')"
          />
          <svg class="w-3.5 h-3.5 text-gray-500 absolute left-2 top-[5px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <div class="h-4 w-px bg-white/10"></div>

        <!-- Add Row Button -->
        <button
          @click="guardedAction(() => startAddRow())"
          :disabled="!primaryKey || isAddMode"
          class="p-1.5 text-blue-500 hover:text-blue-400 rounded-md hover:bg-blue-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :title="!primaryKey ? t('viewer.noPkAdding') : t('viewer.addRow')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>

        <!-- Export CSV Button -->
        <button
          @click="exportCSV"
          :disabled="rows.length === 0"
          class="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :title="t('viewer.exportCSV')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
      </div>

      <!-- Pagination -->
      <div class="flex items-center gap-1">
        <select
          :value="pageSize"
          @change="changePageSize(Number(($event.target as HTMLSelectElement).value))"
          class="text-[10px] bg-surface/50 border border-white/10 rounded-md px-1 py-1 text-foreground outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option v-for="size in [25, 50, 100, 200]" :key="size" :value="size">{{ size }}</option>
        </select>

        <span class="text-[10px] text-gray-500 dark:text-gray-400 tabular-nums mx-1">
          {{ (page - 1) * pageSize + 1 }}-{{ Math.min(page * pageSize, totalRows) }} / {{ totalRows }}
        </span>
        <button
          @click="prevPage"
          :disabled="page === 1 || loading"
          class="p-1 border border-gray-200 dark:border-white/10 rounded-md hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-400 transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <input
          v-model="pageJumpInput"
          @keydown.enter="goToPage"
          type="text"
          :placeholder="String(page)"
          class="w-8 text-center text-[10px] font-medium bg-surface/50 border border-white/10 rounded-md py-0.5 text-foreground outline-none focus:ring-1 focus:ring-blue-500"
          :title="t('viewer.goToPage')"
        />
        <span class="text-[10px] text-gray-500">/ {{ totalPages }}</span>

        <button
          @click="nextPage"
          :disabled="page * pageSize >= totalRows || loading"
          class="p-1 border border-gray-200 dark:border-white/10 rounded-md hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-400 transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="flex-1 overflow-hidden relative">
      <!-- Unsaved changes backdrop - blocks table interaction -->
      <div
        v-if="hasUnsavedChanges && selectedRowData"
        class="absolute inset-0 bg-black/5 dark:bg-black/15 z-15 backdrop-blur-[0.5px] cursor-pointer"
        @click="closeDetail"
      ></div>
    <div class="h-full overflow-auto border border-gray-200 dark:border-white/10 rounded-lg relative bg-white/50 dark:bg-surface/30">
      <div v-if="loading" class="absolute inset-0 bg-white/80 dark:bg-surface/80 backdrop-blur-sm flex items-center justify-center z-10">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>

      <div v-if="error" class="p-8 text-center text-red-600 dark:text-red-400">
        {{ error }}
      </div>

      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-white/10" :class="{ 'select-none': !!resizing }">
        <thead class="bg-gray-50/80 dark:bg-surface/50 sticky top-0 z-1 backdrop-blur-md">
          <tr>
            <th
              v-for="col in columns"
              :key="col.column_name"
              :style="getColStyle(col.column_name)"
              class="relative px-3 py-2 text-left text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap cursor-pointer hover:text-gray-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors select-none group"
              @click="handleSort(col.column_name)"
            >
              <div class="flex items-center gap-1.5">
                {{ col.column_name }}
                <span v-if="col.is_primary" class="text-yellow-500 text-[10px]" :title="t('viewer.primaryKey')">🔑</span>
                <span v-if="col.is_foreign" class="text-blue-400 text-[10px]" title="FK">🔗</span>
                <span v-if="sortBy === col.column_name" class="text-blue-500 dark:text-blue-400">
                  {{ sortOrder === 'asc' ? '↑' : '↓' }}
                </span>
              </div>
              <div class="text-[10px] text-gray-400 dark:text-gray-500 font-normal lowercase mt-0.5">{{ col.data_type }}</div>
              <!-- Resize handle -->
              <div
                class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize opacity-0 group-hover:opacity-100 hover:bg-blue-500/50 transition-opacity"
                @mousedown="startResize(col.column_name, $event)"
              ></div>
            </th>
          </tr>
        </thead>
        <tbody class="bg-transparent divide-y divide-gray-200 dark:divide-white/5">
          <tr
            v-for="(row, i) in rows"
            :key="i"
            @click="selectRow(i)"
            :class="[
              'transition-colors cursor-pointer',
              selectedRowIndex === i
                ? 'bg-blue-500/10 dark:bg-blue-500/15'
                : 'hover:bg-black/5 dark:hover:bg-white/5'
            ]"
          >
            <td
              v-for="col in columns"
              :key="col.column_name"
              :style="getColStyle(col.column_name)"
              :class="[
                'px-3 py-2 text-xs text-gray-900 dark:text-gray-300 overflow-hidden text-ellipsis font-mono whitespace-nowrap',
                getCellClass(row[col.column_name], col),
                col.is_foreign && row[col.column_name] !== null ? 'underline decoration-blue-400/50 decoration-dotted underline-offset-4 hover:decoration-blue-500' : ''
              ]"
              :title="String(row[col.column_name])"
            >
              <!-- NULL -->
              <span v-if="row[col.column_name] === null" class="text-gray-400 dark:text-gray-600 italic text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
              <!-- Boolean -->
              <template v-else-if="(col.data_type === 'boolean' || col.udt_name === 'bool')">
                <span :class="row[col.column_name] ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-xs font-semibold px-1.5 py-0.5 rounded" :style="row[col.column_name] ? 'background: rgb(34 197 94 / 0.1)' : 'background: rgb(239 68 68 / 0.1)'">{{ row[col.column_name] ? 'true' : 'false' }}</span>
              </template>
              <!-- FK link -->
              <template v-else-if="col.is_foreign">
                <span class="cursor-pointer hover:text-blue-500 dark:hover:text-blue-400 transition-colors" @click.stop="navigateToFk(col, row[col.column_name])">{{ formatCellValue(row[col.column_name], col) }}</span>
              </template>
              <!-- Default -->
              <template v-else>{{ formatCellValue(row[col.column_name], col) }}</template>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="!loading && !error && rows.length === 0" class="flex flex-col items-center justify-center py-16 text-center">
        <div class="w-12 h-12 bg-surface/50 rounded-full flex items-center justify-center mb-3 border border-white/10">
          <svg class="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        </div>
        <p class="text-gray-500">{{ t('viewer.noData') }}</p>
      </div>

    </div>

      <!-- Row Detail Slide-over -->
      <Transition
        enter-active-class="transition-transform duration-200 ease-out"
        enter-from-class="translate-x-full"
        enter-to-class="translate-x-0"
        leave-active-class="transition-transform duration-150 ease-in"
        leave-from-class="translate-x-0"
        leave-to-class="translate-x-full"
      >
        <div
          v-if="selectedRowData || fkPreview || isAddMode"
          :class="[
            'absolute inset-y-0 right-0 bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-white/10 shadow-xl z-20 flex flex-col transition-[width] duration-200',
            isAddMode ? 'w-[480px]' : 'w-80'
          ]"
        >
          <!-- FK Preview Mode -->
          <template v-if="fkPreview">
            <!-- Purple left accent strip -->
            <div class="absolute left-0 top-0 bottom-0 w-1 bg-purple-500"></div>

            <!-- FK Header -->
            <div class="px-4 py-3 border-b border-purple-200 dark:border-purple-500/20 flex flex-col gap-2 bg-purple-50 dark:bg-purple-500/10 shrink-0">
              <div class="flex justify-between items-start">
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-6 h-6 rounded-md bg-purple-500/15 text-purple-500 flex items-center justify-center shrink-0">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                  <div class="min-w-0">
                    <span class="text-[9px] font-semibold uppercase tracking-wider text-purple-500 dark:text-purple-400">Relation</span>
                    <span class="text-xs font-bold text-gray-900 dark:text-white truncate block">{{ fkPreview.tableName }}</span>
                  </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    v-if="selectedRowData"
                    @click.stop="closeFkPreview"
                    class="p-1 text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 rounded hover:bg-purple-100 dark:hover:bg-purple-500/20 transition-colors"
                    :title="t('viewer.rowDetail')"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    @click.stop="fkPreview = null; if (!selectedRowData) closeDetail()"
                    class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition-colors"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <!-- FK filter badge -->
              <div class="flex items-center gap-1.5 px-2 py-1 bg-purple-100 dark:bg-purple-500/15 rounded-md">
                <span class="text-[10px] text-purple-600 dark:text-purple-300 font-mono truncate">{{ fkPreview.columnName }} = {{ fkPreview.value }}</span>
              </div>
            </div>

            <!-- FK Loading -->
            <div v-if="fkPreview.loading" class="flex-1 flex items-center justify-center bg-purple-50/30 dark:bg-purple-500/5">
              <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-500"></div>
            </div>

            <!-- FK Error -->
            <div v-else-if="fkPreview.error" class="flex-1 flex items-center justify-center p-4 bg-purple-50/30 dark:bg-purple-500/5">
              <p class="text-xs text-red-500 text-center">{{ fkPreview.error }}</p>
            </div>

            <!-- FK No Result -->
            <div v-else-if="!fkPreview.row" class="flex-1 flex items-center justify-center p-4 bg-purple-50/30 dark:bg-purple-500/5">
              <p class="text-xs text-gray-500 text-center">{{ t('viewer.noData') }}</p>
            </div>

            <!-- FK Fields -->
            <div v-else class="flex-1 overflow-y-auto p-3 space-y-2 bg-purple-50/30 dark:bg-purple-500/5">
              <div
                v-for="col in fkPreview.columns"
                :key="col.column_name"
                :class="[
                  'rounded-lg border p-2.5',
                  col.column_name === fkPreview.columnName
                    ? 'border-purple-300 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10'
                    : 'border-gray-100 dark:border-white/5 bg-white/80 dark:bg-surface/20'
                ]"
              >
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide truncate">{{ col.column_name }}</span>
                    <span v-if="col.is_primary" class="text-[9px]" title="PK">🔑</span>
                    <span v-if="col.is_foreign" class="text-[9px]" title="FK">🔗</span>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span class="text-[9px] text-gray-400 dark:text-gray-500 font-mono">{{ col.data_type }}</span>
                    <button
                      @click.stop="copyFieldValue(fkPreview.row[col.column_name], col.column_name)"
                      class="p-0.5 text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 rounded transition-colors"
                      :title="t('viewer.copied')"
                    >
                      <svg v-if="copiedField === col.column_name" class="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="text-xs font-mono break-all">
                  <span v-if="fkPreview.row[col.column_name] === null" class="text-gray-400 dark:text-gray-600 italic text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
                  <template v-else-if="(col.data_type === 'boolean' || col.udt_name === 'bool')">
                    <span :class="fkPreview.row[col.column_name] ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-[10px] font-semibold px-1.5 py-0.5 rounded" :style="fkPreview.row[col.column_name] ? 'background: rgb(34 197 94 / 0.1)' : 'background: rgb(239 68 68 / 0.1)'">{{ fkPreview.row[col.column_name] ? 'true' : 'false' }}</span>
                  </template>
                  <template v-else-if="col.is_foreign && fkPreview.row[col.column_name] !== null">
                    <span class="cursor-pointer text-purple-600 dark:text-purple-400 hover:text-purple-500 underline decoration-dotted underline-offset-2 transition-colors" @click.stop="navigateToFk(col, fkPreview.row[col.column_name])">{{ formatCellValue(fkPreview.row[col.column_name], col) }}</span>
                  </template>
                  <template v-else-if="(col.data_type === 'json' || col.data_type === 'jsonb') && fkPreview.row[col.column_name] !== null">
                    <pre class="text-[10px] text-purple-600 dark:text-purple-400 whitespace-pre-wrap max-h-40 overflow-y-auto bg-purple-50/50 dark:bg-purple-500/5 rounded p-1.5 mt-0.5">{{ formatCellValue(fkPreview.row[col.column_name], col) }}</pre>
                  </template>
                  <span v-else :class="getCellClass(fkPreview.row[col.column_name], col)" class="text-gray-900 dark:text-gray-200">{{ formatCellValue(fkPreview.row[col.column_name], col) }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- New Row Mode -->
          <template v-else-if="isAddMode">
            <!-- Green left accent strip -->
            <div class="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500"></div>

            <!-- Header -->
            <div class="px-4 py-3 border-b border-emerald-200 dark:border-emerald-500/20 flex items-center justify-between bg-emerald-50/50 dark:bg-emerald-500/10 shrink-0">
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-6 h-6 rounded-md bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <span class="text-xs font-bold text-gray-900 dark:text-white truncate">{{ t('viewer.newRow') }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <button @click="cancelAddRow" class="text-[10px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-1 rounded transition-colors">
                  {{ t('viewer.cancel') }}
                </button>
                <button
                  @click="saveNewRow"
                  :disabled="addSaving"
                  class="text-[10px] font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <svg v-if="addSaving" class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ t('viewer.addRow') }}
                </button>
              </div>
            </div>

            <!-- Fields -->
            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <div
                v-for="col in editableColumnsForAdd"
                :key="col.column_name"
                class="rounded-lg border p-2.5 border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-surface/20"
              >
                <!-- Field header -->
                <div class="flex items-center justify-between mb-1.5">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide truncate">{{ col.column_name }}</span>
                    <span v-if="col.is_foreign" class="text-[9px]" title="FK">🔗</span>
                    <span v-if="isFieldRequired(col)" class="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" title="Required"></span>
                  </div>
                  <span class="text-[9px] text-gray-400 dark:text-gray-500 font-mono">{{ col.data_type }}</span>
                </div>

                <!-- Field input -->
                <div class="text-xs font-mono">
                  <!-- FK: Combobox -->
                  <template v-if="col.is_foreign && col.foreign_key">
                    <Combobox v-model="addFormData[col.column_name]">
                      <div class="relative">
                        <div class="relative w-full">
                          <ComboboxInput
                            class="w-full text-[11px] font-mono bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md px-2 py-1.5 pr-8 text-gray-900 dark:text-gray-200 focus:ring-1 focus:ring-emerald-500 focus:border-transparent outline-none"
                            :displayValue="(val: any) => {
                              const option = fkOptions[col.column_name]?.find(o => o.value === val);
                              return option ? option.label : (val != null ? String(val) : '');
                            }"
                            @change="handleFkSearch(col.column_name, ($event.target as HTMLInputElement).value)"
                            :placeholder="`Select ${col.foreign_key.table}...`"
                          />
                          <ComboboxButton class="absolute inset-y-0 right-0 flex items-center pr-1.5">
                            <svg class="h-3.5 w-3.5 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                              <path d="M7 7l3-3 3 3m0 6l-3 3-3-3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                          </ComboboxButton>
                        </div>
                        <ComboboxOptions class="absolute mt-1 max-h-60 w-full overflow-auto rounded-md bg-white dark:bg-zinc-800 py-1 text-xs shadow-lg ring-1 ring-black/5 dark:ring-white/10 focus:outline-none z-50">
                          <div v-if="fkLoading[col.column_name]" class="py-2 px-3 text-gray-500 text-[10px]">Loading...</div>
                          <div v-else-if="!fkOptions[col.column_name]?.length" class="py-2 px-3 text-gray-500 text-[10px]">{{ t('viewer.noData') }}</div>
                          <ComboboxOption
                            v-for="option in fkOptions[col.column_name]"
                            :key="option.value"
                            :value="option.value"
                            v-slot="{ selected, active }"
                          >
                            <li
                              class="relative cursor-pointer select-none py-2 pl-7 pr-3"
                              :class="active ? 'bg-emerald-500 text-white' : 'text-gray-900 dark:text-gray-200'"
                            >
                              <span class="block truncate text-[11px]" :class="selected ? 'font-semibold' : ''">{{ option.label }}</span>
                              <div v-if="option.details.length" class="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                                <span
                                  v-for="detail in option.details"
                                  :key="detail.key"
                                  class="text-[9px] truncate max-w-[200px]"
                                  :class="active ? 'text-emerald-100' : 'text-gray-400 dark:text-gray-500'"
                                >
                                  <span class="font-medium" :class="active ? 'text-emerald-200' : 'text-gray-500 dark:text-gray-400'">{{ detail.key }}:</span> {{ detail.value }}
                                </span>
                              </div>
                              <span v-if="selected" class="absolute inset-y-0 left-0 flex items-center pl-1.5" :class="active ? 'text-white' : 'text-emerald-500'">
                                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                                </svg>
                              </span>
                            </li>
                          </ComboboxOption>
                        </ComboboxOptions>
                      </div>
                    </Combobox>
                    <button v-if="col.is_nullable === 'YES' && addFormData[col.column_name] != null" @click="addFormData[col.column_name] = null" class="mt-1 text-[9px] text-gray-400 hover:text-red-500 font-semibold transition-colors">NULL</button>
                  </template>

                  <!-- NULL value: show badge + "Set value" -->
                  <template v-else-if="addFormData[col.column_name] === null">
                    <div class="flex items-center gap-2">
                      <span class="text-gray-400 dark:text-gray-600 italic text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
                      <button
                        @click="addFormData[col.column_name] = getFieldInputType(col) === 'checkbox' ? false : ''"
                        class="text-[10px] text-emerald-500 hover:text-emerald-400 transition-colors font-medium"
                      >
                        {{ t('viewer.setValue') }}
                      </button>
                    </div>
                  </template>

                  <!-- Boolean: toggle -->
                  <template v-else-if="getFieldInputType(col) === 'checkbox'">
                    <div class="flex items-center gap-2">
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" :checked="!!addFormData[col.column_name]" @change="addFormData[col.column_name] = ($event.target as HTMLInputElement).checked" class="sr-only peer" />
                        <div class="w-8 h-[18px] bg-gray-200 dark:bg-white/10 rounded-full peer-checked:bg-green-500 transition-colors"></div>
                        <div class="absolute left-0.5 top-0.5 bg-white w-[14px] h-[14px] rounded-full transition-transform peer-checked:translate-x-3.5 shadow-sm"></div>
                      </label>
                      <span :class="addFormData[col.column_name] ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-[10px] font-semibold">
                        {{ addFormData[col.column_name] ? 'true' : 'false' }}
                      </span>
                      <button v-if="col.is_nullable === 'YES'" @click="addFormData[col.column_name] = null" class="text-[9px] text-gray-400 hover:text-red-500 font-semibold ml-auto transition-colors">NULL</button>
                    </div>
                  </template>

                  <!-- Textarea: JSON, text -->
                  <template v-else-if="getFieldInputType(col) === 'textarea'">
                    <div class="relative">
                      <textarea
                        :value="addFormData[col.column_name] ?? ''"
                        @input="addFormData[col.column_name] = ($event.target as HTMLTextAreaElement).value"
                        class="w-full text-[11px] font-mono bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md px-2 py-1.5 text-gray-900 dark:text-gray-200 focus:ring-1 focus:ring-emerald-500 focus:border-transparent outline-none resize-y min-h-[60px] max-h-[200px]"
                        rows="3"
                        :placeholder="`Enter ${col.column_name}`"
                      ></textarea>
                      <button v-if="col.is_nullable === 'YES'" @click="addFormData[col.column_name] = null" class="absolute top-1 right-1 text-[9px] text-gray-400 hover:text-red-500 px-1 py-0.5 rounded bg-gray-50 dark:bg-white/5 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors font-semibold" title="Set NULL">NULL</button>
                    </div>
                  </template>

                  <!-- Standard inputs: text, number, date, datetime-local, time -->
                  <template v-else>
                    <div class="flex items-center gap-1.5">
                      <input
                        :type="getFieldInputType(col)"
                        :value="addFormData[col.column_name] ?? ''"
                        @input="addFormData[col.column_name] = ($event.target as HTMLInputElement).value"
                        class="flex-1 text-[11px] font-mono bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md px-2 py-1.5 text-gray-900 dark:text-gray-200 focus:ring-1 focus:ring-emerald-500 focus:border-transparent outline-none"
                        :placeholder="col.column_default ? '' : `Enter ${col.column_name}`"
                      />
                      <button v-if="col.is_nullable === 'YES'" @click="addFormData[col.column_name] = null" class="p-1 text-gray-400 hover:text-red-500 rounded transition-colors shrink-0" title="Set NULL">
                        <span class="text-[9px] font-semibold">NULL</span>
                      </button>
                    </div>
                  </template>

                  <!-- Default hint -->
                  <p v-if="col.column_default" class="text-[9px] text-gray-400 dark:text-gray-500 mt-1">
                    Default: {{ col.column_default }}
                  </p>
                </div>
              </div>
            </div>
          </template>

          <!-- Row Detail Mode (editable) -->
          <template v-else-if="selectedRowData">
            <!-- Header -->
            <div class="px-4 py-3 border-b border-gray-200 dark:border-white/10 flex flex-col gap-2 bg-gray-50/50 dark:bg-surface/30 shrink-0">
              <div class="flex justify-between items-center">
                <div class="flex items-center gap-2 min-w-0">
                  <svg class="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <span class="text-xs font-bold text-gray-900 dark:text-white truncate">
                    {{ t('viewer.rowDetail') }}
                  </span>
                  <span class="text-[10px] text-gray-400 tabular-nums shrink-0">#{{ (selectedRowIndex ?? 0) + 1 }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    @click.stop="prevRow"
                    :disabled="selectedRowIndex === 0"
                    class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded disabled:opacity-30 transition-colors"
                    title="Previous row"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    @click.stop="nextRow"
                    :disabled="selectedRowIndex === rows.length - 1"
                    class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded disabled:opacity-30 transition-colors"
                    title="Next row"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <!-- Delete button -->
                  <button
                    @click.stop="deleteCurrentRow"
                    :disabled="!primaryKey"
                    class="p-1 text-gray-400 hover:text-red-500 rounded transition-colors disabled:opacity-30"
                    :title="t('viewer.deleteRow')"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                  <button
                    @click.stop="closeDetail"
                    class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition-colors ml-1"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <!-- Unsaved changes banner -->
              <div v-if="hasUnsavedChanges" class="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-lg">
                <span class="text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  {{ t('viewer.cellsModified', { count: slideoverChangesCount }) }}
                </span>
                <div class="flex items-center gap-1.5">
                  <button @click="discardSlideoverChanges" class="text-[10px] font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-0.5 rounded transition-colors">
                    {{ t('viewer.discard') }}
                  </button>
                  <button @click="saveSlideoverChanges" :disabled="slideoverSaving" class="text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-0.5 rounded transition-colors disabled:opacity-50 flex items-center gap-1">
                    <svg v-if="slideoverSaving" class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {{ t('viewer.saveChanges') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Editable Fields -->
            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <div
                v-for="col in columns"
                :key="col.column_name"
                :class="[
                  'rounded-lg border p-2.5',
                  (col.column_name in slideoverEdits)
                    ? 'border-amber-300 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5'
                    : 'border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-surface/20'
                ]"
              >
                <!-- Field header -->
                <div class="flex items-center justify-between mb-1.5">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide truncate">{{ col.column_name }}</span>
                    <span v-if="col.is_primary" class="text-[9px]" title="PK">🔑</span>
                    <span v-if="col.is_foreign" class="text-[9px]" title="FK">🔗</span>
                    <span v-if="col.column_name in slideoverEdits" class="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span class="text-[9px] text-gray-400 dark:text-gray-500 font-mono">{{ col.data_type }}</span>
                    <button
                      @click.stop="copyFieldValue(getFieldEditValue(col), col.column_name)"
                      class="p-0.5 text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400 rounded transition-colors"
                      :title="t('viewer.copied')"
                    >
                      <svg v-if="copiedField === col.column_name" class="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                      </svg>
                      <svg v-else class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                    <!-- FK link button -->
                    <button
                      v-if="col.is_foreign && getFieldEditValue(col) !== null"
                      @click.stop="navigateToFk(col, getFieldEditValue(col))"
                      class="p-0.5 text-blue-400 hover:text-blue-500 rounded transition-colors"
                      title="FK"
                    >
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </button>
                  </div>
                </div>

                <!-- Field value / input -->
                <div class="text-xs font-mono">
                  <!-- PK: read only -->
                  <template v-if="col.is_primary">
                    <span v-if="getFieldEditValue(col) === null" class="text-gray-400 dark:text-gray-600 italic text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
                    <span v-else class="text-gray-900 dark:text-gray-200">{{ formatCellValue(getFieldEditValue(col), col) }}</span>
                  </template>

                  <!-- NULL value -->
                  <template v-else-if="getFieldEditValue(col) === null">
                    <div class="flex items-center gap-2">
                      <span class="text-gray-400 dark:text-gray-600 italic text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
                      <button
                        @click="handleFieldChange(col, getFieldInputType(col) === 'checkbox' ? false : '')"
                        class="text-[10px] text-blue-500 hover:text-blue-400 transition-colors font-medium"
                      >
                        {{ t('viewer.setValue') }}
                      </button>
                    </div>
                  </template>

                  <!-- Boolean: toggle -->
                  <template v-else-if="getFieldInputType(col) === 'checkbox'">
                    <div class="flex items-center gap-2">
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" :checked="!!getFieldEditValue(col)" @change="handleFieldChange(col, ($event.target as HTMLInputElement).checked)" class="sr-only peer" />
                        <div class="w-8 h-[18px] bg-gray-200 dark:bg-white/10 rounded-full peer-checked:bg-green-500 transition-colors"></div>
                        <div class="absolute left-0.5 top-0.5 bg-white w-[14px] h-[14px] rounded-full transition-transform peer-checked:translate-x-3.5 shadow-sm"></div>
                      </label>
                      <span :class="getFieldEditValue(col) ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-[10px] font-semibold">
                        {{ getFieldEditValue(col) ? 'true' : 'false' }}
                      </span>
                      <button v-if="col.is_nullable === 'YES'" @click="handleFieldChange(col, null)" class="text-[9px] text-gray-400 hover:text-red-500 font-semibold ml-auto transition-colors">NULL</button>
                    </div>
                  </template>

                  <!-- Textarea: JSON, text -->
                  <template v-else-if="getFieldInputType(col) === 'textarea'">
                    <div class="relative">
                      <textarea
                        :value="formatForInput(getFieldEditValue(col), col)"
                        @input="handleFieldChange(col, ($event.target as HTMLTextAreaElement).value)"
                        class="w-full text-[11px] font-mono bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md px-2 py-1.5 text-gray-900 dark:text-gray-200 focus:ring-1 focus:ring-blue-500 focus:border-transparent outline-none resize-y min-h-[60px] max-h-[200px]"
                        rows="3"
                      ></textarea>
                      <button v-if="col.is_nullable === 'YES'" @click="handleFieldChange(col, null)" class="absolute top-1 right-1 text-[9px] text-gray-400 hover:text-red-500 px-1 py-0.5 rounded bg-gray-50 dark:bg-white/5 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors font-semibold" title="Set NULL">NULL</button>
                    </div>
                  </template>

                  <!-- Standard inputs: text, number, date, datetime-local, time -->
                  <template v-else>
                    <div class="flex items-center gap-1.5">
                      <input
                        :type="getFieldInputType(col)"
                        :value="formatForInput(getFieldEditValue(col), col)"
                        @input="handleFieldChange(col, ($event.target as HTMLInputElement).value)"
                        class="flex-1 text-[11px] font-mono bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-md px-2 py-1.5 text-gray-900 dark:text-gray-200 focus:ring-1 focus:ring-blue-500 focus:border-transparent outline-none"
                      />
                      <button v-if="col.is_nullable === 'YES'" @click="handleFieldChange(col, null)" class="p-1 text-gray-400 hover:text-red-500 rounded transition-colors shrink-0" title="Set NULL">
                        <span class="text-[9px] font-semibold">NULL</span>
                      </button>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

  </div>
</template>

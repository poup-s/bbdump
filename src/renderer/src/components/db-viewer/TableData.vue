<script setup lang="ts">
import { ref, watch, onMounted, computed, onBeforeUnmount } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { ipcRenderer } from '../../electron';
import { Database, buildDbConfig } from '../../types';
import AddRowModal from './AddRowModal.vue';
import { useDebounceFn } from '@vueuse/core';

const props = defineProps<{
  db: Database | null;
  table: string | null;
}>();

const emit = defineEmits(['navigateToTable']);

const { t } = useI18n();
const { addToast } = useToast();
const { showConfirm } = useConfirm();

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

// Edit mode state
const editMode = ref(false);
const editedCells = ref<Map<string, any>>(new Map());
const saving = ref(false);
const showAddModal = ref(false);

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

const selectRow = (index: number) => {
  if (editMode.value) return;
  fkPreview.value = null;
  selectedRowIndex.value = selectedRowIndex.value === index ? null : index;
};

const closeDetail = () => {
  selectedRowIndex.value = null;
  fkPreview.value = null;
};

const closeFkPreview = () => {
  fkPreview.value = null;
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
      selectedRowIndex.value++;
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (selectedRowIndex.value > 0) {
      selectedRowIndex.value--;
    }
  }
};

const changesCount = computed(() => editedCells.value.size);
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
  } catch (err: any) {
    console.error('Error loading data:', err);
    error.value = err.message;
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

const deleteRow = (row: any) => {
  if (!primaryKey.value) {
    addToast(t('viewer.noPrimaryKey'), 'error');
    return;
  }

  const pkValue = row[primaryKey.value];
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
        loadData();
      } catch (err: any) {
        addToast(t('viewer.deleteErrorDetail', { error: err.message }), 'error');
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

// Edit mode functions
const toggleEditMode = () => {
  if (editMode.value && editedCells.value.size > 0) {
    showConfirm({
      title: t('viewer.exitEditMode'),
      message: t('viewer.exitEditConfirm'),
      type: 'warning',
      onConfirm: () => {
        editMode.value = false;
        editedCells.value.clear();
      }
    });
  } else {
    editMode.value = !editMode.value;
    if (!editMode.value) {
      editedCells.value.clear();
    }
  }
};

const handleCellEdit = (rowIndex: number, columnName: string, event: Event) => {
  const target = event.target as HTMLElement;
  const newValue = target.textContent || '';
  const oldValue = rows.value[rowIndex][columnName];

  if (newValue !== String(oldValue)) {
    const key = `${rowIndex}:${columnName}`;
    editedCells.value.set(key, newValue);
  }
};

const saveChanges = async () => {
  if (editedCells.value.size === 0) return;

  showConfirm({
    title: t('viewer.saveChanges'),
    message: t('viewer.confirmSave', { count: editedCells.value.size }),
    confirmText: t('viewer.saveChanges'),
    type: 'warning',
    onConfirm: async () => {
      saving.value = true;
      try {
        const changes = Array.from(editedCells.value.entries()).map(([key, newValue]) => {
          const [rowIndex, columnName] = key.split(':');
          const row = rows.value[parseInt(rowIndex)];
          return {
            rowId: row[primaryKey.value!],
            primaryKeyColumn: primaryKey.value!,
            column: columnName,
            oldValue: row[columnName],
            newValue: newValue
          };
        });

        await ipcRenderer.invoke('update-table-data', {
          db: buildDbConfig(props.db!),
          table: props.table,
          changes
        });

        addToast(t('viewer.saveSuccess', { count: changes.length }), 'success');
        editMode.value = false;
        editedCells.value.clear();
        loadData();
      } catch (err: any) {
        console.error('Error saving changes:', err);
        addToast(t('viewer.saveErrorDetail', { error: err.message }), 'error');
      } finally {
        saving.value = false;
      }
    }
  });
};

const cancelEdit = () => {
  if (editedCells.value.size > 0) {
    showConfirm({
      title: t('viewer.exitEditMode'),
      message: t('viewer.exitEditConfirm'),
      type: 'warning',
      onConfirm: () => {
        editMode.value = false;
        editedCells.value.clear();
        loadData();
      }
    });
  } else {
    editMode.value = false;
  }
};

const handleRowAdded = () => {
  loadData();
};

// D: Copy cell value to clipboard
const copyCell = async (value: any, rowIndex: number, colName: string) => {
  if (editMode.value) return;
  const text = value === null ? '' : String(value);
  try {
    await navigator.clipboard.writeText(text);
    copiedCell.value = `${rowIndex}:${colName}`;
    setTimeout(() => { copiedCell.value = null; }, 1200);
  } catch {
    // Fallback for non-secure contexts
  }
};

// F: Export CSV
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

// G: Open FK relation preview in slide-over
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
  } catch (err: any) {
    if (fkPreview.value) {
      fkPreview.value.error = err.message;
      fkPreview.value.loading = false;
    }
  }
};

// H: Cell display formatting
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

// I: Column resize
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
  editMode.value = false;
  editedCells.value.clear();
  columnWidths.value.clear();
  selectedRowIndex.value = null;
  fkPreview.value = null;
  loadData();
});

onMounted(() => {
  loadData();
  document.addEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Toolbar -->
    <div class="mb-1 flex justify-between items-center gap-2 px-1">
      <div class="flex items-center gap-1">
        <button
          @click="loadData"
          :disabled="loading || saving"
          class="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50"
          :title="t('viewer.refresh')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <div class="h-4 w-px bg-white/10"></div>

        <!-- Search Input -->
        <div class="relative w-44">
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

        <!-- Edit Mode Toggle -->
        <button
          v-if="!editMode"
          @click="toggleEditMode"
          :disabled="!primaryKey"
          class="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :title="!primaryKey ? t('viewer.noPkEditing') : t('viewer.editMode')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>

        <!-- Edit Mode Active Controls -->
        <template v-else>
          <button
            @click="saveChanges"
            :disabled="changesCount === 0 || saving"
            class="px-2 py-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 rounded-md transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            :title="t('viewer.saveChanges')"
          >
            <svg v-if="saving" class="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span v-if="changesCount > 0" class="px-1 py-px bg-green-500 text-white text-[10px] rounded-full leading-none">{{ changesCount }}</span>
          </button>

          <button
            @click="cancelEdit"
            :disabled="saving"
            class="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50"
            :title="t('viewer.cancel')"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </template>

        <!-- Add Row Button -->
        <button
          v-if="!editMode"
          @click="showAddModal = true"
          :disabled="!primaryKey"
          class="p-1.5 text-blue-500 hover:text-blue-400 rounded-md hover:bg-blue-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :title="!primaryKey ? t('viewer.noPkAdding') : t('viewer.addRow')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>

        <!-- Export CSV Button -->
        <button
          v-if="!editMode"
          @click="exportCSV"
          :disabled="rows.length === 0"
          class="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
            <th class="px-3 py-2 text-right text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider sticky right-0 bg-gray-50/80 dark:bg-surface/50 shadow-l backdrop-blur-md">
              {{ t('viewer.actions') }}
            </th>
          </tr>
        </thead>
        <tbody class="bg-transparent divide-y divide-gray-200 dark:divide-white/5">
          <tr
            v-for="(row, i) in rows"
            :key="i"
            @click="!editMode ? selectRow(i) : null"
            :class="[
              'transition-colors',
              selectedRowIndex === i
                ? 'bg-blue-500/10 dark:bg-blue-500/15'
                : 'hover:bg-black/5 dark:hover:bg-white/5',
              !editMode ? 'cursor-pointer' : ''
            ]"
          >
            <td
              v-for="col in columns"
              :key="col.column_name"
              :style="getColStyle(col.column_name)"
              :contenteditable="editMode && !col.is_primary"
              @blur="editMode ? handleCellEdit(i, col.column_name, $event) : null"
              :class="[
                'px-3 py-2 text-xs text-gray-900 dark:text-gray-300 overflow-hidden text-ellipsis font-mono',
                editMode && !col.is_primary ? 'cursor-text hover:ring-2 hover:ring-blue-500 hover:ring-inset rounded bg-white dark:bg-white/5 whitespace-pre-wrap' : 'whitespace-nowrap',
                editedCells.has(`${i}:${col.column_name}`) ? 'ring-2 ring-blue-500 ring-inset bg-blue-50 dark:bg-blue-500/10' : '',
                getCellClass(row[col.column_name], col),
                col.is_foreign && row[col.column_name] !== null ? 'underline decoration-blue-400/50 decoration-dotted underline-offset-4 hover:decoration-blue-500' : ''
              ]"
              :title="String(row[col.column_name])"
            >
              <!-- NULL -->
              <span v-if="row[col.column_name] === null" class="text-gray-400 dark:text-gray-600 italic text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
              <!-- Boolean -->
              <template v-else-if="(col.data_type === 'boolean' || col.udt_name === 'bool') && !editMode">
                <span :class="row[col.column_name] ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-xs font-semibold px-1.5 py-0.5 rounded" :style="row[col.column_name] ? 'background: rgb(34 197 94 / 0.1)' : 'background: rgb(239 68 68 / 0.1)'">{{ row[col.column_name] ? 'true' : 'false' }}</span>
              </template>
              <!-- FK link -->
              <template v-else-if="col.is_foreign && !editMode">
                <span class="cursor-pointer hover:text-blue-500 dark:hover:text-blue-400 transition-colors" @click.stop="navigateToFk(col, row[col.column_name])">{{ formatCellValue(row[col.column_name], col) }}</span>
              </template>
              <!-- Default -->
              <template v-else>{{ formatCellValue(row[col.column_name], col) }}</template>
            </td>
            <td class="px-3 py-2 whitespace-nowrap text-right text-xs font-medium sticky right-0 bg-white/50 dark:bg-surface/30 shadow-l transition-colors">
              <button
                v-if="!editMode"
                @click.stop="deleteRow(row)"
                class="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-white dark:bg-transparent border border-gray-200 dark:border-transparent shadow-sm dark:shadow-none"
                :disabled="!primaryKey"
                :title="!primaryKey ? t('viewer.noPrimaryKey') : t('viewer.delete')"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
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
          v-if="selectedRowData || fkPreview"
          class="absolute inset-y-0 right-0 w-80 bg-white dark:bg-zinc-900 border-l border-gray-200 dark:border-white/10 shadow-xl z-20 flex flex-col"
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

          <!-- Row Detail Mode -->
          <template v-else-if="selectedRowData">
            <!-- Header -->
            <div class="px-4 py-3 border-b border-gray-200 dark:border-white/10 flex justify-between items-center bg-gray-50/50 dark:bg-surface/30 shrink-0">
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
                  @click.stop="selectedRowIndex !== null && selectedRowIndex > 0 ? selectedRowIndex-- : null"
                  :disabled="selectedRowIndex === 0"
                  class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded disabled:opacity-30 transition-colors"
                  title="Previous row"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  @click.stop="selectedRowIndex !== null && selectedRowIndex < rows.length - 1 ? selectedRowIndex++ : null"
                  :disabled="selectedRowIndex === rows.length - 1"
                  class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded disabled:opacity-30 transition-colors"
                  title="Next row"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
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

            <!-- Fields -->
            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <div
                v-for="col in columns"
                :key="col.column_name"
                class="rounded-lg border border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-surface/20 p-2.5"
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
                      @click.stop="copyFieldValue(selectedRowData[col.column_name], col.column_name)"
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
                  <span v-if="selectedRowData[col.column_name] === null" class="text-gray-400 dark:text-gray-600 italic text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-white/5 rounded">NULL</span>
                  <template v-else-if="(col.data_type === 'boolean' || col.udt_name === 'bool')">
                    <span :class="selectedRowData[col.column_name] ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'" class="text-[10px] font-semibold px-1.5 py-0.5 rounded" :style="selectedRowData[col.column_name] ? 'background: rgb(34 197 94 / 0.1)' : 'background: rgb(239 68 68 / 0.1)'">{{ selectedRowData[col.column_name] ? 'true' : 'false' }}</span>
                  </template>
                  <template v-else-if="col.is_foreign && selectedRowData[col.column_name] !== null">
                    <span class="cursor-pointer text-blue-600 dark:text-blue-400 hover:text-blue-500 underline decoration-dotted underline-offset-2 transition-colors" @click.stop="navigateToFk(col, selectedRowData[col.column_name])">{{ formatCellValue(selectedRowData[col.column_name], col) }}</span>
                  </template>
                  <template v-else-if="(col.data_type === 'json' || col.data_type === 'jsonb') && selectedRowData[col.column_name] !== null">
                    <pre class="text-[10px] text-purple-600 dark:text-purple-400 whitespace-pre-wrap max-h-40 overflow-y-auto bg-purple-50/50 dark:bg-purple-500/5 rounded p-1.5 mt-0.5">{{ formatCellValue(selectedRowData[col.column_name], col) }}</pre>
                  </template>
                  <span v-else :class="getCellClass(selectedRowData[col.column_name], col)" class="text-gray-900 dark:text-gray-200">{{ formatCellValue(selectedRowData[col.column_name], col) }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <!-- Add Row Modal -->
    <AddRowModal
      :show="showAddModal"
      :db="db"
      :table="table"
      @close="showAddModal = false"
      @added="handleRowAdded"
    />
  </div>
</template>

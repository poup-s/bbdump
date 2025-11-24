<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { useConfirm } from '../../composables/useConfirm';
import { ipcRenderer } from '../../electron';
import { Database } from '../../types';
import AddRowModal from './AddRowModal.vue';

const props = defineProps<{
  db: Database | null;
  table: string | null;
}>();

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

// Edit mode state
const editMode = ref(false);
const editedCells = ref<Map<string, any>>(new Map());
const saving = ref(false);
const showAddModal = ref(false);

const changesCount = computed(() => editedCells.value.size);

const loadData = async () => {
  if (!props.db || !props.table) return;
  
  loading.value = true;
  error.value = null;
  
  try {
    // Create plain DB config to avoid cloning errors
    const dbConfig = {
      name: props.db.name,
      host: props.db.host,
      port: props.db.port,
      user: props.db.user,
      password: props.db.password,
      connectionString: props.db.connectionString
    };
    
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
      pageSize: pageSize.value
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

const deleteRow = (row: any) => {
  if (!primaryKey.value) {
    addToast('Cannot delete row: No primary key defined', 'error');
    return;
  }

  const pkValue = row[primaryKey.value];
  
  showConfirm({
    title: t('viewer.deleteRowTitle'),
    message: t('viewer.deleteRowConfirm'),
    confirmText: t('viewer.delete'),
    type: 'danger',
    onConfirm: async () => {
      if (!props.db) return;
      
      try {
        const dbConfig = {
          name: props.db.name,
          host: props.db.host,
          port: props.db.port,
          user: props.db.user,
          password: props.db.password,
          connectionString: props.db.connectionString
        };
        
        await ipcRenderer.invoke('delete-table-row', {
          db: dbConfig,
          table: props.table,
          pkColumn: primaryKey.value,
          rowId: pkValue
        });
        addToast(t('viewer.rowDeleted'), 'success');
        loadData();
      } catch (err: any) {
        addToast('Error deleting row: ' + err.message, 'error');
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
        const dbConfig = {
          name: props.db!.name,
          host: props.db!.host,
          port: props.db!.port,
          user: props.db!.user,
          password: props.db!.password,
          connectionString: props.db!.connectionString
        };
        
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
          db: dbConfig,
          table: props.table,
          changes
        });
        
        addToast(t('viewer.saveSuccess', { count: changes.length }), 'success');
        editMode.value = false;
        editedCells.value.clear();
        loadData();
      } catch (err: any) {
        console.error('Error saving changes:', err);
        addToast('Error saving changes: ' + err.message, 'error');
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

watch(() => props.table, () => {
  page.value = 1;
  editMode.value = false;
  editedCells.value.clear();
  loadData();
});

onMounted(() => {
  loadData();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Toolbar -->
    <div class="mb-4 flex justify-between items-center">
      <div class="flex items-center gap-3">
        <button
          @click="loadData"
          :disabled="loading || saving"
          class="p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
          :title="t('viewer.refresh')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        
        <div class="h-6 w-px bg-gray-200 dark:bg-zinc-700"></div>
        
        <!-- Edit Mode Toggle -->
        <button
          v-if="!editMode"
          @click="toggleEditMode"
          :disabled="!primaryKey"
          class="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          :title="!primaryKey ? 'No primary key - editing disabled' : ''"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {{ t('viewer.editMode') }}
        </button>
        
        <!-- Edit Mode Active Controls -->
        <template v-else>
          <button
            @click="saveChanges"
            :disabled="changesCount === 0 || saving"
            class="px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors shadow-lg shadow-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <svg v-if="saving" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ t('viewer.saveChanges') }}
            <span v-if="changesCount > 0" class="px-1.5 py-0.5 bg-green-500 text-white text-xs rounded-full">{{ changesCount }}</span>
          </button>
          
          <button
            @click="cancelEdit"
            :disabled="saving"
            class="px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {{ t('viewer.cancel') }}
          </button>
        </template>
        
        <!-- Add Row Button -->
        <button
          v-if="!editMode"
          @click="showAddModal = true"
          :disabled="!primaryKey"
          class="px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          :title="!primaryKey ? 'No primary key - adding disabled' : ''"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          {{ t('viewer.addRow') }}
        </button>
        
        <div class="h-6 w-px bg-gray-200 dark:bg-zinc-700"></div>
        
        <span class="text-sm text-gray-500 dark:text-gray-400 font-medium">
          {{ t('viewer.showing', { start: (page - 1) * pageSize + 1, end: Math.min(page * pageSize, totalRows), total: totalRows }) }}
        </span>
      </div>
      
      <!-- Pagination -->
      <div class="flex items-center gap-2">
        <button
          @click="prevPage"
          :disabled="page === 1 || loading"
          class="p-2 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 transition-colors"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[2rem] text-center">{{ page }}</span>
        <button
          @click="nextPage"
          :disabled="page * pageSize >= totalRows || loading"
          class="p-2 border border-gray-200 dark:border-zinc-700 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 dark:text-gray-300 transition-colors"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="flex-1 overflow-auto border border-gray-200 dark:border-zinc-700 rounded-xl relative bg-white dark:bg-zinc-900 shadow-inner">
      <div v-if="loading" class="absolute inset-0 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm flex items-center justify-center z-10">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>

      <div v-if="error" class="p-8 text-center text-red-600 dark:text-red-400">
        {{ error }}
      </div>

      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-zinc-800">
        <thead class="bg-gray-50 dark:bg-zinc-800/50 sticky top-0 z-0 backdrop-blur-md">
          <tr>
            <th
              v-for="col in columns"
              :key="col.column_name"
              class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap"
            >
              <div class="flex items-center gap-1.5">
                {{ col.column_name }}
                <span v-if="col.is_primary" class="text-yellow-500 text-[10px]" title="Primary Key">🔑</span>
              </div>
              <div class="text-[10px] text-gray-400 dark:text-gray-500 font-normal lowercase mt-0.5">{{ col.data_type }}</div>
            </th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider sticky right-0 bg-gray-50 dark:bg-zinc-800 shadow-l backdrop-blur-md">
              {{ t('viewer.actions') }}
            </th>
          </tr>
        </thead>
        <tbody class="bg-white dark:bg-zinc-900 divide-y divide-gray-200 dark:divide-zinc-800">
          <tr v-for="(row, i) in rows" :key="i" class="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
            <td
              v-for="col in columns"
              :key="col.column_name"
              :contenteditable="editMode && !col.is_primary"
              @blur="editMode ? handleCellEdit(i, col.column_name, $event) : null"
              :class="[
                'px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-200 max-w-xs overflow-hidden text-ellipsis font-mono',
                editMode && !col.is_primary ? 'cursor-text hover:ring-2 hover:ring-blue-500 hover:ring-inset rounded' : '',
                editedCells.has(`${i}:${col.column_name}`) ? 'ring-2 ring-blue-500 ring-inset bg-blue-50 dark:bg-blue-900/20' : ''
              ]"
              :title="String(row[col.column_name])"
            >
              <span v-if="row[col.column_name] === null" class="text-gray-400 italic text-xs">NULL</span>
              <template v-else>{{ String(row[col.column_name]) }}</template>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium sticky right-0 bg-white dark:bg-zinc-900 shadow-l group-hover:bg-gray-50 dark:group-hover:bg-zinc-800/50 transition-colors">
              <button
                v-if="!editMode"
                @click="deleteRow(row)"
                class="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300 p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="!primaryKey"
                :title="!primaryKey ? 'No Primary Key' : t('viewer.delete')"
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
        <div class="w-12 h-12 bg-gray-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-3">
          <svg class="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        </div>
        <p class="text-gray-500 dark:text-gray-400">{{ t('viewer.noData') }}</p>
      </div>
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

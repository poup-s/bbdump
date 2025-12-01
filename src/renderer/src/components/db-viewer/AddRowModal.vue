<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { useToast } from '../../composables/useToast';
import { ipcRenderer } from '../../electron';
import { Database } from '../../types';
import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption, ComboboxButton } from '@headlessui/vue';

const props = defineProps<{
  db: Database | null;
  table: string | null;
  show: boolean;
}>();

const emit = defineEmits(['close', 'added']);

const { t } = useI18n();
const { addToast } = useToast();

const columns = ref<any[]>([]);
const formData = ref<Record<string, any>>({});
const loading = ref(false);
const submitting = ref(false);
const fkOptions = ref<Record<string, any[]>>({});
const fkLoading = ref<Record<string, boolean>>({});
const fkSearch = ref<Record<string, string>>({});

const loadSchema = async () => {
  if (!props.db || !props.table) return;
  
  loading.value = true;
  try {
    const dbConfig = {
      name: props.db.name,
      host: props.db.host,
      port: props.db.port,
      user: props.db.user,
      password: props.db.password,
      connectionString: props.db.connectionString
    };
    
    const result = await ipcRenderer.invoke('get-table-schema', {
      db: dbConfig,
      table: props.table
    });
    
    columns.value = result.columns;
    
    // Initialize form data with defaults
    formData.value = {};
    const now = new Date().toISOString(); // Current timestamp

    columns.value.forEach(col => {
      // Default Timestamps
      if (['created_at', 'updated_at', 'timestamp'].includes(col.column_name) && 
          (col.data_type.includes('timestamp') || col.data_type.includes('date'))) {
        // Format for datetime-local input: YYYY-MM-DDThh:mm
        formData.value[col.column_name] = now.slice(0, 16);
      } else if (col.column_default) {
        formData.value[col.column_name] = null; // Let DB handle defaults
      } else if (col.is_nullable === 'NO' && !col.is_primary) {
        formData.value[col.column_name] = '';
      }

      // Load FK options if applicable
      if (col.is_foreign && col.foreign_key) {
        loadFkOptions(col.column_name, col.foreign_key.table, col.foreign_key.column);
      }
    });
  } catch (err: any) {
    console.error('Error loading schema:', err);
    addToast('Error loading schema: ' + err.message, 'error');
  } finally {
    loading.value = false;
  }
};

const loadFkOptions = async (columnName: string, foreignTable: string, foreignColumn: string, search = '') => {
  if (!props.db) return;
  
  fkLoading.value[columnName] = true;
  try {
    const dbConfig = {
      name: props.db.name,
      host: props.db.host,
      port: props.db.port,
      user: props.db.user,
      password: props.db.password,
      connectionString: props.db.connectionString
    };

    // Fetch data from the referenced table
    // We'll fetch the ID column and maybe a descriptive column if we can guess one
    const result = await ipcRenderer.invoke('get-table-data', {
      db: dbConfig,
      table: foreignTable,
      limit: 50,
      search: search,
      sortBy: foreignColumn, // Sort by the ID usually
      sortOrder: 'asc'
    });

    fkOptions.value[columnName] = result.rows.map((row: any) => ({
      value: row[foreignColumn],
      label: formatFkLabel(row, foreignColumn)
    }));
  } catch (err) {
    console.error(`Error loading FK options for ${columnName}:`, err);
  } finally {
    fkLoading.value[columnName] = false;
  }
};

const formatFkLabel = (row: any, idColumn: string) => {
  // Try to find a descriptive column (name, title, email, etc.)
  const descriptiveKeys = ['name', 'title', 'email', 'username', 'label', 'description', 'slug'];
  const foundKey = descriptiveKeys.find(key => Object.prototype.hasOwnProperty.call(row, key));
  
  if (foundKey) {
    return `${row[foundKey]} (${row[idColumn]})`;
  }
  return String(row[idColumn]);
};

const handleFkSearch = (columnName: string, query: string) => {
  fkSearch.value[columnName] = query;
  const col = columns.value.find(c => c.column_name === columnName);
  if (col && col.foreign_key) {
    // Debounce this in a real app, but for now direct call is okay or use existing debounce
    loadFkOptions(columnName, col.foreign_key.table, col.foreign_key.column, query);
  }
};

const requiredColumns = computed(() => {
  return columns.value.filter(col => 
    col.is_nullable === 'NO' && 
    !col.is_primary && 
    !col.column_default
  );
});

const editableColumns = computed(() => {
  return columns.value.filter(col => !col.is_primary);
});

const handleSubmit = async () => {
  // Validate required fields
  const missingFields = requiredColumns.value.filter(col => 
    !formData.value[col.column_name] || 
    formData.value[col.column_name] === ''
  );
  
  if (missingFields.length > 0) {
    addToast(`Required fields missing: ${missingFields.map(f => f.column_name).join(', ')}`, 'error');
    return;
  }
  
  submitting.value = true;
  try {
    const dbConfig = {
      name: props.db!.name,
      host: props.db!.host,
      port: props.db!.port,
      user: props.db!.user,
      password: props.db!.password,
      connectionString: props.db!.connectionString
    };
    
    await ipcRenderer.invoke('insert-table-row', {
      db: dbConfig,
      table: props.table,
      rowData: formData.value
    });
    
    addToast(t('viewer.addRowSuccess'), 'success');
    emit('added');
    emit('close');
  } catch (err: any) {
    console.error('Error adding row:', err);
    addToast('Error adding row: ' + err.message, 'error');
  } finally {
    submitting.value = false;
  }
};

const getInputType = (dataType: string) => {
  if (dataType.includes('int') || dataType.includes('serial')) return 'number';
  if (dataType.includes('bool')) return 'checkbox';
  if (dataType.includes('date') || dataType.includes('timestamp')) return 'datetime-local';
  return 'text';
};

// Watch for modal opening and load schema
watch(() => props.show, (newVal) => {
  if (newVal) {
    loadSchema();
  } else {
    // Reset form when closing
    columns.value = [];
    formData.value = {};
    fkOptions.value = {};
    fkSearch.value = {};
  }
});
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
    <div class="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden border border-white/10 ring-1 ring-black/5">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-gray-200 dark:border-zinc-800 flex justify-between items-center bg-gray-50/50 dark:bg-zinc-900/50 backdrop-blur-xl">
        <div>
          <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ t('viewer.addRowTitle') }}</h3>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{{ table }}</p>
        </div>
        <button 
          @click="emit('close')" 
          class="p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all duration-200"
        >
          <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-6">
        <div v-if="loading" class="flex items-center justify-center py-12">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
        </div>

        <div v-else class="space-y-4">
          <div v-for="col in editableColumns" :key="col.column_name" class="space-y-1.5">
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {{ col.column_name }}
              <span v-if="col.is_nullable === 'NO' && !col.column_default" class="text-red-500">*</span>
              <span class="text-xs text-gray-400 dark:text-gray-500 font-normal ml-2">{{ col.data_type }}</span>
            </label>
            
            <!-- Foreign Key Selection -->
            <div v-if="col.is_foreign" class="relative">
               <Combobox v-model="formData[col.column_name]">
                <div class="relative mt-1">
                  <div class="relative w-full cursor-default overflow-hidden rounded-lg bg-white dark:bg-zinc-800 text-left border border-gray-200 dark:border-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-75 focus-visible:ring-offset-2 focus-visible:ring-offset-teal-300 sm:text-sm">
                    <ComboboxInput
                      class="w-full border-none py-2 pl-3 pr-10 text-sm leading-5 text-gray-900 dark:text-white bg-transparent focus:ring-0 outline-none"
                      :displayValue="(val: any) => {
                        const option = fkOptions[col.column_name]?.find(o => o.value === val);
                        return option ? option.label : val;
                      }"
                      @change="handleFkSearch(col.column_name, $event.target.value)"
                      :placeholder="`Select ${col.foreign_key?.table}...`"
                    />
                    <ComboboxButton class="absolute inset-y-0 right-0 flex items-center pr-2">
                      <svg class="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                        <path d="M7 7l3-3 3 3m0 6l-3 3-3-3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </ComboboxButton>
                  </div>
                  <ComboboxOptions class="absolute mt-1 max-h-60 w-full overflow-auto rounded-md bg-white dark:bg-zinc-800 py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm z-50">
                    <div v-if="fkLoading[col.column_name]" class="relative cursor-default select-none py-2 px-4 text-gray-700 dark:text-gray-300">
                      Loading...
                    </div>
                    <div v-else-if="!fkOptions[col.column_name]?.length" class="relative cursor-default select-none py-2 px-4 text-gray-700 dark:text-gray-300">
                      No results found.
                    </div>
                    <ComboboxOption
                      v-for="option in fkOptions[col.column_name]"
                      :key="option.value"
                      :value="option.value"
                      v-slot="{ selected, active }"
                    >
                      <li
                        class="relative cursor-default select-none py-2 pl-10 pr-4"
                        :class="{
                          'bg-blue-600 text-white': active,
                          'text-gray-900 dark:text-white': !active,
                        }"
                      >
                        <span
                          class="block truncate"
                          :class="{ 'font-medium': selected, 'font-normal': !selected }"
                        >
                          {{ option.label }}
                        </span>
                        <span
                          v-if="selected"
                          class="absolute inset-y-0 left-0 flex items-center pl-3"
                          :class="{ 'text-white': active, 'text-blue-600': !active }"
                        >
                          <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                          </svg>
                        </span>
                      </li>
                    </ComboboxOption>
                  </ComboboxOptions>
                </div>
              </Combobox>
            </div>

            <!-- Standard Input -->
            <input
              v-else-if="getInputType(col.data_type) !== 'checkbox'"
              v-model="formData[col.column_name]"
              :type="getInputType(col.data_type)"
              :placeholder="col.column_default || `Enter ${col.column_name}`"
              :required="col.is_nullable === 'NO' && !col.column_default"
              class="w-full px-3 py-2 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 text-gray-900 dark:text-white"
            />
            
            <div v-else class="flex items-center">
              <input
                v-model="formData[col.column_name]"
                type="checkbox"
                class="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
              />
              <label class="ml-2 text-sm text-gray-600 dark:text-gray-400">{{ col.column_name }}</label>
            </div>
            
            <p v-if="col.column_default" class="text-xs text-gray-500 dark:text-gray-400">
              Default: {{ col.column_default }}
            </p>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-200 dark:border-zinc-800 flex justify-end gap-3 bg-gray-50/50 dark:bg-zinc-900/50">
        <button
          @click="emit('close')"
          :disabled="submitting"
          class="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {{ t('viewer.cancel') }}
        </button>
        <button
          @click="handleSubmit"
          :disabled="submitting || loading"
          class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <svg v-if="submitting" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {{ t('viewer.addRow') }}
        </button>
      </div>
    </div>
  </div>
</template>
